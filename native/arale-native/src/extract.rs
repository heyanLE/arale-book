//! 提取规划与编排 —— 「哪些条目能写」的判断只在这里做一次。
//!
//! 分两段：
//!   1. `plan_entries` —— 纯函数，只依赖 `EntryMeta`，把每个条目分类成
//!      「要写」/「跳过（附原因）」。所有安全判定（`..`、前缀、NUL）都在
//!      `OutputRoot::prepare` 里过一次，判定结果冻结进 `Planned.target`。
//!   2. `extract_archive` —— 按格式分发到 reader 落盘，再核对进度。
//!
//! 为什么分成两段：安全判定与 I/O 混在一起时，最容易出的错是「某个格式的
//! reader 忘了检查 `..`」。冻结成 `Planned` 之后，reader 拿到的是已经确认在
//! `--out` 之内的绝对路径，它没有机会绕过检查。

use std::path::Path;

use anyhow::Result;

use crate::archive::{reader_for, EntryMeta, Planned, Written};
use crate::format::{detect_from_path, Format};
use crate::out::{unique_rel, OutputRoot};
use crate::pages::is_comic_image;
use crate::paths::{contains_parent_segment, normalize_rel};

/// 规划结果。
#[derive(Debug, Default)]
pub struct Plan {
    /// 要写出的条目（按包内原始顺序，不是页序 —— 页序由主进程重新 `probe` 得到）。
    pub planned: Vec<Planned>,
    /// 被跳过的条目数。契约里的 `skipped` 就是它，含义见 `native-protocol.ts:65`
    /// ——「非页图 / 非法路径 / 超限」都算。
    pub skipped: u64,
}

/// 条目分类：`images_only` 时只有通过页图筛选的条目入选。
///
/// 注意 `--images-only` 与不带它时 `skipped` 的差异：不带时，`notes.txt` 会被写出，
/// 因此不计入 `skipped`；带时它被跳过，计入 `skipped`。契约把 `skipped` 定义成
/// 「没有写出的条目数」，两种模式共用这个含义。
pub fn plan_entries(entries: &[EntryMeta], out: &OutputRoot, images_only: bool) -> Plan {
    let mut plan = Plan::default();
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();

    for entry in entries {
        let rel = normalize_rel(&entry.name);

        // 目录项：创建目录不算「写出条目」，一律计入 skipped（与 Fushi
        // `_filesOf` 丢掉目录项同口径）。
        if entry.is_dir || rel.is_empty() || rel.ends_with('/') {
            plan.skipped += 1;
            continue;
        }
        // macOS 资源叉（`._*`）与 `__MACOSX/` 一律丢弃：它们会**通过扩展名判定**
        // （`._p001.png` 的扩展名就是 `.png`），不过滤的话会被当页图写盘、进而
        // 在书里多出四个「幽灵页」。判据与 `pages::collect_pages` 共用一份。
        if crate::pages::is_junk_member(&rel) {
            plan.skipped += 1;
            continue;
        }
        // `--images-only` 只写页图；其余（nfo/txt/封面清单）全部跳过。
        // 判据复用 `pages.rs` 的同一张扩展名表 —— 绝不在第二处手写扩展名列表
        // （Fushi BUG-1121）。
        if images_only && !is_comic_image(&rel) {
            plan.skipped += 1;
            continue;
        }
        if !entry.has_stream {
            plan.skipped += 1;
            continue;
        }

        // 硬红线：含 `..` 段直接拒绝，绝不给后面「先记下来再决定」的机会。
        //
        // 必须用**归一化之后**的 rel 判定，且不能加 `cfg(windows)` 前提：
        // `..\..\x.jpg` 在 Unix 上 `sanitize_rel_segments` 也会因为
        // `normalize_rel` 把 `\` 换成 `/` 而拒绝，这里提前挡掉是为了让
        // 「为什么跳过」的原因一目了然，并且不依赖净化实现不变。
        if contains_parent_segment(&rel) {
            plan.skipped += 1;
            continue;
        }

        let Some(prepared) = out.prepare(&entry.name) else {
            plan.skipped += 1;
            continue;
        };
        // 净化后可能与其他条目撞名（`a<b>.jpg` 与 `a_b_.jpg`）：按 Fushi
        // `uniqueDestRel` 的规则让步，而不是覆盖 —— 覆盖会悄悄丢页。
        let unique = unique_rel(&prepared.rel, &mut used);
        let target = if unique == prepared.rel {
            prepared.path
        } else {
            // 让步后的路径必须重新过一次 `prepare`（父目录、前缀、NUL 三关）。
            match out.prepare(&unique) {
                Some(next) => next.path,
                None => {
                    plan.skipped += 1;
                    continue;
                }
            }
        };
        plan.planned.push(Planned {
            entry: entry.name.clone(),
            rel: unique,
            target,
        });
    }
    plan
}

/// 实际提取：按内容判定格式 → 分发 → 返回每个条目的真实字节数。
///
/// 返回 `format` 也一并给出，因为「扩展名是 `.cbr`、内容是 zip」这种情况
/// `probe` 与 `extract` 必须报同一个格式。
#[derive(Debug)]
pub struct ExtractOutcome {
    pub format: Format,
    pub written: Vec<Written>,
    pub skipped: u64,
}

pub fn extract_archive(input: &Path, out: &OutputRoot, images_only: bool) -> Result<ExtractOutcome> {
    let format = detect_from_path(input);
    if format == Format::Unknown {
        anyhow::bail!(
            "无法识别的压缩包格式（既不是 zip、rar、7z 或 tar）：{}",
            input.display()
        );
    }
    let reader = reader_for(format);
    let entries = reader.list(input)?;
    let plan = plan_entries(&entries, out, images_only);
    let matched = plan.planned.len() as u64;
    let written = reader.extract(input, out, &plan.planned)?;
    // 计划里要写、实际却一条都没写出来：说明包结构与列表阶段不一致，
    // 必须报错而不是安静地返回「成功写了 0 个」。
    if matched > 0 && written.is_empty() {
        anyhow::bail!("压缩包结构在读取过程中发生变化，没有任何条目被写出：{}", input.display());
    }
    let skipped = plan.skipped + (matched - written.len() as u64);
    Ok(ExtractOutcome {
        format,
        written,
        skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(name: &str) -> EntryMeta {
        EntryMeta {
            name: name.to_string(),
            is_dir: name.ends_with('/'),
            has_stream: !name.ends_with('/'),
            size: 4,
        }
    }

    fn temp_out(tag: &str) -> (std::path::PathBuf, OutputRoot) {
        let dir = std::env::temp_dir().join(format!("fushi-plan-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        let out = OutputRoot::create(&dir).unwrap();
        (dir, out)
    }

    #[test]
    fn images_only_keeps_pages_and_counts_rest_as_skipped() {
        let (dir, out) = temp_out("img");
        let entries = vec![
            meta("vol1/p2.jpg"),
            meta("vol1/p10.jpg"),
            meta("notes.txt"),
            meta("dir/"),
        ];
        let plan = plan_entries(&entries, &out, true);
        assert_eq!(
            plan.planned.iter().map(|p| p.rel.as_str()).collect::<Vec<_>>(),
            vec!["vol1/p2.jpg", "vol1/p10.jpg"]
        );
        // notes.txt + 目录项 = 2
        assert_eq!(plan.skipped, 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn without_images_only_every_non_dir_entry_is_planned() {
        let (dir, out) = temp_out("all");
        let entries = vec![meta("vol1/p1.jpg"), meta("notes.txt"), meta("dir/")];
        let plan = plan_entries(&entries, &out, false);
        assert_eq!(plan.planned.len(), 2);
        assert_eq!(plan.skipped, 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parent_segments_are_skipped_not_written() {
        let (dir, out) = temp_out("escape");
        // 注意：不带 `--images-only` 时 `../escape.jpg` 也**必须**被跳过，
        // 因为它是路径安全问题，不是筛选问题。
        let entries = vec![
            meta("../escape.jpg"),
            meta("a/../../escape.jpg"),
            // 反斜杠变体：Unix 上 `\` 不是分隔符，但压缩包成员名里的 `\` 必须
            // 按分隔符处理，否则在 Windows 上会成为穿越。这条断言在三平台都必须过。
            meta("..\\escape.jpg"),
            meta("b\\..\\..\\escape.jpg"),
            meta("ok.jpg"),
        ];
        let plan = plan_entries(&entries, &out, false);
        assert_eq!(plan.planned.len(), 1);
        assert_eq!(plan.planned[0].rel, "ok.jpg");
        assert_eq!(plan.skipped, 4);
        assert!(!dir.join("../escape.jpg").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn colliding_sanitized_names_get_a_numeric_suffix() {
        let (dir, out) = temp_out("collide");
        let entries = vec![meta("a<b>.jpg"), meta("a_b_.jpg")];
        let plan = plan_entries(&entries, &out, true);
        let rels: Vec<&str> = plan.planned.iter().map(|p| p.rel.as_str()).collect();
        assert_eq!(rels, vec!["a_b_.jpg", "a_b_ (2).jpg"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unknown_format_fails_cleanly() {
        let dir = std::env::temp_dir().join(format!("fushi-unk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bogus = dir.join("x.cbr");
        std::fs::write(&bogus, b"not an archive").unwrap();
        let out = OutputRoot::create(&dir.join("out")).unwrap();
        let err = extract_archive(&bogus, &out, true).unwrap_err();
        assert!(err.to_string().contains("无法识别"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
