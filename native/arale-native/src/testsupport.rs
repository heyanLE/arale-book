//! 测试辅助：手写 ZIP 容器。
//!
//! 为什么不用 `zip` crate 的 writer 造夹具：它的 `path_to_string` 会**悄悄**
//! `pop()` 掉 `..` 段（`zip-2.4.2/src/unstable.rs:110`），所以用 writer 造不出
//! `../escape.jpg` 这种条目 —— 而「含 `..` 的成员必须被跳过」正是本层最需要
//! 被证明的安全属性。手写容器是唯一能造出真实恶意条目的办法。
//!
//! 只写 STORED（不压缩）条目。CRC32 必须写对：`zip` crate 的 reader 对所有条目
//! 都套了 `Crc32Reader`（`zip-2.4.2/src/read.rs:444`），CRC 填 0 会直接报
//! `Invalid checksum`。所以这里带一个 20 行的标准 CRC32（多项式 0xEDB88320）。

/// 标准 CRC32（IEEE），与 `zip`/`zlib` 同口径。
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc ^= *byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// 手写一个 zip 文件，返回字节。
///
/// 结构参考 APPNOTE：每条一个 Local File Header + 数据，最后是 Central
/// Directory 与 End Of Central Directory。签名与字段宽度都按规范写死。
pub fn raw_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    // 每条目的中央目录记录偏移，最后写进 EOCD。
    let mut offsets: Vec<u32> = Vec::new();

    for (name, data) in entries {
        let name_bytes = name.as_bytes();
        let size = data.len() as u32;
        let crc = crc32(data);
        offsets.push(out.len() as u32);

        // ---- Local File Header ----
        out.extend_from_slice(b"PK\x03\x04");
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0x0800u16.to_le_bytes()); // flags: UTF-8 名字
        out.extend_from_slice(&0u16.to_le_bytes()); // method: stored
        out.extend_from_slice(&0u16.to_le_bytes()); // mod time
        out.extend_from_slice(&0u16.to_le_bytes()); // mod date
        out.extend_from_slice(&crc.to_le_bytes()); // crc32
        out.extend_from_slice(&size.to_le_bytes()); // compressed size
        out.extend_from_slice(&size.to_le_bytes()); // uncompressed size
        out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra len
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(data);

        // ---- Central Directory Header ----
        central.extend_from_slice(b"PK\x01\x02");
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central.extend_from_slice(&0x0800u16.to_le_bytes()); // flags
        central.extend_from_slice(&0u16.to_le_bytes()); // method
        central.extend_from_slice(&0u16.to_le_bytes()); // time
        central.extend_from_slice(&0u16.to_le_bytes()); // date
        central.extend_from_slice(&crc.to_le_bytes()); // crc32
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra
        central.extend_from_slice(&0u16.to_le_bytes()); // comment
        central.extend_from_slice(&0u16.to_le_bytes()); // disk number
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central.extend_from_slice(&offsets[offsets.len() - 1].to_le_bytes());
        central.extend_from_slice(name_bytes);
    }

    let central_offset = out.len() as u32;
    let central_size = central.len() as u32;
    out.extend_from_slice(&central);

    // ---- End Of Central Directory ----
    out.extend_from_slice(b"PK\x05\x06");
    out.extend_from_slice(&0u16.to_le_bytes()); // disk number
    out.extend_from_slice(&0u16.to_le_bytes()); // central dir disk
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes()); // 本盘条目数
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes()); // 总条目数
    out.extend_from_slice(&central_size.to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment len
    out
}

/// 把夹具写到磁盘，返回路径。
pub fn write_raw_zip(path: &std::path::Path, entries: &[(&str, &[u8])]) -> std::io::Result<()> {
    std::fs::write(path, raw_zip(entries))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_zip_is_readable_by_the_zip_crate() {
        let dir = std::env::temp_dir().join(format!("fushi-testsup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sup.zip");
        write_raw_zip(
            &path,
            &[("vol1/p1.jpg", b"one"), ("../escape.jpg", b"bad")],
        )
        .unwrap();

        let file = std::fs::File::open(&path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        // 关键：`../escape.jpg` 必须**原样**保留，不被任何一层悄悄改写。
        assert_eq!(names, vec!["vol1/p1.jpg", "../escape.jpg"]);
        std::fs::remove_dir_all(&dir).ok();
    }
}
