//! RAR 读取器（`unrar` crate，编译 rarlab 官方 UnRAR C++ 源码）。
//!
//! 为什么必须走原生：纯 JS 的 `node-unrar-js` 把整包读进 WASM 线性内存，
//! 多 GB 的漫画卷直接爆；而且 RAR5 支持不全。Fushi 的做法是 shell out 到
//! `7za`（`MangaSevenZipExtractor` 注释里写着 Windows 随包 `7za.exe`，macOS/Linux
//! 靠 PATH）—— 那是「用户机器上恰好装了 7-Zip 才行」的隐式依赖，我们要替换掉。
//!
//! 流式：`extract_to` 直接把解压结果写进目标文件（走 UnRAR 的回调），
//! 内存里不驻留整条条目。**但 UnRAR 不建父目录**（`ExtrCreateFile` 只在文件名
//! 非法时才 `CreatePath`），所以父目录必须由 `OutputRoot::prepare` 提前建好。
//!
//! 已知不支持并会给出明确 `error` 的情况：
//!   - 加密（`ERAR_MISSING_PASSWORD` / `ERAR_BAD_PASSWORD`）—— 我们没有密码入口；
//!   - 分卷缺卷（`ERAR_EOPEN`）—— 只有第一卷在时无法续读。
//! 多卷**齐**的情况是支持的：`as_first_part()` + UnRAR 自己的换卷回调。

use std::path::Path;

use anyhow::Result;
use unrar::error::{Code, UnrarError};
use unrar::{Archive, List, OpenArchive};

use super::{ArchiveReader, EntryMeta, Planned, Written};
use crate::out::OutputRoot;

pub struct RarReader;

impl RarReader {
    /// 打开用于列表。用 `as_first_part()` 让 `<name>.part01.rar` 从第一卷开始
    /// —— 用户选中的往往是任意一卷。
    fn open_list(input: &Path) -> Result<OpenArchive<List, unrar::CursorBeforeHeader>> {
        // 说明：`open_for_listing`/`open_for_processing` 文档里写了「path 含 NUL 会
        // panic」，但路径来自 argv 与 `--out`（都不可能是 NUL 终止的字符串），
        // 且条目名已在学校验阶段剥掉 NUL。
        Archive::new(input)
            .as_first_part()
            .open_for_listing()
            .map_err(|e| rar_error(input, e, "打开 RAR 压缩包失败"))
    }
}

impl ArchiveReader for RarReader {
    fn list(&self, input: &Path) -> Result<Vec<EntryMeta>> {
        let archive = Self::open_list(input)?;
        let mut entries = Vec::new();
        for header in archive {
            let header = header.map_err(|e| rar_error(input, e, "读取 RAR 条目失败"))?;
            let is_dir = header.is_directory();
            entries.push(EntryMeta {
                name: header.filename.to_string_lossy().replace('\\', "/"),
                is_dir,
                // 这里刻意恒为 true（非目录即有流）：RAR4 的头部 `UnpSize` 是 32 位，
                // 大于 4 GB 的条目会写 0xFFFFFFFF 甚至 0，用它判「有没有内容」
                // 会误杀大页图。真正的大小以解压后的文件元数据为准。
                has_stream: !is_dir,
                size: header.unpacked_size,
            });
        }
        Ok(entries)
    }

    fn extract(&self, input: &Path, _out: &OutputRoot, plan: &[Planned]) -> Result<Vec<Written>> {
        if plan.is_empty() {
            return Ok(Vec::new());
        }
        let mut by_name: std::collections::HashMap<String, Vec<&Planned>> =
            std::collections::HashMap::new();
        for item in plan {
            by_name
                .entry(item.entry.replace('\\', "/"))
                .or_default()
                .push(item);
        }

        let mut archive = Archive::new(input)
            .as_first_part()
            .open_for_processing()
            .map_err(|e| rar_error(input, e, "打开 RAR 压缩包失败"))?;

        let mut written = Vec::new();
        loop {
            let cursor = archive
                .read_header()
                .map_err(|e| rar_error(input, e, "读取 RAR 条目头失败"))?;
            let Some(cursor) = cursor else { break };
            let name = cursor.entry().filename.to_string_lossy().replace('\\', "/");
            if cursor.entry().is_directory() {
                archive = cursor
                    .skip()
                    .map_err(|e| rar_error(input, e, "跳过 RAR 目录项失败"))?;
                continue;
            }
            let target = by_name
                .get_mut(&name)
                .and_then(|queue| queue.pop())
                .map(|item| (item.target.clone(), item.rel.clone(), item.entry.clone()));
            match target {
                Some((path, rel, entry)) => {
                    // `extract_to` 是流式落盘（UnRAR 内部按块回调写文件），
                    // 内存占用与条目大小无关。
                    archive = cursor.extract_to(&path).map_err(|e| {
                        rar_error(
                            input,
                            e,
                            &format!("解压 RAR 条目失败：{entry}（加密或分卷缺失时会到这里）"),
                        )
                    })?;
                    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    written.push(Written { entry, rel, bytes });
                }
                None => {
                    archive = cursor
                        .skip()
                        .map_err(|e| rar_error(input, e, "跳过 RAR 条目失败"))?;
                }
            }
        }
        Ok(written)
    }
}

/// 把 UnRAR 的错误码翻译成**给人看**的中文原因。
///
/// 为什么不能只 `{:?}` 打错误码：`ERAR_MISSING_PASSWORD` 或 `ERAR_EOPEN` 对用户
/// 毫无意义，而「这个 RAR 是加密的」「缺少后续分卷」是他能采取行动的信息。
/// 契约要求 `ok:false` 时给一个 human-readable `error`（`native-protocol.ts:48`）。
fn rar_error(input: &Path, error: UnrarError, context: &str) -> anyhow::Error {
    let reason = match error.code {
        Code::MissingPassword => "这个 RAR 是加密的，需要密码（原生层没有密码入口）".to_string(),
        Code::BadPassword => "RAR 密码错误".to_string(),
        Code::UnknownFormat => {
            if error.when == unrar::error::When::Open {
                "RAR 使用了不支持的加密头".to_string()
            } else {
                "无法识别的 RAR 格式".to_string()
            }
        }
        Code::BadArchive => "不是合法的 RAR 压缩包".to_string(),
        Code::BadData => match error.when {
            unrar::error::When::Open => "RAR 压缩包头损坏".to_string(),
            unrar::error::When::Read => "RAR 条目头损坏".to_string(),
            _ => "RAR 条目 CRC 校验失败（文件损坏）".to_string(),
        },
        Code::EOpen => "无法打开 RAR（缺少后续分卷，或文件不可读）".to_string(),
        Code::EReference => "RAR 使用了引用记录，缺少被引用的源文件".to_string(),
        Code::NoMemory => "内存不足".to_string(),
        Code::ECreate | Code::EWrite => "无法写出解压结果（磁盘满或权限不足）".to_string(),
        Code::ERead => "读取 RAR 失败（文件被截断）".to_string(),
        _ => format!("UnRAR 失败：{error}"),
    };
    anyhow::anyhow!("{context}：{reason}（{}）", input.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 假 `.rar`（magic 对但内容垃圾）必须变成 `Err`，而不是 panic 或挂死。
    /// 这条覆盖「坏输入不 panic」的契约要求。
    #[test]
    fn fake_rar_fails_without_panicking() {
        let dir = std::env::temp_dir().join(format!("arale-rar-fake-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("fake.cbr");
        let mut bytes = b"Rar!\x1a\x07\x01\x00".to_vec();
        bytes.extend_from_slice(&[0u8; 64]);
        std::fs::write(&fake, &bytes).unwrap();

        let result = RarReader.list(&fake);
        assert!(result.is_err(), "假 RAR 必须返回 Err");
        let message = result.unwrap_err().to_string();
        assert!(!message.is_empty(), "错误信息不能为空");

        let out = OutputRoot::create(&dir.join("out")).unwrap();
        assert!(RarReader.extract(&fake, &out, &[]).is_ok(), "空计划不该打开包");
        std::fs::remove_dir_all(&dir).ok();
    }
}
