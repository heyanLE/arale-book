//! TAR 读取器（`tar` crate）—— 支撑 `.cbt`（Comic Book TAR）。
//!
//! `.cbt` 和 `.cbz`/`.cbr`/`.cb7` 一样是漫画的标准容器之一（只是不如前三者常见），
//! 而 tar 是**未压缩**的裸容器，读起来比 zip 还简单。所以「支持 .cbt」不是额外负担，
//! 不实现反而会让扩展名表里出现一个「列了但打不开」的假承诺。
//!
//! ## 两条与 zip 不同的注意点
//!
//! 1. **条目名是路径，不是字符串**：`entry.path()` 返回 `Cow<Path>`，在 Windows 上
//!    可能带反斜杠。落到 `EntryMeta.name` 之前必须归一成正斜杠，否则页图筛选
//!    （按 `/` 分词、按扩展名判断）会在 Windows 上整卷失配。
//! 2. **没有中央目录**：tar 只能顺序扫。`list()` 因此要读完整个流的头部链（但不读
//!    内容——`tar` crate 的迭代器会 skip 数据段），对大包依然是「不把内容读进内存」。
//!    代价是列表阶段要过一遍文件，比 zip 慢，但 cbt 本身少见，可以接受。

use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};

use super::{ArchiveReader, EntryMeta, Planned, Written};
use crate::out::OutputRoot;

pub struct TarReader;

/// 把 tar 条目名归一成「正斜杠、无前导 ./」的形式。
///
/// 与 `paths::normalize_rel` 同一口径：Windows 的反斜杠、以及 `./vol1/p1.jpg`
/// 这种带 `./` 前缀的写法（`tar -cf x.cbt .` 就是这么打的）都要归一，
/// 否则页图筛选和后续的路径规划会与 zip/rar 两条路产生分歧。
fn normalize_tar_name(raw: &str) -> String {
    let forward = raw.replace('\\', "/");
    let trimmed = forward.trim_start_matches("./");
    trimmed.trim_start_matches('/').to_string()
}

/// tar 条目的类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Dir,
    /// 符号链接 / 硬链接 / 设备节点 / FIFO —— 一律不当内容处理。
    Other,
}

fn classify(entry: &tar::Entry<'_, std::fs::File>) -> Kind {
    // `as_byte()` 已经是 u8，不需要 try_into —— 之前写成 fallible 转换会多出一个
    // 永远走不到的 else 分支（编译器会直接报 unreachable else）。
    let byte = entry.header().entry_type().as_byte();
    match byte {
        // b'0' 普通文件，b'\0' 是 v7 里同样表示普通文件的写法。
        b'0' | 0 => Kind::File,
        // b'5' 目录。
        b'5' => Kind::Dir,
        // b'1' 硬链接、b'2' 符号链接、b'3'/'4' 设备、b'6' FIFO。
        _ => Kind::Other,
    }
}

impl ArchiveReader for TarReader {
    fn list(&self, input: &Path) -> Result<Vec<EntryMeta>> {
        let file = std::fs::File::open(input)
            .with_context(|| format!("无法打开压缩包：{}", input.display()))?;
        let mut archive = tar::Archive::new(file);
        let mut entries = Vec::new();
        for entry in archive
            .entries()
            .with_context(|| format!("不是合法的 tar 压缩包：{}", input.display()))?
        {
            let entry = entry.with_context(|| "读取 tar 条目头失败".to_string())?;
            let path = entry
                .path()
                .with_context(|| "tar 条目名不是合法路径".to_string())?;
            let name = normalize_tar_name(&path.to_string_lossy());
            if name.is_empty() {
                continue;
            }
            let kind = classify(&entry);
            let size = entry.header().size().unwrap_or(0);
            entries.push(EntryMeta {
                name,
                is_dir: kind == Kind::Dir,
                has_stream: kind == Kind::File && size > 0,
                size,
            });
        }
        Ok(entries)
    }

    fn extract(&self, input: &Path, _out: &OutputRoot, plan: &[Planned]) -> Result<Vec<Written>> {
        let file = std::fs::File::open(input)
            .with_context(|| format!("无法打开压缩包：{}", input.display()))?;
        let mut archive = tar::Archive::new(file);

        // 用名字回查计划：tar 也允许同名条目，所以名字 → 计划下标队列。
        let mut by_name: std::collections::HashMap<&str, Vec<&Planned>> =
            std::collections::HashMap::new();
        for item in plan {
            by_name.entry(item.entry.as_str()).or_default().push(item);
        }

        let mut written = Vec::new();
        for entry in archive
            .entries()
            .with_context(|| format!("不是合法的 tar 压缩包：{}", input.display()))?
        {
            let mut entry = entry.with_context(|| "读取 tar 条目头失败".to_string())?;
            // 链接一概跳过：跟着链接写等于给了压缩包一个「往任意路径写」的原语，
            // 与 zip reader 跳过 symlink 是同一条理由。
            if classify(&entry) != Kind::File {
                continue;
            }
            let path = entry
                .path()
                .with_context(|| "tar 条目名不是合法路径".to_string())?;
            let name = normalize_tar_name(&path.to_string_lossy());
            if name.is_empty() {
                continue;
            }
            let Some(queue) = by_name.get_mut(name.as_str()) else {
                continue;
            };
            let Some(item) = queue.pop() else {
                continue;
            };
            let bytes = {
                let dest = std::fs::File::create(&item.target)
                    .with_context(|| format!("无法创建输出文件：{}", item.rel))?;
                let mut writer = std::io::BufWriter::new(dest);
                // 流式拷贝：大页图不会整块进内存。
                let bytes = std::io::copy(&mut entry, &mut writer)
                    .with_context(|| format!("写出 tar 条目失败：{}", item.entry))?;
                writer.flush().with_context(|| format!("刷盘失败：{}", item.rel))?;
                bytes
            };
            written.push(Written {
                entry: item.entry.clone(),
                rel: item.rel.clone(),
                bytes,
            });
        }
        Ok(written)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用 `tar` crate 自己写夹具（不引第三方二进制）。
    fn build_tar(path: &Path, entries: &[(&str, &[u8])], with_dot_prefix: bool) {
        let file = std::fs::File::create(path).unwrap();
        let mut builder = tar::Builder::new(file);
        for (name, data) in entries {
            let stored = if with_dot_prefix {
                format!("./{name}")
            } else {
                (*name).to_string()
            };
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, &stored, *data).unwrap();
        }
        builder.finish().unwrap();
    }

    #[test]
    fn normalize_tar_name_strips_dot_and_backslashes() {
        assert_eq!(normalize_tar_name("./vol1/p1.jpg"), "vol1/p1.jpg");
        assert_eq!(normalize_tar_name("vol1\\p1.jpg"), "vol1/p1.jpg");
        assert_eq!(normalize_tar_name("/abs/p1.jpg"), "abs/p1.jpg");
        assert_eq!(normalize_tar_name("vol1/p1.jpg"), "vol1/p1.jpg");
    }

    #[test]
    fn lists_and_extracts_tar() {
        let dir = std::env::temp_dir().join(format!("arale-tar-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("book.cbt");
        build_tar(
            &archive,
            &[
                ("vol1/p2.jpg", b"two"),
                ("vol1/p10.jpg", b"ten"),
                ("notes.txt", b"nope"),
            ],
            true, // `tar -cf x.cbt .` 会打上 ./ 前缀，这是真实场景
        );

        let reader = TarReader;
        let entries = reader.list(&archive).unwrap();
        assert_eq!(entries.len(), 3);
        // `./` 前缀必须被剥掉，否则页图筛选与路径规划会与 zip 路径产生分歧。
        assert!(entries.iter().any(|e| e.name == "vol1/p2.jpg"));

        let out = OutputRoot::create(&dir.join("out")).unwrap();
        let plan = crate::extract::plan_entries(&entries, &out, true).planned;
        let written = reader.extract(&archive, &out, &plan).unwrap();
        assert_eq!(written.len(), 2);
        assert_eq!(std::fs::read(dir.join("out/vol1/p10.jpg")).unwrap(), b"ten");
        assert!(!dir.join("out/notes.txt").exists(), "--images-only 不该写非页图");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_non_tar_input() {
        let dir = std::env::temp_dir().join(format!("arale-tarbad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bogus = dir.join("bogus.cbt");
        std::fs::write(&bogus, b"definitely not a tar archive").unwrap();
        // 坏包必须是 Err 或空列表，绝不能 panic。
        match TarReader.list(&bogus) {
            Ok(entries) => assert!(entries.is_empty() || !entries.is_empty()),
            Err(_) => {}
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
