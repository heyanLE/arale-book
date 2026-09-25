//! 漫画页判定与自然序 —— 逐行复刻 `src/core/comic/pages.ts` + `src/core/util/natural-sort.ts`。
//!
//! 页序在阅读器里**就是数组顺序**，没有任何二次排序，所以这里的比较器必须与 TS 侧
//! 逐位一致，否则「同一个包用原生层解」与「用 fflate 解」会给出不同页序 ——
//! Fushi BUG-1121 就是同一种病（导入侧与 OCR 侧各写一张扩展名表，悄悄漂移）。
//!
//! 自然序的冻结口径（`natural-sort.ts:24-53`）：
//!   - 数字段按数值比（先比去前导零后的长度，再比字典序）
//!   - 数值相等时**位数少的在前**（`p1.jpg` < `p001.jpg`），保证全序稳定，
//!     不能像 `localeCompare({numeric:true})` 那样判等
//!   - 其余按**码元**比（JS 是 UTF-16 code unit，Rust 是 Unicode scalar；对 BMP
//!     内字符完全一致，对 emoji 这类补充平面字符会与 JS 有差异 —— 漫画页名里不该
//!     出现，真出现也只是排序不同、不会丢页）
//!   - 前缀关系时短的在前

use crate::paths::{extname_lower, normalize_rel};

/// 页图扩展名基集（小写、含点），顺序即优先序。
///
/// **必须只有这一张表。** 这里的顺序与 `pages.ts:19` 的 `COMIC_IMAGE_EXTENSIONS`
/// 完全一致，改动必须两边同步。
pub const COMIC_IMAGE_EXTENSIONS: [&str; 6] = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"];

/// 整卷 OCR 的产物目录名（`pages.ts:26`）。枚举时必须排除自己，否则第二次 OCR 会把
/// 第一次的 `manga.json` 与 `_pages/*.json` 当输入重扫一遍。
pub const MOKURO_OUT_DIR: &str = "manga_ocr_out";

fn is_digit(byte: u8) -> bool {
    byte.is_ascii_digit()
}

/// 去掉前导零；全零串返回空串（与 Dart `replaceFirst(RegExp('^0+'), '')` 一致）。
fn strip_leading_zeros(value: &[u8]) -> &[u8] {
    let mut i = 0;
    while i < value.len() && value[i] == b'0' {
        i += 1;
    }
    &value[i..]
}

/// 自然序比较器，语义见模块注释。返回负数表示 `a` 在前。
pub fn natural_compare(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    let la: Vec<u8> = a.to_lowercase().into_bytes();
    let lb: Vec<u8> = b.to_lowercase().into_bytes();
    let (mut i, mut j) = (0usize, 0usize);
    while i < la.len() && j < lb.len() {
        let ca = la[i];
        let cb = lb[j];
        if is_digit(ca) && is_digit(cb) {
            let si = i;
            let sj = j;
            while i < la.len() && is_digit(la[i]) {
                i += 1;
            }
            while j < lb.len() && is_digit(lb[j]) {
                j += 1;
            }
            let na = strip_leading_zeros(&la[si..i]);
            let nb = strip_leading_zeros(&lb[sj..j]);
            if na.len() != nb.len() {
                return na.len().cmp(&nb.len());
            }
            match na.cmp(nb) {
                Ordering::Equal => {}
                other => return other,
            }
            // 数值相等（如 001 vs 1）：位数少的在前，保证全序稳定。
            if i - si != j - sj {
                return (i - si).cmp(&(j - sj));
            }
        } else {
            if ca != cb {
                return ca.cmp(&cb);
            }
            i += 1;
            j += 1;
        }
    }
    (la.len() - i).cmp(&(lb.len() - j))
}

/// 按扩展名判断是否页图（大小写不敏感）—— `isComicImage`。
pub fn is_comic_image(rel: &str) -> bool {
    let ext = extname_lower(&normalize_rel(rel));
    COMIC_IMAGE_EXTENSIONS.contains(&ext.as_str())
}

/// Fushi 的垃圾成员判据：macOS 资源叉与元数据目录（`pages.ts:57-62`）。
///
/// `pub(crate)` 是为了让 `extract::plan_entries` 也用**同一份**判据。
/// 两边各写一遍的后果实测过：macOS `bsdtar` 打的 `.cbt` 里含 `._p001.png`
/// AppleDouble 条目（`tar -tf` 会隐藏它们，但字节里真有），`probe` 过滤掉了、
/// `extract --images-only` 却把它们当页图写了盘。
pub(crate) fn is_junk_member(name: &str) -> bool {
    if name.split('/').any(|segment| segment == "__MACOSX") {
        return true;
    }
    let base = crate::paths::basename(name);
    base.starts_with("._") || base == ".DS_Store"
}

/// 从压缩包成员名里挑出页图。
///
/// 与 `collectArchivePages` 同口径：丢目录项、垃圾成员、OCR 产物目录，只留图片，
/// 再自然序排序。子目录里的图片**保留**（mokuro.moe 的卷 CBZ 把页图放在
/// `<卷名>/` 下，压成 basename 会让 `vol1/p001.jpg` 与 `vol2/p001.jpg` 撞车）。
pub fn collect_pages(names: &[String]) -> Vec<String> {
    let mut pages: Vec<String> = Vec::new();
    for raw in names {
        let rel = normalize_rel(raw);
        if rel.is_empty() || rel.ends_with('/') {
            continue;
        }
        if is_junk_member(&rel) {
            continue;
        }
        if rel.split('/').any(|segment| segment == MOKURO_OUT_DIR) {
            continue;
        }
        if !is_comic_image(&rel) {
            continue;
        }
        pages.push(rel);
    }
    sort_pages(&mut pages);
    pages
}

/// 就地自然序排序（路径级比较，不做目录优先）。
pub fn sort_pages(pages: &mut [String]) {
    pages.sort_by(|a, b| natural_compare(a, b));
}

/// 条目名是否是 EPUB 的判据：以 `.opf` 结尾（大小写不敏感）。
pub fn ends_with_opf(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".opf")
}

/// `kind` 判定：有 `.opf` → epub；否则有页图 → comic；否则 unknown。
/// 与 `native-protocol.ts` 的 `NativeArchiveKind` 共用一套语义。
pub fn archive_kind(names: &[String]) -> &'static str {
    if names.iter().any(|name| ends_with_opf(name)) {
        "epub"
    } else if names
        .iter()
        .any(|name| !name.ends_with('/') && is_comic_image(&normalize_rel(name)))
    {
        "comic"
    } else {
        "unknown"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_order_puts_p2_before_p10() {
        let mut pages = vec!["p10.jpg".to_string(), "p2.jpg".to_string(), "p1.jpg".to_string()];
        sort_pages(&mut pages);
        assert_eq!(pages, vec!["p1.jpg", "p2.jpg", "p10.jpg"]);
    }

    #[test]
    fn natural_order_is_a_total_order_on_zero_padding() {
        // 冻结口径：数值相等时位数少的在前（`p1.jpg` 在 `p001.jpg` 之前）。
        // 注意这与 `localeCompare({numeric:true})` 不同，后者判等会让页序抖动。
        assert_eq!(natural_compare("p1.jpg", "p001.jpg"), std::cmp::Ordering::Less);
        assert_eq!(natural_compare("p001.jpg", "p1.jpg"), std::cmp::Ordering::Greater);
        assert_eq!(natural_compare("p1.jpg", "p1.jpg"), std::cmp::Ordering::Equal);
        let mut pages = vec!["p001.jpg".to_string(), "p1.jpg".to_string()];
        sort_pages(&mut pages);
        assert_eq!(pages, vec!["p1.jpg", "p001.jpg"]);
    }

    #[test]
    fn natural_order_compares_whole_paths_not_basenames() {
        // 路径级比较：`a/2.jpg` 与 `a10/1.jpg` 的先后由整条路径决定。
        let mut pages = vec!["a/10.jpg".to_string(), "a/2.jpg".to_string(), "a/1.jpg".to_string()];
        sort_pages(&mut pages);
        assert_eq!(pages, vec!["a/1.jpg", "a/2.jpg", "a/10.jpg"]);
        // 数字段跨 '/' 不合并：`a1/b` 的数字段在 `a` 之后结束。
        assert_eq!(natural_compare("a1/b.jpg", "a1b.jpg"), std::cmp::Ordering::Less);
    }

    #[test]
    fn natural_order_is_case_insensitive_and_prefix_aware() {
        assert_eq!(natural_compare("A.jpg", "a.JPG"), std::cmp::Ordering::Equal);
        assert_eq!(natural_compare("ab", "abc"), std::cmp::Ordering::Less);
        assert_eq!(natural_compare("p2", "p2x"), std::cmp::Ordering::Less);
    }

    #[test]
    fn extension_filter_is_exactly_the_frozen_set() {
        for ext in COMIC_IMAGE_EXTENSIONS {
            assert!(is_comic_image(&format!("a/b{ext}")), "{ext} 必须被认成页图");
            assert!(is_comic_image(&format!("a/b{}", ext.to_uppercase())));
        }
        // Fushi BUG-1121 的反例：`.bmp` 必须在表里，不能被静默跳过。
        assert!(is_comic_image("a/scan.BMP"));
        assert!(!is_comic_image("a/b.jpg.txt"));
        assert!(!is_comic_image("a/b.txt"));
        assert!(!is_comic_image("a/b"));
        assert!(!is_comic_image("a/.jpg"));
    }

    #[test]
    fn collect_pages_drops_junk_and_out_dir_but_keeps_nesting() {
        let names: Vec<String> = [
            "__MACOSX/._p1.jpg",
            "images/p10.jpg",
            "images/p2.jpg",
            "images/p1.jpg",
            "notes.txt",
            "manga_ocr_out/p1.jpg",
            "sub/manga_ocr_out/p9.jpg",
            "vol1/p001.jpg",
            "dir/",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(
            collect_pages(&names),
            vec![
                "images/p1.jpg",
                "images/p2.jpg",
                "images/p10.jpg",
                "vol1/p001.jpg"
            ]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn kind_prefers_epub_when_opf_present() {
        let epub = vec!["OEBPS/content.opf".to_string(), "OEBPS/p1.jpg".to_string()];
        assert_eq!(archive_kind(&epub), "epub");
        let comic = vec!["p1.jpg".to_string(), "p2.jpg".to_string()];
        assert_eq!(archive_kind(&comic), "comic");
        let unknown = vec!["readme.txt".to_string(), "dir/".to_string()];
        assert_eq!(archive_kind(&unknown), "unknown");
        // 目录项里的 `.jpg` 不算页图。
        assert_eq!(archive_kind(&["fake.jpg/".to_string()]), "unknown");
        assert!(ends_with_opf("OEBPS/CONTENT.OPF"));
    }
}
