//! ZIP 读取器（`zip` crate）。
//!
//! 注意：`.zip`/`.cbz` 在 aralebook 里**不走原生层**（fflate 已经够用，见
//! `native-protocol.ts:9`）。这里支持 zip 只为一件事：ZIP 容器里的 `.rar`/`.7z`
//! 是用户常见的手滑，而 `probe` 必须按**内容**报告格式；若内容判定为 zip,
//! 原生层仍要能给出正确答案，而不是说「我看不懂」。

use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};

use super::{ArchiveReader, EntryMeta, Planned, Written};
use crate::out::OutputRoot;

pub struct ZipReader;

impl ArchiveReader for ZipReader {
    fn list(&self, input: &Path) -> Result<Vec<EntryMeta>> {
        let file = std::fs::File::open(input)
            .with_context(|| format!("无法打开压缩包：{}", input.display()))?;
        let mut archive = zip::ZipArchive::new(file)
            .with_context(|| format!("不是合法的 zip 压缩包：{}", input.display()))?;
        let mut entries = Vec::with_capacity(archive.len());
        for index in 0..archive.len() {
            let entry = archive
                .by_index(index)
                .with_context(|| format!("读取 zip 中央目录第 {index} 项失败"))?;
            // `is_dir()` 认末尾斜杠与外部属性两种目录标记；zip 里目录项不该计入 entryCount。
            let is_dir = entry.is_dir();
            entries.push(EntryMeta {
                name: entry.name().to_string(),
                is_dir,
                has_stream: !is_dir && entry.size() > 0,
                size: entry.size(),
            });
        }
        Ok(entries)
    }

    fn extract(&self, input: &Path, _out: &OutputRoot, plan: &[Planned]) -> Result<Vec<Written>> {
        let file = std::fs::File::open(input)
            .with_context(|| format!("无法打开压缩包：{}", input.display()))?;
        let mut archive = zip::ZipArchive::new(file)
            .with_context(|| format!("不是合法的 zip 压缩包：{}", input.display()))?;

        // 用名字回查计划：zip 允许同名条目，所以用「名字 → 计划下标队列」。
        let mut by_name: std::collections::HashMap<&str, Vec<&Planned>> =
            std::collections::HashMap::new();
        for item in plan {
            by_name.entry(item.entry.as_str()).or_default().push(item);
        }

        let mut written = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .with_context(|| format!("读取 zip 条目 #{index} 失败"))?;
            if entry.is_dir() {
                continue;
            }
            // 符号链接必须跳过：`io::copy` 会跟着链接写，等于给了压缩包一个
            // 「往任意路径写」的原语（zip-slip 的变体）。Fushi 的 `_filesOf` 只认
            // 普通文件，这里保持同一口径。
            if entry.is_symlink() {
                continue;
            }
            let name = entry.name().to_string();
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
                // `io::copy` 是流式的：大页图不会整块进内存。
                let bytes = std::io::copy(&mut entry, &mut writer)
                    .with_context(|| format!("写出 zip 条目失败：{}", item.entry))?;
                writer
                    .flush()
                    .with_context(|| format!("刷盘失败：{}", item.rel))?;
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
    use std::io::Write;

    /// 用 zip crate 自身写一个测试包（不引第三方夹具）。
    fn build_zip(path: &Path, entries: &[(&str, &[u8], bool)]) {
        let file = std::fs::File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        for (name, data, deflate) in entries {
            let opts: zip::write::SimpleFileOptions = if *deflate {
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated)
            } else {
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored)
            };
            writer.start_file(*name, opts).unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn lists_and_extracts_zip() {
        let dir = std::env::temp_dir().join(format!("arale-zip-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("a.cbz");
        build_zip(
            &archive,
            &[
                ("vol1/p2.jpg", b"two", true),
                ("vol1/p10.jpg", b"ten", true),
                ("notes.txt", b"nope", false),
            ],
        );

        let reader = ZipReader;
        let entries = reader.list(&archive).unwrap();
        assert_eq!(entries.len(), 3);
        assert!(entries.iter().all(|e| !e.is_dir));

        let out = OutputRoot::create(&dir.join("out")).unwrap();
        let plan = crate::extract::plan_entries(&entries, &out, true).planned;
        let written = reader.extract(&archive, &out, &plan).unwrap();
        assert_eq!(written.len(), 2);
        assert!(dir.join("out/vol1/p2.jpg").is_file());
        assert_eq!(std::fs::read(dir.join("out/vol1/p10.jpg")).unwrap(), b"ten");
        // 非页图（notes.txt）绝不能落盘。
        assert!(!dir.join("out/notes.txt").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_non_zip_input() {
        let dir = std::env::temp_dir().join(format!("fushi-zipbad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bogus = dir.join("bogus.zip");
        std::fs::write(&bogus, b"this is not a zip at all").unwrap();
        assert!(ZipReader.list(&bogus).is_err(), "坏包必须变成 Err 而不是 panic");
        std::fs::remove_dir_all(&dir).ok();
    }
}
