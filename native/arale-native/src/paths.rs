//! 压缩包成员名净化 —— 逐行复刻 `src/core/util/paths.ts` 的 `sanitizeRelSegments`。
//!
//! 这是**安全红线**，不是格式化：压缩包成员名是完全由攻击者控制的字符串。
//! Fushi 的 `MangaStorage.sanitizeRelSegments` 遇到 `..` 直接抛错，这里返回 `None`
//! 让调用方跳过该条目（`extract` 里计入 `skipped`），绝不写盘。
//!
//! `paths.ts` 的规则（顺序也要一致）：
//!   1. `\` → `/`；去掉前导 `/`
//!   2. 去掉 `scheme://` 前缀（`file:` / `http:` 之类污染）
//!   3. 逐段：空段与 `.` 丢弃；`..` 整条拒绝
//!   4. 段内 `<>:"|?*` 与 C0 控制字符 → `_`

use std::path::{Path, PathBuf};

/// 把任意外来路径串归一成「相对、正斜杠、无前导斜杠」形式（`normalizeRel`）。
pub fn normalize_rel(raw: &str) -> String {
    let forward = raw.replace('\\', "/");
    match forward.strip_prefix('/') {
        Some(rest) => rest.to_string(),
        None => forward,
    }
}

/// 剥掉 `scheme://` 前缀。只认 `[A-Za-z][A-Za-z0-9+.-]*://` 这种形状，
/// 与 `paths.ts` 的正则同义；不匹配时原样返回。
fn strip_scheme(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return value;
    }
    let mut i = 1;
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_alphanumeric() || b == b'+' || b == b'.' || b == b'-' {
            i += 1;
        } else {
            break;
        }
    }
    if value[i..].starts_with("://") {
        &value[i + 3..]
    } else {
        value
    }
}

/// 单段净化：Windows 保留字符与 C0 控制字符 → `_`。
///
/// 为什么连控制字符一起换：这些字符在 Windows 上根本落不了盘，在 macOS/Linux 上
/// 能落盘却会让别的工具炸掉（终端、`ls`、后续的 ffmpeg/OCR 调用）。换成 `_`
/// 至少保证「导入一次、三平台都能再打开」。
fn sanitize_segment(segment: &str) -> String {
    segment
        .chars()
        .map(|ch| {
            if ch.is_ascii_control() || matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                ch
            }
        })
        .collect()
}

/// 净化一个压缩包成员名。返回 `None` 表示含 `..`，必须跳过。
pub fn sanitize_rel_segments(raw: &str) -> Option<Vec<String>> {
    let value = normalize_rel(raw.trim());
    let value = strip_scheme(&value);
    let mut segments = Vec::new();
    for segment in value.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return None;
        }
        segments.push(sanitize_segment(segment));
    }
    Some(segments)
}

/// 安全段拼回正斜杠相对路径（`joinRel`）。
pub fn join_rel(segments: &[String]) -> String {
    segments.join("/")
}

/// 是否含 `..` 段（用于给 `skipped` 分类、也用于测试断言）。
pub fn contains_parent_segment(raw: &str) -> bool {
    normalize_rel(raw.trim())
        .split('/')
        .any(|segment| segment == "..")
}

/// 取小写扩展名（含点）。`paths.ts` 里 `path.posix.extname` 的等价物：
/// 只看 basename 的**最后一个**点，且点必须在首位之后（`".jpg"` 不算扩展名）。
pub fn extname_lower(rel: &str) -> String {
    let base = match rel.rfind('/') {
        Some(idx) => &rel[idx + 1..],
        None => rel,
    };
    match base.rfind('.') {
        Some(0) | None => String::new(),
        Some(idx) => base[idx..].to_ascii_lowercase(),
    }
}

/// 取 basename（`paths.ts` 的 `basename`）。
pub fn basename(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(idx) => &rel[idx + 1..],
        None => rel,
    }
}

/// 把安全段拼到 `root` 下，并做**第二道**纵深防御：拼出来的绝对路径必须仍在
/// `root`（已 canonicalize）内。`sanitize_rel_segments` 已经挡掉 `..`，这里再挡一次，
/// 是因为将来若有人改动净化逻辑，穿越必须仍然写不出去。
pub fn resolve_inside(root_canonical: &Path, segments: &[String]) -> Option<PathBuf> {
    let mut candidate = root_canonical.to_path_buf();
    for segment in segments {
        candidate.push(segment);
    }
    // 逐段 push 已保证不可能是绝对路径（段里不可能有 '/'，因为净化后按 '/' 切过）。
    if candidate.starts_with(root_canonical) {
        Some(candidate)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_backslashes_and_leading_slash() {
        assert_eq!(normalize_rel("\\a\\b.jpg"), "a/b.jpg");
        assert_eq!(normalize_rel("/a/b.jpg"), "a/b.jpg");
        assert_eq!(normalize_rel("a/b.jpg"), "a/b.jpg");
    }

    #[test]
    fn rejects_parent_segments() {
        assert_eq!(sanitize_rel_segments("../escape.jpg"), None);
        assert_eq!(sanitize_rel_segments("a/../../escape.jpg"), None);
        assert_eq!(sanitize_rel_segments("a/.."), None);
        assert_eq!(sanitize_rel_segments("..\\escape.jpg"), None);
        // `...` 不是 `..`，不能误伤。
        assert_eq!(sanitize_rel_segments(".../x.jpg").unwrap(), vec!["...", "x.jpg"]);
    }

    #[test]
    fn maps_windows_illegal_and_control_chars() {
        assert_eq!(
            sanitize_rel_segments("a<b>c:d\"e|f?g*h.jpg").unwrap(),
            vec!["a_b_c_d_e_f_g_h.jpg".to_string()]
        );
        assert_eq!(
            sanitize_rel_segments("bad\u{0000}\u{001f}name.jpg").unwrap(),
            vec!["bad__name.jpg".to_string()]
        );
    }

    #[test]
    fn drops_dot_and_empty_segments() {
        assert_eq!(sanitize_rel_segments("a//b/./c.jpg").unwrap(), vec!["a", "b", "c.jpg"]);
        assert_eq!(sanitize_rel_segments("").unwrap(), Vec::<String>::new());
        assert_eq!(sanitize_rel_segments("./").unwrap(), Vec::<String>::new());
    }

    #[test]
    fn strips_uri_scheme_and_drive_prefixes() {
        assert_eq!(sanitize_rel_segments("file:///a/b.jpg").unwrap(), vec!["a", "b.jpg"]);
        // 盘符不是 scheme（没有 `//`），但 `:` 会被换成 `_`。
        assert_eq!(sanitize_rel_segments("C:/a/b.jpg").unwrap(), vec!["C_", "a", "b.jpg"]);
    }

    #[test]
    fn keeps_subdirectories_never_flattens() {
        assert_eq!(
            sanitize_rel_segments("vol1/p001.jpg").unwrap(),
            vec!["vol1", "p001.jpg"]
        );
    }

    #[test]
    fn resolve_inside_is_a_second_line_of_defence() {
        let root = std::env::temp_dir();
        let segments = vec!["a".to_string(), "b.jpg".to_string()];
        let resolved = resolve_inside(&root, &segments).unwrap();
        assert!(resolved.starts_with(&root));
        assert!(resolved.ends_with("a/b.jpg"));
    }

    #[test]
    fn extname_matches_posix_extname() {
        assert_eq!(extname_lower("a/b.JPG"), ".jpg");
        assert_eq!(extname_lower("vol1/p001.jpeg"), ".jpeg");
        // 隐藏文件（点开头）没有扩展名。
        assert_eq!(extname_lower("a/.hidden"), "");
        assert_eq!(extname_lower("a/noext"), "");
        assert_eq!(extname_lower("a/b.jpg.txt"), ".txt");
        // 名字里带点的目录不影响 basename 判定。
        assert_eq!(extname_lower("dir.v2/b"), "");
    }

    #[test]
    fn basename_splits_on_forward_slash_only() {
        assert_eq!(basename("vol1/p001.jpg"), "p001.jpg");
        assert_eq!(basename("p001.jpg"), "p001.jpg");
        assert_eq!(basename("a/b/"), "");
    }
}
