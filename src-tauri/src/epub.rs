//! Filesystem half of EPUB import. The existing pure TypeScript parser owns book semantics.
use crate::storage::{self, Backend};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Read, path::Path};

const MAX_MEMBER: u64 = 256 * 1024 * 1024;
const MAX_TOTAL: u64 = 2 * 1024 * 1024 * 1024;
const MAX_TEXT: usize = 64 * 1024 * 1024;
const READER_BRIDGE: &str = include_str!(concat!(env!("OUT_DIR"), "/reader-bridge.js"));
const URL_SEGMENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'.')
    .remove(b'-')
    .remove(b'_')
    .remove(b'~');

fn pending(backend: &Backend, id: &str) -> Result<std::path::PathBuf> {
    if !storage::valid_id(id)?.starts_with("bk_") {
        bail!("无效的 EPUB 导入 ID");
    }
    Ok(backend.root.join("epub-imports").join(id))
}
fn relative(name: &str) -> Result<String> {
    let forward = name.replace('\\', "/");
    let forward = forward.strip_prefix('/').unwrap_or(&forward);
    let malformed = forward.as_bytes().iter().enumerate().any(|(i, byte)| {
        *byte == b'%'
            && (forward
                .as_bytes()
                .get(i + 1)
                .is_none_or(|b| !b.is_ascii_hexdigit())
                || forward
                    .as_bytes()
                    .get(i + 2)
                    .is_none_or(|b| !b.is_ascii_hexdigit()))
    });
    let decoded = if malformed {
        forward.into()
    } else {
        percent_encoding::percent_decode_str(forward)
            .decode_utf8()
            .map(|s| s.into_owned())
            .unwrap_or_else(|_| forward.into())
    };
    validate_relative(&decoded)
}
// Paths supplied by the parser are already decoded; never decode them a second time.
fn validate_relative(decoded: &str) -> Result<String> {
    if decoded.is_empty()
        || decoded.starts_with('/')
        || decoded.contains([':', '\0', '\\'])
        || decoded.split('/').any(|part| part == "..")
    {
        bail!("EPUB 成员路径越界：{decoded}");
    }
    let normalized = decoded
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/");
    if normalized.is_empty() {
        bail!("EPUB 成员路径为空");
    }
    Ok(normalized)
}
fn markup(name: &str) -> bool {
    matches!(
        Path::new(name)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str(),
        "html" | "htm" | "xhtml"
    )
}
fn text_member(name: &str) -> bool {
    markup(name)
        || matches!(
            Path::new(name)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase()
                .as_str(),
            "xml" | "opf" | "ncx"
        )
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn stage(backend: &Backend, source: &Path) -> Result<Value> {
    let source = source.canonicalize().context("EPUB 文件不存在")?;
    let id = storage::id();
    let dir = pending(backend, &id)?;
    fs::create_dir_all(dir.join("content"))?;
    let outcome = (|| -> Result<Value> {
        let mut zip = zip::ZipArchive::new(fs::File::open(&source)?)?;
        let raw_names: Vec<String> = zip.file_names().map(str::to_owned).collect();
        if zip.len() > 50_000 {
            bail!("EPUB 成员数量超过 50000");
        }
        let mut entries = vec![];
        let mut seen = HashSet::new();
        let mut total = 0u64;
        let mut text_size = 0usize;
        for index in 0..zip.len() {
            let mut member = zip.by_index(index)?;
            let raw = member.name().to_owned();
            if member.is_dir() || raw.ends_with('\\') {
                continue;
            }
            if member.size() == 0
                && raw_names
                    .iter()
                    .any(|name| name.starts_with(&format!("{raw}/")))
            {
                continue;
            }
            let name = relative(&raw)?;
            if name
                .split('/')
                .any(|p| p == "__MACOSX" || p.starts_with("._") || p == ".DS_Store")
            {
                continue;
            }
            if member
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                bail!("EPUB 不允许符号链接");
            }
            // Windows cannot preserve colliding case-insensitive names. Reject instead of silently overwriting.
            if !seen.insert(name.to_lowercase()) {
                bail!("EPUB 成员名称重复：{name}");
            }
            if member.size() > MAX_MEMBER || total + member.size() > MAX_TOTAL {
                bail!("EPUB 解压体积超过限制");
            }
            let mut bytes = Vec::new();
            member
                .by_ref()
                .take(MAX_MEMBER + 1)
                .read_to_end(&mut bytes)?;
            total += bytes.len() as u64;
            if bytes.len() as u64 > MAX_MEMBER || total > MAX_TOTAL {
                bail!("EPUB 解压体积超过限制");
            }
            let dest = dir.join("content").join(&name);
            fs::create_dir_all(dest.parent().context("缺少父目录")?)?;
            fs::write(&dest, &bytes)?;
            let text = if text_member(&name) {
                text_size += bytes.len();
                if text_size > MAX_TEXT {
                    bail!("EPUB 章节和元数据文本超过 64 MiB");
                }
                Some(
                    String::from_utf8_lossy(&bytes)
                        .trim_start_matches('\u{feff}')
                        .to_owned(),
                )
            } else {
                None
            };
            entries.push(json!({"name":name,"rawName":raw,"text":text}));
        }
        if !entries.iter().any(|v| {
            v["name"]
                .as_str()
                .is_some_and(|s| s.to_lowercase().ends_with(".opf"))
        }) {
            bail!("没有找到 EPUB 的 OPF 文件");
        }
        fs::copy(&source, dir.join("original.epub"))?;
        let title = source
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("未命名");
        let result = json!({"id":id,"title":title,"entries":entries});
        storage::write(&dir.join("import.json"), &result)?;
        Ok(result)
    })();
    if outcome.is_err() {
        discard(backend, &id)?;
    }
    outcome
}
pub fn discard(backend: &Backend, id: &str) -> Result<()> {
    let dir = pending(backend, id)?;
    if dir.exists() {
        let root = backend.root.join("epub-imports").canonicalize()?;
        let target = dir.canonicalize()?;
        if target == root || !target.starts_with(root) {
            bail!("拒绝移除越界的 EPUB 导入目录");
        }
        fs::remove_dir_all(target)?;
    }
    Ok(())
}
pub fn staged_text(backend: &Backend, id: &str, href: &str) -> Result<Value> {
    let root = pending(backend, id)?.join("content");
    let path = storage::inside(&root, href)?;
    if fs::metadata(&path)?.len() > MAX_TEXT as u64 {
        bail!("EPUB 章节超过 64 MiB");
    }
    Ok(json!(
        String::from_utf8_lossy(&fs::read(path)?).trim_start_matches('\u{feff}')
    ))
}
pub fn clean_pending(backend: &Backend) -> Result<()> {
    let root = backend.root.join("epub-imports");
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_dir() && storage::valid_id(&id).is_ok() && id.starts_with("bk_") {
            discard(backend, &id)?;
        }
    }
    Ok(())
}
pub fn commit(backend: &mut Backend, id: &str, prepared: &Value) -> Result<Value> {
    let dir = pending(backend, id)?;
    let manifest = storage::read(&dir.join("import.json"), Value::Null)?;
    if manifest["id"] != id {
        bail!("EPUB 导入记录不存在");
    }
    let parsed = &prepared["parsed"];
    prepare_reader(&dir, parsed, &prepared["documents"])?;
    let spine = parsed["spine"].as_array().context("缺少 EPUB 阅读顺序")?;
    let content = dir.join("content");
    let mut pages = vec![];
    let page_dir = format!("arale-pages-{}", uuid::Uuid::new_v4().simple());
    if let Some(images) = prepared["imagePages"].as_array() {
        for image in images {
            let href = image.as_str().context("页图路径无效")?;
            let path = storage::inside(&content, href)?;
            if !arale_native::pages::is_comic_image(href) {
                bail!("图片型 EPUB 页图格式无效");
            }
            let (width, height) = image::image_dimensions(&path)?;
            let extension = Path::new(href)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("png")
                .to_lowercase();
            let url = format!("{page_dir}/page-{:06}.{extension}", pages.len() + 1);
            fs::create_dir_all(content.join(&page_dir))?;
            fs::copy(path, content.join(&url))?;
            pages.push(json!({"url":url,"width":width,"height":height}));
        }
    }
    let title = parsed["title"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .or(manifest["title"].as_str())
        .unwrap_or("未命名");
    let cover = parsed["coverRel"]
        .as_str()
        .filter(|s| storage::inside(&content, s).is_ok());
    let timestamp = storage::now();
    let book = json!({"id":id,"format":"epub","readerMode":if pages.is_empty(){"epub"}else{"comic"},
        "title":title,"titleSort":title.to_lowercase(),"author":parsed["author"].as_str().unwrap_or(""),
        "language":parsed["language"],"publisher":parsed["publisher"],"description":parsed["description"],
        "series":null,"volume":null,"tags":[],"dir":backend.dir(id)?.to_string_lossy(),
        "addedAt":timestamp,"updatedAt":timestamp,"lastOpenedAt":null,"direction":parsed["direction"],
        "coverRel":cover.or_else(||pages.first().and_then(|p|p["url"].as_str())),
        "spine":spine,"toc":parsed["toc"],"opfRel":parsed["opfRel"],
        "pageCount":if pages.is_empty(){Value::Null}else{json!(pages.len())},"pages":if pages.is_empty(){Value::Null}else{json!(pages)}});
    fs::remove_file(dir.join("import.json")).context("无法移除 EPUB 暂存记录")?;
    let dest = backend.dir(id)?;
    if dest.exists() {
        bail!("EPUB 书目录已存在");
    }
    storage::rename_directory(&dir, &dest).context("无法发布 EPUB 暂存目录")?;
    match backend.add(book) {
        Ok(book) => Ok(book),
        Err(error) => {
            let published = storage::inside(&backend.root.join("library"), id)?;
            let pending_root = backend.root.join("epub-imports").canonicalize()?;
            if !pending_root.starts_with(backend.root.canonicalize()?) {
                bail!("EPUB 回滚目录越界");
            }
            storage::rename_directory(&published, &pending_root.join(id))
                .context("无法回滚 EPUB 发布")?;
            Err(error)
        }
    }
}

// Prepare passive chapter HTML and bind its text cache to the original content.
pub fn prepare_reader(dir: &Path, parsed: &Value, documents: &Value) -> Result<()> {
    let spine = parsed["spine"].as_array().context("缺少 EPUB 阅读顺序")?;
    if spine.is_empty() {
        bail!("EPUB 没有可读章节");
    }
    let content = dir.join("content");
    storage::inside(&content, parsed["opfRel"].as_str().context("缺少 OPF")?)?;
    let documents = documents.as_array().context("缺少 EPUB 章节")?;
    let mut registry = vec![];
    let mut document_bytes = 0usize;
    let mut seen = HashSet::new();
    fs::create_dir_all(dir.join("reader"))?;
    for (index, document) in documents.iter().enumerate() {
        let href = document["href"].as_str().context("章节路径无效")?;
        if validate_relative(href)? != href
            || (!markup(href) && !spine.iter().any(|item| item["href"] == href))
            || !seen.insert(href.to_owned())
        {
            bail!("无效或重复章节路径");
        }
        let source_hash = match storage::inside(&content, href) {
            Ok(path) => Some(hash(&fs::read(path)?)),
            Err(_)
                if !content.join(href).exists()
                    && spine.iter().any(|item| item["href"] == href) =>
            {
                None
            }
            Err(error) => return Err(error),
        };
        let html = document["html"].as_str().context("章节文档无效")?;
        let plain = document["plainText"].as_str().context("章节文本无效")?;
        document_bytes += html.len() + plain.len();
        if document_bytes > MAX_TEXT {
            bail!("EPUB 预处理文档超过 64 MiB");
        }
        fs::write(dir.join("reader").join(format!("{index}.html")), html)?;
        registry.push(json!({"href":href,"file":format!("{index}.html"),"plainText":plain,"sourceHash":source_hash}));
    }
    for item in spine {
        if !seen.contains(item["href"].as_str().context("章节路径无效")?) {
            bail!("章节没有完成预处理");
        }
    }
    storage::write(
        &dir.join("epub-reader.json"),
        &json!({"version":1,"documents":registry}),
    )?;
    Ok(())
}
fn registry(backend: &Backend, id: &str) -> Result<Value> {
    let book = backend.book(id)?;
    if book["format"] != "epub" {
        bail!("不是 EPUB");
    }
    storage::read(&backend.dir(id)?.join("epub-reader.json"), Value::Null)
}
fn verify_source(backend: &Backend, id: &str, document: &Value) -> Result<()> {
    let path = backend
        .dir(id)?
        .join("content")
        .join(document["href"].as_str().context("章节路径无效")?);
    match document["sourceHash"].as_str() {
        Some(expected) => {
            let safe = storage::inside(
                &backend.dir(id)?.join("content"),
                document["href"].as_str().unwrap(),
            )?;
            if hash(&fs::read(safe)?) != expected {
                bail!("章节原文件已改变，请重新导入 EPUB");
            }
        }
        None if path.exists() => bail!("章节原文件已改变，请重新导入 EPUB"),
        None => {}
    }
    Ok(())
}
pub fn chapter(backend: &Backend, id: &str, index: usize) -> Result<Value> {
    let book = backend.book(id)?;
    let spine = book["spine"].as_array().context("没有 EPUB 章节")?;
    let index = index.min(spine.len().saturating_sub(1));
    let href = spine
        .get(index)
        .and_then(|v| v["href"].as_str())
        .context("没有 EPUB 章节")?;
    let registry = registry(backend, id)?;
    let document = registry["documents"]
        .as_array()
        .context("章节缓存无效")?
        .iter()
        .find(|v| v["href"] == href)
        .context("章节缓存缺失")?;
    verify_source(backend, id, document)?;
    let path = [id]
        .into_iter()
        .chain(href.split('/'))
        .map(|s| percent_encoding::utf8_percent_encode(s, URL_SEGMENT).to_string())
        .collect::<Vec<_>>()
        .join("/");
    let url = if cfg!(target_os = "windows") {
        format!("http://arale-book.localhost/{path}")
    } else {
        format!("arale-book://localhost/{path}")
    };
    Ok(json!({"spineIndex":index,"url":url,"plainText":document["plainText"]}))
}
pub fn units(backend: &Backend, id: &str) -> Result<Vec<Value>> {
    let book = backend.book(id)?;
    // Read the whole-book cache once, not once per chapter.
    let cache = registry(backend, id)?;
    let documents: std::collections::HashMap<&str, &Value> = cache["documents"]
        .as_array()
        .context("章节缓存无效")?
        .iter()
        .map(|document| Ok((document["href"].as_str().context("章节路径无效")?, document)))
        .collect::<Result<_>>()?;
    let mut labels = std::collections::HashMap::new();
    for entry in book["toc"].as_array().into_iter().flatten() {
        if let (Some(href), Some(label)) = (entry["href"].as_str(), entry["label"].as_str()) {
            if !label.trim().is_empty() {
                labels.entry(href).or_insert(label.trim());
            }
        }
    }
    book["spine"].as_array().context("没有 EPUB 章节")?.iter().enumerate().map(|(index,item)| {
        let href = item["href"].as_str().context("章节路径无效")?;
        let document = documents.get(href).context("章节缓存缺失")?;
        verify_source(backend,id,document)?;
        let label = labels.get(href).copied().unwrap_or_else(||href.rsplit('/').next().unwrap_or(href));
        Ok(json!({"ref":format!("chapter:{index}:{href}"),"text":document["plainText"],"label":label}))
    }).collect()
}
pub fn resource(backend: &Backend, id: &str, href: &str) -> Result<(Vec<u8>, String)> {
    let registry = registry(backend, id)?;
    if let Some(document) = registry["documents"]
        .as_array()
        .context("章节缓存无效")?
        .iter()
        .find(|v| v["href"] == href)
    {
        verify_source(backend, id, document)?;
        let path = storage::inside(
            &backend.dir(id)?.join("reader"),
            document["file"].as_str().context("章节缓存缺失")?,
        )?;
        let mut html = String::from_utf8(fs::read(path)?)?;
        let script = format!("<script>{READER_BRIDGE}</script>");
        if let Some(index) = html.to_ascii_lowercase().rfind("</body") {
            html.insert_str(index, &script);
        } else {
            html.push_str(&script);
        }
        #[cfg(debug_assertions)]
        if crate::smoke_enabled() {
            html.push_str("\n<script>");
            html.push_str(include_str!("../../scripts/tauri-smoke-epub.js"));
            html.push_str("</script>");
            return Ok((html.into_bytes(), "text/html; charset=utf-8".into()));
        }
        return Ok((html.into_bytes(), "text/html; charset=utf-8".into()));
    }
    let extension = Path::new(href)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !matches!(
        extension.as_str(),
        "css"
            | "jpg"
            | "jpeg"
            | "png"
            | "gif"
            | "webp"
            | "bmp"
            | "avif"
            | "svg"
            | "woff"
            | "woff2"
            | "ttf"
            | "otf"
            | "mp3"
            | "m4a"
            | "ogg"
            | "mp4"
    ) {
        bail!("不允许此 EPUB 资源类型");
    }
    let path = storage::inside(&backend.dir(id)?.join("content"), href)?;
    let mime = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();
    Ok((fs::read(path)?, mime))
}
pub fn csp() -> String {
    let digest = STANDARD.encode(Sha256::digest(READER_BRIDGE.as_bytes()));
    #[allow(unused_mut)]
    let mut script = format!("'sha256-{digest}'");
    #[cfg(debug_assertions)]
    if crate::smoke_enabled() {
        script.push_str(&format!(
            " 'sha256-{}'",
            STANDARD.encode(Sha256::digest(
                include_str!("../../scripts/tauri-smoke-epub.js")
                    .replace("\r\n", "\n")
                    .as_bytes()
            ))
        ));
    }
    format!("default-src 'none'; script-src {script}; style-src 'unsafe-inline' arale-book: http://arale-book.localhost https://arale-book.localhost; img-src arale-book: http://arale-book.localhost https://arale-book.localhost data:; font-src arale-book: http://arale-book.localhost https://arale-book.localhost data:; media-src arale-book: http://arale-book.localhost https://arale-book.localhost data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")
}
