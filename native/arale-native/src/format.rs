//! 压缩包格式判定 —— **只看内容，不看扩展名**。
//!
//! 为什么必须按 magic bytes 判定：用户的漫画库里 `.cbr` 里装 zip、`.cbz` 里装 rar
//! 是常态（发布者重命名、转换工具写错扩展名）。Fushi 的 `manga_archive_importer.dart`
//! 按扩展名分流到 7-Zip，于是这类文件会被 7z 用错误的解包器打开，运气好是报错，
//! 运气不好是解出空目录。这里改成内容判定，扩展名只当提示。

use serde::Serialize;

/// 压缩包格式。与 `native-protocol.ts` 的 `NativeArchiveFormat` 一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Zip,
    Rar,
    #[serde(rename = "7z")]
    SevenZ,
    Tar,
    Unknown,
}

impl Format {
    /// 从文件头部字节判定格式。传入不足 8 字节也算合法输入（返回 `Unknown`）。
    pub fn detect(head: &[u8]) -> Format {
        // RAR5：`Rar!\x1a\x07\x01\x00`（8 字节，多出的 \x00 用于与 RAR4 区分）
        if head.starts_with(b"Rar!\x1a\x07\x01\x00") || head.starts_with(b"Rar!\x1a\x07\x01") {
            return Format::Rar;
        }
        // RAR4：`Rar!\x1a\x07\x00`
        if head.starts_with(b"Rar!\x1a\x07\x00") {
            return Format::Rar;
        }
        // 7z：`7z\xbc\xaf\x27\x1c`
        if head.starts_with(b"7z\xbc\xaf\x27\x1c") {
            return Format::SevenZ;
        }
        // ZIP：本地文件头 / 空包中央目录 / 分卷包。`PK\x03\x04` 之外还要认后两种，
        // 否则「没有条目的 zip」会被判成 unknown 而报「不是压缩包」。
        if head.starts_with(b"PK\x03\x04")
            || head.starts_with(b"PK\x05\x06")
            || head.starts_with(b"PK\x07\x08")
        {
            return Format::Zip;
        }
        // TAR（`.cbt`）：magic `ustar` 在**偏移 257**，所以判定需要 512 字节的头部。
        // 只要 ustar —— 上古 v7 tar 没有 magic，硬认会把任意二进制误判成 tar。
        if head.len() >= 262 && &head[257..262] == b"ustar" {
            return Format::Tar;
        }
        Format::Unknown
    }
}

/// 读文件头若干字节用于判定。文件不存在 / 读不动时返回 `None`（调用方给 `Unknown`）。
pub fn detect_from_path(path: &std::path::Path) -> Format {
    use std::io::Read;
    // 512 字节：tar 的 `ustar` magic 在偏移 257，8 字节不够。
    let mut head = [0u8; 512];
    let Ok(mut file) = std::fs::File::open(path) else {
        return Format::Unknown;
    };
    match file.read(&mut head) {
        Ok(n) => Format::detect(&head[..n]),
        Err(_) => Format::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_zip_magic() {
        assert_eq!(Format::detect(b"PK\x03\x04rest"), Format::Zip);
        // 空 zip（只有中央目录结束记录）也必须认出来。
        assert_eq!(Format::detect(b"PK\x05\x06\x00\x00"), Format::Zip);
        assert_eq!(Format::detect(b"PK\x07\x08"), Format::Zip);
    }

    #[test]
    fn detects_rar4_and_rar5() {
        assert_eq!(Format::detect(b"Rar!\x1a\x07\x00"), Format::Rar);
        assert_eq!(Format::detect(b"Rar!\x1a\x07\x01\x00"), Format::Rar);
    }

    #[test]
    fn detects_7z() {
        assert_eq!(Format::detect(b"7z\xbc\xaf\x27\x1c\x00\x04"), Format::SevenZ);
    }

    #[test]
    fn rejects_everything_else_without_panicking() {
        assert_eq!(Format::detect(b""), Format::Unknown);
        assert_eq!(Format::detect(b"PK"), Format::Unknown);
        assert_eq!(Format::detect(b"not an archive"), Format::Unknown);
        // 单字节 / 截断头不能 panic。
        assert_eq!(Format::detect(b"R"), Format::Unknown);
        assert_eq!(Format::detect(b"7z\xbc"), Format::Unknown);
    }

    #[test]
    fn content_wins_over_extension() {
        // 用临时文件验证「读内容而不是看扩展名」。
        let dir = std::env::temp_dir().join(format!("arale-fmt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake_cbr = dir.join("really-a-zip.cbr");
        std::fs::write(&fake_cbr, b"PK\x03\x04\x14\x00\x00\x00").unwrap();
        assert_eq!(detect_from_path(&fake_cbr), Format::Zip);
        let fake_cbz = dir.join("really-a-rar.cbz");
        std::fs::write(&fake_cbz, b"Rar!\x1a\x07\x01\x00").unwrap();
        assert_eq!(detect_from_path(&fake_cbz), Format::Rar);
        assert_eq!(detect_from_path(&dir.join("missing.rar")), Format::Unknown);
        std::fs::remove_dir_all(&dir).ok();
    }
}
