//! 输出根目录 —— 提取的**唯一**落盘出口，穿越防护集中在这里。
//!
//! 三道关，缺一不可：
//!   1. `sanitize_rel_segments` 拒绝任何含 `..` 的成员名（`paths.ts` 的口径）；
//!   2. 拼出的路径必须仍以 canonicalize 过的 `--out` 为前缀（纵深防御）；
//!   3. 路径里不能有 NUL —— `unrar` 的 `extract_to` 遇到 NUL 会 panic，
//!      而「绝不 panic」是协议要求（坏输入只能变成 `ok:false`）。
//!
//! 第 2 关为什么不只靠第 1 关：净化逻辑将来一旦被改（比如为了兼容某个发布者
//! 而放行 `..`），穿越必须仍然写不出去。安全红线不能只有一处守卫。

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::paths::{join_rel, resolve_inside, sanitize_rel_segments};

/// 已确认存在的输出根目录（canonicalize 后）。
#[derive(Debug, Clone)]
pub struct OutputRoot {
    canonical: PathBuf,
}

impl OutputRoot {
    /// 建目录（含父级）并 canonicalize。
    ///
    /// canonicalize 是必须的：macOS 上 `/tmp` 是指向 `/private/tmp` 的符号链接，
    /// 不规范化就会出现「前缀检查用 `/tmp`、真实路径是 `/private/tmp`」而误判为
    /// 越界，或者反过来漏判。
    pub fn create(path: &Path) -> Result<Self> {
        std::fs::create_dir_all(path)
            .with_context(|| format!("无法创建输出目录：{}", path.display()))?;
        let canonical = std::fs::canonicalize(path)
            .with_context(|| format!("无法规范化输出目录：{}", path.display()))?;
        if !canonical.is_dir() {
            anyhow::bail!("输出路径不是目录：{}", canonical.display());
        }
        Ok(Self { canonical })
    }

    /// 规范化的绝对根路径（测试与诊断用；生产代码只通过 `prepare` 使用它）。
    #[cfg(test)]
    pub fn canonical(&self) -> &Path {
        &self.canonical
    }

    /// 准备一个条目的落盘路径：净化 → 拼接 → 前缀断言 → 建父目录。
    ///
    /// 返回 `None` 表示这个条目必须被跳过（含 `..` / 净化后为空 / 路径异常）。
    /// **绝不因为一个坏条目让整次提取失败**：坏条目计入 `skipped`，其余照常写。
    pub fn prepare(&self, raw_name: &str) -> Option<Prepared> {
        let segments = sanitize_rel_segments(raw_name)?;
        if segments.is_empty() {
            return None;
        }
        let rel = join_rel(&segments);
        if rel.is_empty() {
            return None;
        }
        let path = resolve_inside(&self.canonical, &segments)?;
        // NUL 会让 unrar 的 C 字符串构造 panic；正常净化后不可能出现，这里是兜底。
        if path.as_os_str().to_string_lossy().contains('\0') {
            return None;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok()?;
        }
        Some(Prepared { path, rel, segments })
    }
}

/// 一个已通过安全校验的落盘目标。
#[derive(Debug, Clone)]
pub struct Prepared {
    pub path: PathBuf,
    pub rel: String,
    #[allow(dead_code)]
    pub segments: Vec<String>,
}

/// 目录内唯一化：重名时加 ` (2)`、` (3)`…，同 Fushi 的 `uniqueDestRel`
/// （`paths.ts:51-60`）。
///
/// 为什么需要：不同成员名净化后可能撞到同一个相对路径（`a<b>.jpg` 与 `a_b_.jpg`）。
/// 直接覆盖会**悄悄丢页**；而 Fushi 在导入侧就是用 `uniqueDestRel` 让步的
/// ——两边口径必须一致，否则同一本书用原生层解和用 fflate 解会得到不同页数。
pub fn unique_rel(rel: &str, used: &mut std::collections::HashSet<String>) -> String {
    if used.insert(rel.to_string()) {
        return rel.to_string();
    }
    let (dir, base, ext) = split_rel(rel);
    for n in 2u32.. {
        let candidate = format!("{dir}{base} ({n}){ext}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!("unique_rel 的循环必然返回")
}

/// 拆成 (前缀含斜杠, 主名, 扩展名)，等价于 `path.posix.dirname/basename/extname`。
fn split_rel(rel: &str) -> (String, String, String) {
    let (dir, name) = match rel.rfind('/') {
        Some(idx) => (&rel[..idx + 1], &rel[idx + 1..]),
        None => ("", rel),
    };
    match name.rfind('.') {
        Some(0) | None => (dir.to_string(), name.to_string(), String::new()),
        Some(idx) => (
            dir.to_string(),
            name[..idx].to_string(),
            name[idx..].to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> (PathBuf, OutputRoot) {
        let dir = std::env::temp_dir().join(format!("arale-out-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        let root = OutputRoot::create(&dir).unwrap();
        (dir, root)
    }

    #[test]
    fn writes_inside_and_creates_parent_dirs() {
        let (dir, root) = temp_root("inside");
        let prepared = root.prepare("vol1/p001.jpg").unwrap();
        assert_eq!(prepared.rel, "vol1/p001.jpg");
        assert!(prepared.path.starts_with(root.canonical()));
        assert!(prepared.path.parent().unwrap().is_dir(), "父目录必须已建好");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_parent_segments() {
        let (dir, root) = temp_root("parent");
        assert!(root.prepare("../escape.jpg").is_none());
        assert!(root.prepare("a/../../escape.jpg").is_none());
        assert!(root.prepare("..\\escape.jpg").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_empty_and_dot_only_names() {
        let (dir, root) = temp_root("empty");
        assert!(root.prepare("").is_none());
        assert!(root.prepare(".").is_none());
        assert!(root.prepare("./").is_none());
        assert!(root.prepare("/").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sanitizes_illegal_names_but_keeps_structure() {
        let (dir, root) = temp_root("illegal");
        let prepared = root.prepare("vol:1/p00?.jpg").unwrap();
        assert_eq!(prepared.rel, "vol_1/p00_.jpg");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unique_rel_matches_fushi_unique_dest_rel() {
        let mut used = std::collections::HashSet::new();
        assert_eq!(unique_rel("a/p1.jpg", &mut used), "a/p1.jpg");
        assert_eq!(unique_rel("a/p1.jpg", &mut used), "a/p1 (2).jpg");
        assert_eq!(unique_rel("a/p1.jpg", &mut used), "a/p1 (3).jpg");
        assert_eq!(unique_rel("p1", &mut used), "p1");
        assert_eq!(unique_rel("p1", &mut used), "p1 (2)");
        assert_eq!(unique_rel("vol/p1.jpg", &mut used), "vol/p1.jpg");
    }
}
