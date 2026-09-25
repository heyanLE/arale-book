//! 7z / CB7 读取器（纯 Rust 的 `sevenz-rust`）。
//!
//! 为什么纯 Rust 也要放进原生层：`7z-wasm` 会把整包解到 WASM 线性内存里，
//! 多 GB 的 CB7 直接把渲染进程/主进程打爆。`sevenz-rust` 的 `for_each_entries`
//! 给的是 `&mut dyn Read`，配 `io::copy` 就是**常数内存**流式解包。
//!
//! 已知不支持（`sevenz-rust` 的边界，会以明确 error 返回）：
//!   - 加密 7z（`PasswordRequired`）—— 没有密码入口；
//!   - 需要 `bzip2`/`zstd` feature 的少数包 —— 本次刻意不开这些 feature 以压体积，
//!     遇到时报 `UnsupportedCompressionMethod`，文案里说明原因。
//!
//! 注意：solid 包必须顺序解，不能随机访问条目 —— `for_each_entries` 本身就是
//! 顺序遍历，正好符合。

use std::io::{Read, Write};
use std::path::Path;

use anyhow::{Context, Result};
// 别名导入：本模块的读取器也叫 `SevenZReader`，直接同名导入会 E0255。
use sevenz_rust::{Password, SevenZArchiveEntry, SevenZReader as SevenZFileReader};

use super::{ArchiveReader, EntryMeta, Planned, Written};
use crate::out::OutputRoot;

pub struct SevenZReader;

impl ArchiveReader for SevenZReader {
    fn list(&self, input: &Path) -> Result<Vec<EntryMeta>> {
        let archive = open(input)?;
        let mut entries = Vec::new();
        for file in archive.archive().files.iter() {
            entries.push(meta_of(file));
        }
        Ok(entries)
    }

    fn extract(&self, input: &Path, _out: &OutputRoot, plan: &[Planned]) -> Result<Vec<Written>> {
        if plan.is_empty() {
            return Ok(Vec::new());
        }
        let mut by_name: std::collections::HashMap<&str, Vec<&Planned>> =
            std::collections::HashMap::new();
        for item in plan {
            by_name.entry(item.entry.as_str()).or_default().push(item);
        }

        let mut archive = open(input)?;
        let mut written: Vec<Written> = Vec::new();
        // `for_each_entries` 的闭包是 `FnMut`，所以要靠槽位把 anyhow 错误带出来
        // ——`anyhow::Error` 不是 `Clone`，不能直接在被 `?` 消费后再读。
        let mut failure: Option<anyhow::Error> = None;

        let stream_result = archive.for_each_entries(|entry, reader| {
            let name = entry.name().to_string();
            let Some(queue) = by_name.get_mut(name.as_str()) else {
                // 不在计划里的条目：直接丢，不读不写。
                // 注意 7z 的 solid 包不能真正「跳过」解码，reader 已经被解码过，
                // 但丢弃输出即可，内存仍是常数。
                return Ok(true);
            };
            let Some(item) = queue.pop() else {
                return Ok(true);
            };
            let result = write_stream(reader, &item.target);
            match result {
                Ok(bytes) => {
                    written.push(Written {
                        entry: item.entry.clone(),
                        rel: item.rel.clone(),
                        bytes,
                    });
                    Ok(true)
                }
                Err(error) => {
                    failure = Some(error.context(format!("写出 7z 条目失败：{}", item.entry)));
                    Ok(false)
                }
            }
        });

        if let Some(error) = failure {
            return Err(error);
        }
        stream_result.map_err(|error| sevenz_error(input, error))?;
        Ok(written)
    }
}

/// 打开 7z 读取器。`SevenZReader::open` 只读头部元数据，不解压内容。
fn open(input: &Path) -> Result<SevenZFileReader<std::fs::File>> {
    SevenZFileReader::open(input, Password::empty()).map_err(|error| sevenz_error(input, error))
}

/// 流式写出一条 7z 条目。`reader` 是解码后的流，`io::copy` 保证常数内存。
fn write_stream(reader: &mut dyn Read, target: &Path) -> Result<u64> {
    let file = std::fs::File::create(target)
        .with_context(|| format!("无法创建输出文件：{}", target.display()))?;
    let mut writer = std::io::BufWriter::new(file);
    let bytes = std::io::copy(reader, &mut writer).context("写入 7z 条目内容失败")?;
    writer.flush().context("刷盘失败")?;
    Ok(bytes)
}

fn meta_of(file: &SevenZArchiveEntry) -> EntryMeta {
    EntryMeta {
        name: file.name().replace('\\', "/"),
        is_dir: file.is_directory(),
        has_stream: file.has_stream(),
        size: file.size(),
    }
}

/// 把 `sevenz-rust` 的错误翻译成人话。
fn sevenz_error(input: &Path, error: sevenz_rust::Error) -> anyhow::Error {
    let reason = match &error {
        sevenz_rust::Error::BadSignature(signature) => {
            format!("不是合法的 7z 压缩包（签名字节 {signature:?}）")
        }
        sevenz_rust::Error::UnsupportedVersion { major, minor } => {
            format!("不支持的 7z 版本 {major}.{minor}")
        }
        sevenz_rust::Error::PasswordRequired => {
            "这个 7z 是加密的，需要密码（原生层没有密码入口）".to_string()
        }
        sevenz_rust::Error::MaybeBadPassword(_) => "7z 密码错误".to_string(),
        sevenz_rust::Error::ChecksumVerificationFailed => {
            "7z 校验和不匹配（文件损坏）".to_string()
        }
        sevenz_rust::Error::UnsupportedCompressionMethod(method) => format!(
            "7z 使用了本构建未启用的压缩方法：{method}（如需支持请打开 sevenz-rust 的对应 feature）"
        ),
        sevenz_rust::Error::MaxMemLimited { max_kb, actaul_kb } => format!(
            "7z 需要的解压内存超过限制（上限 {max_kb} KB，实际约 {actaul_kb} KB）"
        ),
        sevenz_rust::Error::Io(_, message) => format!("读写 7z 失败：{message}"),
        other => format!("7z 解包失败：{other}"),
    };
    anyhow::anyhow!("{reason}（{}）", input.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用 `sevenz-rust` 的 writer 造一个真实 7z（测试内自包含，不依赖外部工具）。
    fn build_7z(path: &Path, entries: &[(&str, &[u8])]) {
        let mut writer = sevenz_rust::SevenZWriter::create(path).unwrap();
        for (name, data) in entries {
            let mut entry = SevenZArchiveEntry::new();
            entry.name = (*name).to_string();
            entry.has_stream = true;
            writer
                .push_archive_entry(entry, Some(std::io::Cursor::new(data.to_vec())))
                .unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn lists_and_extracts_7z_streaming() {
        let dir = std::env::temp_dir().join(format!("arale-7z-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("a.cb7");
        build_7z(
            &archive,
            &[("vol1/p2.jpg", b"two"), ("vol1/p10.jpg", b"ten"), ("readme.txt", b"skip me")],
        );

        let reader = SevenZReader;
        let entries = reader.list(&archive).unwrap();
        assert_eq!(entries.len(), 3);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"vol1/p2.jpg"));

        let out = OutputRoot::create(&dir.join("out")).unwrap();
        let plan = crate::extract::plan_entries(&entries, &out, true);
        let written = reader.extract(&archive, &out, &plan.planned).unwrap();
        assert_eq!(written.len(), 2);
        assert_eq!(std::fs::read(dir.join("out/vol1/p10.jpg")).unwrap(), b"ten");
        assert!(!dir.join("out/readme.txt").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fake_7z_fails_without_panicking() {
        let dir = std::env::temp_dir().join(format!("fushi-7zbad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("fake.7z");
        std::fs::write(&fake, b"7z\xbc\xaf\x27\x1ctruncated garbage").unwrap();
        assert!(SevenZReader.list(&fake).is_err());

        // 一个空文件（0 字节）也不能 panic。
        let empty = dir.join("empty.7z");
        std::fs::write(&empty, b"").unwrap();
        assert!(SevenZReader.list(&empty).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 顺手验证 writer/reader 的往返，确保上面的夹具本身是可信的。
    #[test]
    fn fixture_roundtrip_is_real_7z() {
        let dir = std::env::temp_dir().join(format!("fushi-7zrt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("rt.7z");
        build_7z(&archive, &[("x.bin", &[7u8; 4096])]);
        let head = std::fs::read(&archive).unwrap();
        assert_eq!(crate::format::Format::detect(&head), crate::format::Format::SevenZ);
        let out = OutputRoot::create(&dir.join("out")).unwrap();
        let entries = SevenZReader.list(&archive).unwrap();
        let plan = crate::extract::plan_entries(&entries, &out, false);
        SevenZReader.extract(&archive, &out, &plan.planned).unwrap();
        let mut file = std::fs::File::open(dir.join("out/x.bin")).unwrap();
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).unwrap();
        assert_eq!(buf, vec![7u8; 4096]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_stream_is_used_for_writes() {
        // 直接覆盖 `write_stream`：确保它按真实读取字节数返回，而不是声明的 size。
        let dir = std::env::temp_dir().join(format!("fushi-7zws-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("out.bin");
        let mut cursor = std::io::Cursor::new(vec![1u8, 2, 3]);
        let bytes = write_stream(&mut cursor, &target).unwrap();
        assert_eq!(bytes, 3);
        assert_eq!(std::fs::read(&target).unwrap(), vec![1u8, 2, 3]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_7z_yields_no_entries() {
        let dir = std::env::temp_dir().join(format!("fushi-7znil-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("nil.7z");
        sevenz_rust::SevenZWriter::create(&archive)
            .unwrap()
            .finish()
            .unwrap();
        let entries = SevenZReader.list(&archive).unwrap();
        assert!(entries.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
