//! 归档读取的统一抽象 —— 四种格式（zip/rar/7z/tar）实现同一组语义，`extract` 逻辑
//! 只写一遍。
//!
//! 设计要点：
//!   - **流式**：`extract` 拿到的是「计划要写的条目」，读取器负责把条目内容流式
//!     写到目标路径。zip 用 `io::copy`，rar 用官方 UnRAR 的 `RARProcessFile` 直接
//!     落盘，7z 用 `SevenZReader` 的流式 reader。任何一条路径都不把整包读进内存 ——
//!     一个 2 GB 的 CBZ 不能要求 2 GB 常驻内存（这正是引入原生层的理由之一）。
//!   - **列表阶段不碰内容**：zip 读中央目录、rar 读 header 后 skip、7z 读头部信息，
//!     所以 `probe` 对一个大包也是秒回。

pub mod rar;
pub mod sevenz;
pub mod tar;
pub mod zip;

use std::path::Path;

use anyhow::Result;

use crate::out::OutputRoot;

/// 包内一个条目（不含内容）。所有 reader 的 `list()` 都返回这个。
#[derive(Debug, Clone)]
pub struct EntryMeta {
    /// 包内原始名（正斜杠归一化后）。
    pub name: String,
    /// 是否为目录项（目录项不计入 `entryCount`，也不参与页图筛选）。
    pub is_dir: bool,
    /// 该条目是否真的带数据流（有些格式有「只有元数据」的条目）。
    pub has_stream: bool,
    /// 声明的大小；仅用于诊断（`EntryMeta` 是纯数据，读不读取决于格式实现），
    /// 实际写出的字节数以真实读取为准 —— 也正因如此它不参与任何判定。
    #[allow(dead_code)]
    pub size: u64,
}

/// 要写出的一个条目。
///
/// `target` 在**规划阶段**就算好（净化 + 前缀断言 + 建父目录）并冻结在这里，
/// 读取阶段只管往这个路径写。这样「安全判定」只有一处，读取器不可能绕过它去
/// 自己拼路径。
#[derive(Debug, Clone)]
pub struct Planned {
    /// 包内原始名，用于按名回查（`extracted[].entry`）。
    pub entry: String,
    /// 落盘后的正斜杠相对路径（已 sanitize 且已去重，可能与 entry 不同）。
    pub rel: String,
    /// 已确认在 `--out` 之内的绝对路径。
    pub target: std::path::PathBuf,
}

/// 归档读取器：四种格式各实现一次，`main` 只按内容判定的格式分发。
pub trait ArchiveReader {
    /// 列出全部条目（不解析内容）。
    fn list(&self, input: &Path) -> Result<Vec<EntryMeta>>;

    /// 把 `plan` 里的条目流式写出到 `out`，跳过其余。
    ///
    /// 为什么返回「实际写出的条目」而不是复用 `plan`：目录项、重复路径、以及
    /// 为了省内存而边读边算的真实字节数都发生在这一层，调用方需要一个诚实的
    /// `bytes`（`native-protocol.ts` 的 `extracted[].bytes`）。
    fn extract(&self, input: &Path, out: &OutputRoot, plan: &[Planned]) -> Result<Vec<Written>>;
}

/// 已写出的条目。
#[derive(Debug, Clone)]
pub struct Written {
    pub entry: String,
    pub rel: String,
    pub bytes: u64,
}

/// 按格式分发到具体的 reader。
pub fn reader_for(format: crate::format::Format) -> Box<dyn ArchiveReader> {
    match format {
        crate::format::Format::Zip => Box::new(zip::ZipReader),
        crate::format::Format::Rar => Box::new(rar::RarReader),
        crate::format::Format::SevenZ => Box::new(sevenz::SevenZReader),
        crate::format::Format::Tar => Box::new(tar::TarReader),
        // `unknown` 在调用方就被挡掉了；真到这里只能给一个必然失败的 reader。
        crate::format::Format::Unknown => Box::new(UnknownReader),
    }
}

/// 认不出的格式：`list` 返回空，`extract` 直接报错。
pub struct UnknownReader;

impl ArchiveReader for UnknownReader {
    fn list(&self, _input: &Path) -> Result<Vec<EntryMeta>> {
        Ok(Vec::new())
    }

    fn extract(&self, _input: &Path, _out: &OutputRoot, _plan: &[Planned]) -> Result<Vec<Written>> {
        anyhow::bail!("无法识别的压缩包格式")
    }
}
