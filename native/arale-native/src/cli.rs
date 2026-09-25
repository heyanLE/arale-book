//! CLI 参数解析 —— 手写不引第三方，因为契约只有三个子命令、四个开关。
//!
//! 用法错误（未知子命令 / 缺 flag）返回 `None`，调用方输出用法文案到 **stderr**、
//! 给 stdout 一个 `ok:false` 的 JSON、以退出码 `2` 退出（见 `native-protocol.ts:21`）。
//! 这样 Node 侧不需要解析 stderr 文案就能区分「用法错误」与「已处理的失败」。

/// 解析后的命令。
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    /// 打印协议版本（给主进程做 sidecar 可用性探测）。
    Version,
    Probe {
        input: String,
    },
    Extract {
        input: String,
        out: String,
        images_only: bool,
    },
}

/// 用法文案（stderr）。
pub const USAGE: &str = "\
arale-native — aralebook 原生解包 sidecar

用法:
  arale-native version
  arale-native probe   --input <abs-path>
  arale-native extract --input <abs-path> --out <abs-dir> [--images-only]

退出码:
  0  成功
  1  已处理的失败（stdout 仍是合法 JSON 且 ok:false）
  2  用法错误";

/// 支持 `--flag value` 与 `--flag=value` 两种写法（Electron 侧两种都可能拼出来）。
fn take_value(args: &[String], i: &mut usize, flag: &str) -> Option<String> {
    let current = args.get(*i)?;
    if let Some(rest) = current.strip_prefix(&format!("{flag}=")) {
        return Some(rest.to_string());
    }
    if current == flag {
        *i += 1;
        return args.get(*i).cloned();
    }
    None
}

/// 解析 `argv[1..]`。返回 `None` 表示用法错误。
pub fn parse(args: &[String]) -> Option<Command> {
    let first = args.first()?;
    match first.as_str() {
        "version" | "--version" | "-V" => {
            // `version` 不吃任何参数；多给就是用法错误，别静默忽略。
            if args.len() > 1 {
                return None;
            }
            Some(Command::Version)
        }
        "probe" => {
            let mut input: Option<String> = None;
            let mut i = 1;
            while i < args.len() {
                // `take_value` 成功时会把 `i` 推到值上，所以消费完必须 `continue`
                // 走下一轮，不能再 `i += 1` —— 否则会跳过紧跟其后的另一个 flag。
                if let Some(value) = take_value(args, &mut i, "--input") {
                    input = Some(value);
                } else {
                    return None;
                }
                i += 1;
            }
            Some(Command::Probe { input: input? })
        }
        "extract" => {
            let mut input: Option<String> = None;
            let mut out: Option<String> = None;
            let mut images_only = false;
            let mut i = 1;
            while i < args.len() {
                // 顺序即优先级：先试 `--input`，再试 `--out`，最后才看 `--images-only`。
                // 每一支都用 `if ... } else if` 串起来，消费掉 flag（`take_value` 会把
                // `i` 推到值上）后统一 `i += 1`。
                if let Some(value) = take_value(args, &mut i, "--input") {
                    input = Some(value);
                } else if let Some(value) = take_value(args, &mut i, "--out") {
                    out = Some(value);
                } else if flag_at(args, i, "--images-only") {
                    images_only = true;
                } else {
                    return None;
                }
                i += 1;
            }
            Some(Command::Extract {
                input: input?,
                out: out?,
                images_only,
            })
        }
        _ => None,
    }
}

/// 取第 `i` 个参数并与 `flag` 比较。越界返回 `false` 而不是 panic ——
/// `take_value` 会把 `i` 推到 `args.len()`（悬空 flag），此时 `args[i]` 会崩。
fn flag_at(args: &[String], i: usize, flag: &str) -> bool {
    args.get(i).is_some_and(|value| value == flag)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_version() {
        assert_eq!(parse(&argv(&["version"])), Some(Command::Version));
        assert_eq!(parse(&argv(&["--version"])), Some(Command::Version));
        assert_eq!(parse(&argv(&["version", "extra"])), None);
    }

    #[test]
    fn parses_probe() {
        assert_eq!(
            parse(&argv(&["probe", "--input", "/tmp/a.cbr"])),
            Some(Command::Probe {
                input: "/tmp/a.cbr".to_string()
            })
        );
        assert_eq!(
            parse(&argv(&["probe", "--input=/tmp/a.cbr"])),
            Some(Command::Probe {
                input: "/tmp/a.cbr".to_string()
            })
        );
    }

    #[test]
    fn parses_extract_with_optional_images_only() {
        assert_eq!(
            parse(&argv(&["extract", "--input", "/a.7z", "--out", "/o"])),
            Some(Command::Extract {
                input: "/a.7z".to_string(),
                out: "/o".to_string(),
                images_only: false
            })
        );
        assert_eq!(
            parse(&argv(&["extract", "--images-only", "--out", "/o", "--input", "/a.7z"])),
            Some(Command::Extract {
                input: "/a.7z".to_string(),
                out: "/o".to_string(),
                images_only: true
            })
        );
    }

    #[test]
    fn rejects_usage_errors() {
        assert_eq!(parse(&argv(&[])), None);
        assert_eq!(parse(&argv(&["frobnicate"])), None);
        assert_eq!(parse(&argv(&["probe"])), None);
        assert_eq!(parse(&argv(&["probe", "--input"])), None);
        assert_eq!(parse(&argv(&["extract", "--input", "/a"])), None);
        assert_eq!(parse(&argv(&["extract", "--input", "/a", "--out"])), None);
        assert_eq!(parse(&argv(&["extract", "--input", "/a", "--out", "/o", "--bogus"])), None);
    }
}
