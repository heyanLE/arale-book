//! `arale-native` —— aralebook 的原生解包 sidecar。
//!
//! 职责边界（见 `src/shared/native-protocol.ts`，那是冻结契约）：
//!   - `.rar/.cbr/.7z/.cb7` 的探测与流式解包（`.zip/.cbz` 走 JS 侧的 fflate，不要经过这里）；
//!   - stdout **有且只有一个 JSON 对象**（外加一个换行）；所有日志/诊断走 stderr；
//!   - 退出码：`0` 成功、`1` 已处理的失败（stdout 仍是 `ok:false` 的合法 JSON）、
//!     `2` 用法错误。
//!
//! 「绝不 panic」是硬要求：坏输入只能变成 `ok:false` + `error`。除了各层的
//! `Result` 传播以外，`main` 还兜一层 `catch_unwind`，把任何漏网的 panic
//! （包括依赖库内部的）也变成合法的 JSON 输出。

mod archive;
mod cli;
mod extract;
mod format;
mod out;
mod pages;
mod paths;
#[cfg(test)]
mod testsupport;

use std::path::Path;
use std::process::ExitCode;

use serde::Serialize;

use cli::Command;
use format::{detect_from_path, Format};
use out::OutputRoot;

/// sidecar 协议版本。改动 stdout JSON 结构时**必须**同时改 `native-protocol.ts`
/// 并提升它 —— 主进程可以据此拒绝一个版本不匹配的旧二进制。
const PROTOCOL_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 退出码 0：成功。
const EXIT_OK: u8 = 0;
/// 退出码 1：已处理的失败（stdout 仍是合法 JSON）。
const EXIT_HANDLED: u8 = 1;
/// 退出码 2：用法错误。
const EXIT_USAGE: u8 = 2;

/// `version` 的输出。
#[derive(Serialize)]
struct VersionOutput {
    ok: bool,
    /// sidecar 协议版本（= crate 版本）。
    version: &'static str,
    /// 编译目标平台，用于诊断「二进制是不是给错平台了」。
    target: &'static str,
    error: Option<String>,
}

/// `probe` 最多回报多少个成员名。够判定套娃包，又不至于把 stdout 撑爆。
const MAX_ENTRIES_IN_PROBE: usize = 2000;

/// `probe` 的输出。字段名与 `NativeProbeResult` 一一对应。
#[derive(Serialize)]
struct ProbeOutput {
    ok: bool,
    format: Format,
    kind: &'static str,
    #[serde(rename = "entryCount")]
    entry_count: usize,
    #[serde(rename = "imageCount")]
    image_count: usize,
    pages: Vec<String>,
    /// 全部成员名（已正斜杠归一化，**不含目录项**）。
    ///
    /// 为什么 probe 要吐这个：调用方需要判断「这是一个**套娃包**」——
    /// 里面装的是分卷压缩包而不是页图。只给 `pages` 的话，一套分卷会被判成
    /// `kind: unknown` 然后报「没有任何图片页」，而正确行为是把每个分卷各导入成一本。
    ///
    /// 有上限（见 [MAX_ENTRIES_IN_PROBE]）：一个病态的包可能有几十万条目，
    /// 全塞进 JSON 会把 stdout 撑爆，而判定「有没有压缩包成员」只需要看前若干个。
    entries: Vec<String>,
    #[serde(rename = "hasOpf")]
    has_opf: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// `extract` 的输出。字段名与 `NativeExtractResult` 一一对应。
#[derive(Serialize)]
struct ExtractOutput {
    ok: bool,
    format: Format,
    extracted: Vec<ExtractedEntry>,
    skipped: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct ExtractedEntry {
    entry: String,
    rel: String,
    bytes: u64,
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // 用法错误：stdout 也给合法 JSON（`ok:false`），但退出码是 2，用法文案走 stderr。
    let Some(command) = cli::parse(&args) else {
        eprintln!("{}", cli::USAGE);
        // 形状刻意选 `NativeExtractResult`（三个结果类型里的最小公倍数，
        // 只多一个空 `extracted`），主进程靠退出码 2 区分「用法错误」。
        let payload = ExtractOutput {
            ok: false,
            format: Format::Unknown,
            extracted: Vec::new(),
            skipped: 0,
            error: Some("用法错误：未知子命令或缺少必需的 flag".to_string()),
        };
        emit(&payload);
        return ExitCode::from(EXIT_USAGE);
    };

    // 兜底：任何漏网的 panic 也要变成合法 JSON，而不是把 backtrace 打到 stdout。
    // 默认 panic hook 仍然会把详情写进 stderr，便于排查。
    match std::panic::catch_unwind(|| run(command)) {
        Ok(code) => ExitCode::from(code),
        Err(_) => {
            let payload = ExtractOutput {
                ok: false,
                format: Format::Unknown,
                extracted: Vec::new(),
                skipped: 0,
                error: Some("内部错误：原生层发生 panic（详见 stderr）".to_string()),
            };
            emit(&payload);
            ExitCode::from(EXIT_HANDLED)
        }
    }
}

/// 执行命令，返回进程退出码。
fn run(command: Command) -> u8 {
    match command {
        Command::Version => {
            emit(&VersionOutput {
                ok: true,
                version: PROTOCOL_VERSION,
                target: std::env::consts::OS,
                error: None,
            });
            EXIT_OK
        }
        Command::Probe { input } => {
            let result = probe(Path::new(&input));
            let code = if result.ok { EXIT_OK } else { EXIT_HANDLED };
            emit(&result);
            code
        }
        Command::Extract {
            input,
            out,
            images_only,
        } => {
            let result = extract(Path::new(&input), Path::new(&out), images_only);
            let code = if result.ok { EXIT_OK } else { EXIT_HANDLED };
            emit(&result);
            code
        }
    }
}

/// 探测一个压缩包。**任何失败都返回 `ok:false` 的结构，不 panic、不早退。**
fn probe(input: &Path) -> ProbeOutput {
    // 路径层面的失败先给明确文案：主进程传了相对路径或文件不存在时，
    // 「不是压缩包」会误导排查方向。
    if !input.is_file() {
        return ProbeOutput {
            ok: false,
            entries: Vec::new(),
            format: Format::Unknown,
            kind: "unknown",
            entry_count: 0,
            image_count: 0,
            pages: Vec::new(),
            has_opf: false,
            error: Some(format!("输入文件不存在或不是普通文件：{}", input.display())),
        };
    }
    let format = detect_from_path(input);
    if format == Format::Unknown {
        return ProbeOutput {
            ok: false,
            entries: Vec::new(),
            format,
            kind: "unknown",
            entry_count: 0,
            image_count: 0,
            pages: Vec::new(),
            has_opf: false,
            error: Some(format!(
                "无法识别的压缩包格式（既不是 zip、rar、7z 或 tar）：{}",
                input.display()
            )),
        };
    }

    match archive::reader_for(format).list(input) {
        Ok(entries) => {
            // `entryCount` 不含目录项（契约 `native-protocol.ts:37`）。
            let names: Vec<String> = entries
                .iter()
                .filter(|entry| !entry.is_dir)
                .map(|entry| paths::normalize_rel(&entry.name))
                .collect();
            let entry_count = names.len();
            let kind = pages::archive_kind(&names);
            let has_opf = names.iter().any(|name| pages::ends_with_opf(name));
            // epub 的 pages 恒为空：EPUB 的页序由 OPF spine 决定，压缩包内的
            // 文件名字典序与阅读顺序无关，给出来只会误导主进程。
            let page_list = if kind == "epub" {
                Vec::new()
            } else {
                pages::collect_pages(&names)
            };
            // 前 N 个成员名（`names` 已是正斜杠归一化的非目录项）。截断了也不影响
            // 「套娃包」判定：分卷压缩包只有个位数个成员。
            let entries: Vec<String> = names.iter().take(MAX_ENTRIES_IN_PROBE).cloned().collect();
            ProbeOutput {
                ok: true,
                format,
                kind,
                entry_count,
                image_count: page_list.len(),
                pages: page_list,
                entries,
                has_opf,
                error: None,
            }
        }
        Err(error) => ProbeOutput {
            ok: false,
            entries: Vec::new(),
            format,
            kind: "unknown",
            entry_count: 0,
            image_count: 0,
            pages: Vec::new(),
            has_opf: false,
            // `anyhow` 的 `{:#}` 会把 context 链拼成一行，正好是「给人看」的文案。
            error: Some(format!("{error:#}")),
        },
    }
}

/// 解包一个压缩包。
fn extract(input: &Path, out: &Path, images_only: bool) -> ExtractOutput {
    if !input.is_file() {
        return ExtractOutput {
            ok: false,
            format: Format::Unknown,
            extracted: Vec::new(),
            skipped: 0,
            error: Some(format!("输入文件不存在或不是普通文件：{}", input.display())),
        };
    }
    let format = detect_from_path(input);
    // `--out` 先建好，否则无法 canonicalize，前缀断言就无从谈起。
    let root = match OutputRoot::create(out) {
        Ok(root) => root,
        Err(error) => {
            return ExtractOutput {
                ok: false,
                format,
                extracted: Vec::new(),
                skipped: 0,
                error: Some(format!("{error:#}")),
            }
        }
    };

    match extract::extract_archive(input, &root, images_only) {
        Ok(outcome) => ExtractOutput {
            ok: true,
            format: outcome.format,
            extracted: outcome
                .written
                .iter()
                .map(|item| ExtractedEntry {
                    entry: item.entry.clone(),
                    rel: item.rel.clone(),
                    bytes: item.bytes,
                })
                .collect(),
            skipped: outcome.skipped,
            error: None,
        },
        Err(error) => ExtractOutput {
            ok: false,
            format,
            extracted: Vec::new(),
            skipped: 0,
            error: Some(format!("{error:#}")),
        },
    }
}

/// 把结果写成**一行 JSON + 换行**到 stdout。
///
/// 序列化理论上不会失败（全是 plain struct / String / u64）；万一失败也不能把
/// 半截 JSON 留给 `JSON.parse`，所以退化成一条手写的失败对象。
fn emit<T: Serialize>(payload: &T) {
    match serde_json::to_string(payload) {
        Ok(json) => println!("{json}"),
        Err(error) => {
            eprintln!("arale-native: 序列化输出失败：{error}");
            println!(
                "{{\"ok\":false,\"format\":\"unknown\",\"extracted\":[],\"skipped\":0,\
                 \"error\":\"原生层内部错误：无法序列化结果\"}}"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 端到端：`probe` + `extract` 走真实 zip（内含 `../` 穿越条目）。
    #[test]
    fn probe_and_extract_end_to_end() {
        let dir = std::env::temp_dir().join(format!("fushi-main-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("book.cbr");
        // 手写 zip：`zip` crate 的 writer 会悄悄吃掉 `../` 段，造不出真实恶意条目。
        testsupport::write_raw_zip(
            &archive,
            &[
                ("vol1/p1.jpg", b"one"),
                ("vol1/p10.jpg", b"ten"),
                ("vol1/p2.jpg", b"two"),
                ("../escape.jpg", b"bad"),
                ("readme.txt", b"text"),
            ],
        )
        .unwrap();

        // 内容判定：扩展名是 .cbr，内容其实是 zip，必须报 zip。
        let probed = probe(&archive);
        assert!(probed.ok, "{:?}", probed.error);
        assert_eq!(probed.format, Format::Zip);
        assert_eq!(probed.kind, "comic");
        assert_eq!(probed.entry_count, 5);
        // `../escape.jpg` 在这里**仍是**一张「页图」（`collect_pages` 只看名字，
        // 与 `pages.ts` 的 `collectArchivePages` 同口径）；挡住它的是提取阶段的
        // 路径安全关，不是页图筛选。这个区分很重要：少算一张会让主进程以为
        // 包里的页数比实际少。
        assert_eq!(probed.image_count, 4);
        assert_eq!(
            probed.pages,
            vec![
                "../escape.jpg",
                "vol1/p1.jpg",
                "vol1/p2.jpg",
                "vol1/p10.jpg"
            ]
        );
        assert!(!probed.has_opf);
        // `entries` 是**全部**成员名（非目录项），仍在包内原始顺序，不排序——
        // 它服务的是「这里装的是不是分卷压缩包」这个判定，不是页序。
        // 与 `pages`（自然序、只留页图）刻意不同。
        assert_eq!(
            probed.entries,
            vec![
                "vol1/p1.jpg",
                "vol1/p10.jpg",
                "vol1/p2.jpg",
                "../escape.jpg",
                "readme.txt",
            ]
        );

        let out = dir.join("out");
        let result = extract(&archive, &out, true);
        assert!(result.ok, "extract 必须成功：{:?}", result.error);
        assert_eq!(result.format, Format::Zip);
        assert_eq!(result.extracted.len(), 3);
        // readme.txt 与 ../escape.jpg 都该被跳过。
        assert_eq!(result.skipped, 2, "readme.txt 与 ../escape.jpg 都该被跳过");
        assert!(out.join("vol1/p2.jpg").is_file());
        assert!(!out.join("../escape.jpg").exists());
        // 落盘的内容必须正确（不是空文件）。
        assert_eq!(std::fs::read(out.join("vol1/p10.jpg")).unwrap(), b"ten");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `probe.entries` 必须有上限：病态压缩包可能有几十万条目，
    /// 全塞进 stdout 会把 JSON 撑爆，而判定套娃包只需要看前若干个。
    #[test]
    fn probe_entries_is_capped() {
        let dir = std::env::temp_dir().join(format!("fushi-cap-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("huge.cbz");

        // 上限 + 若干，确认截断发生在正确的位置。
        let owned: Vec<String> = (0..MAX_ENTRIES_IN_PROBE + 50)
            .map(|index| format!("p{:06}.jpg", index))
            .collect();
        let refs: Vec<(&str, &[u8])> = owned
            .iter()
            .map(|name| (name.as_str(), b"x" as &[u8]))
            .collect();
        testsupport::write_raw_zip(&archive, &refs).unwrap();

        let probed = probe(&archive);
        assert!(probed.ok, "{:?}", probed.error);
        assert_eq!(probed.entry_count, MAX_ENTRIES_IN_PROBE + 50, "计数是真实的，不受截断影响");
        assert_eq!(probed.entries.len(), MAX_ENTRIES_IN_PROBE, "成员名列表必须被截断");
        assert_eq!(probed.image_count, MAX_ENTRIES_IN_PROBE + 50);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 坏的 / 不存在的输入必须产生 `ok:false`，而不是 panic。
    #[test]
    fn bad_inputs_never_panic() {
        let dir = std::env::temp_dir().join(format!("fushi-mainbad-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        // 不存在的路径。
        assert!(!probe(&dir.join("missing.cbr")).ok);
        assert!(!extract(&dir.join("missing.cbr"), &dir.join("out"), true).ok);

        let garbage = dir.join("garbage.7z");
        std::fs::write(&garbage, b"\x00\x01\x02\x03 not an archive").unwrap();
        let probed = probe(&garbage);
        assert!(!probed.ok);
        assert!(probed.error.is_some());
        let result = extract(&garbage, &dir.join("out"), true);
        assert!(!result.ok);

        // 空文件（0 字节）不能被当成某个格式，也不许 panic。
        let empty = dir.join("empty.rar");
        std::fs::write(&empty, b"").unwrap();
        let probed = probe(&empty);
        assert!(!probed.ok);
        assert_eq!(probed.format, Format::Unknown);
        std::fs::remove_dir_all(&dir).ok();
    }
}
