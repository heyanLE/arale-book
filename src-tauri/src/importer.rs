use crate::storage;
#[cfg(test)]
use crate::storage::Backend;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn collect(root: &Path, dir: &Path, output: &mut Vec<String>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "__MACOSX" || name == "manga_ocr_out" {
            continue;
        }
        if kind.is_dir() {
            collect(root, &entry.path(), output)?;
        } else if kind.is_file() {
            output.push(
                entry
                    .path()
                    .strip_prefix(root)?
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
pub fn import(backend: &mut Backend, input: &Path) -> Result<Value> {
    let root = backend.root.clone();
    let settings = storage::read(&root.join("settings.json"), json!({}))?;
    let direction = if settings["direction"] == "ltr" { "ltr" } else { "rtl" };
    let book = prepare_book(&root, input, direction, &|_| {})?;
    let result = backend.add(book.clone());
    if result.is_err() { discard_book(&root, &book); }
    result
}

fn discard_book(root: &Path, book: &Value) {
    if let Some(id) = book["id"].as_str().filter(|id| storage::valid_id(id).is_ok()) {
        // Only a newly generated directory under this library can be removed.
        fs::remove_dir_all(root.join("library").join(id)).ok();
    }
}

fn prepare_book(root: &Path, input: &Path, direction: &str, progress: &dyn Fn(Value)) -> Result<Value> {
    let input = input.canonicalize().context("导入文件不存在")?;
    let extension = input
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if extension == "epub" {
        bail!("EPUB 请通过书库统一导入入口解析");
    }
    let id = storage::id();
    let dir = root.join("library").join(&id);
    let content = dir.join("content");
    fs::create_dir_all(&content)?;
    let outcome = import_content(&input, &content, &extension, progress).and_then(|pages| {
        if pages.is_empty() { bail!("未找到可读图片"); }
        if input.is_file() {
            report(progress, "publishing", format!("正在保存原始文件：{}", input.file_name().unwrap_or_default().to_string_lossy()), 0, 0);
            fs::copy(&input,dir.join(format!("original.{extension}")))?;
        }
        let title = if input.is_dir() { input.file_name() } else { input.file_stem() }.and_then(|s| s.to_str()).unwrap_or("未命名");
        let timestamp = storage::now();
        let book = json!({"id":id,"format":"comic","title":title,"titleSort":title.to_lowercase(),"author":"",
            "series":null,"volume":null,"language":null,"publisher":null,"description":null,"tags":[],
            "coverRel":pages[0]["url"],"dir":dir.to_string_lossy(),"addedAt":timestamp,"updatedAt":timestamp,"lastOpenedAt":null,
            "direction":direction,"spine":null,"toc":null,"opfRel":null,"pageCount":pages.len(),"pages":pages});
        Ok(book)
    });
    if outcome.is_err() {
        // The only cleanup target is this newly generated book directory inside the library.
        let library = root.join("library").canonicalize()?;
        let resolved = dir.canonicalize()?;
        if resolved.starts_with(&library) && resolved != library {
            fs::remove_dir_all(resolved).ok();
        }
    }
    outcome
}

fn report(progress: &dyn Fn(Value), stage: &str, message: String, done: usize, total: usize) {
    progress(json!({"stage":stage,"message":message,"done":done,"total":total}));
}

fn import_content(input: &Path, content: &Path, extension: &str, progress: &dyn Fn(Value)) -> Result<Vec<Value>> {
    let title = input.file_name().unwrap_or_default().to_string_lossy();
    report(progress, "extracting", format!("正在读取/解压：{title}"), 0, 0);
    let mut names = vec![];
    if input.is_dir() {
        collect(input, input, &mut names)?;
        for name in &names {
            if arale_native::pages::is_comic_image(name)
                || name.ends_with(".mokuro")
                || name == "manga.json"
            {
                let source = storage::inside(input, name)?;
                let dest = content.join(name);
                fs::create_dir_all(dest.parent().unwrap())?;
                fs::copy(source, dest)?;
            }
        }
    } else if arale_native::pages::is_comic_image(&format!("image.{extension}")) {
        let name = format!("page-000001.{extension}");
        fs::copy(input, content.join(&name))?;
        names.push(name);
    } else if extension == "mokuro" || extension == "json" {
        let raw = storage::read(input, Value::Null)?;
        let pages = raw["pages"].as_array().context("不是 mokuro 页清单")?;
        let source = input.parent().unwrap();
        let mut mapped = raw.clone();
        for (i, page) in pages.iter().enumerate() {
            let rel = page["img_path"]
                .as_str()
                .or_else(|| page["url"].as_str())
                .context("mokuro 缺少图片路径")?;
            let source_path = storage::inside(source, rel)?;
            let ext = source_path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("png");
            let name = format!("page-{:06}.{ext}", i + 1);
            fs::copy(source_path, content.join(&name))?;
            mapped["pages"][i]["url"] = json!(name);
            mapped["pages"][i]["img_path"] = json!(name);
            names.push(name);
        }
        storage::write(&content.join("manga.json"), &mapped)?;
    } else {
        let root = arale_native::out::OutputRoot::create(content)?;
        arale_native::extract::extract_archive(input, &root, false)?;
        collect(content, content, &mut names)?;
        if names.iter().any(|s| s.to_lowercase().ends_with(".opf")) {
            bail!("此压缩包包含 EPUB：Tauri 当前支持 .epub ZIP 文件，请使用对应 EPUB 文件导入");
        }
    }
    let image_names = arale_native::pages::collect_pages(&names);
    report(progress, "organizing", format!("正在整理图片：{title}"), 0, image_names.len());
    if !content.join("manga.json").is_file() {
        if let Some(manifest) = names.iter().find(|s| s.ends_with(".mokuro")) {
            let raw = storage::read(&content.join(manifest), Value::Null)?;
            storage::write(&content.join("manga.json"), &raw)?;
        }
    }
    // Stable ASCII page names also allow the existing Python/OpenCV OCR runner to be reused later.
    let mut mapping = std::collections::HashMap::new();
    let mut pages = vec![];
    let staging = content.join(".page-migration");
    fs::create_dir_all(&staging)?;
    for (index, rel) in image_names.iter().enumerate() {
        let source = storage::inside(content, rel)?;
        let (width, height) =
            image::image_dimensions(&source).with_context(|| format!("无法读取图片尺寸：{rel}"))?;
        let ext = Path::new(rel)
            .extension()
            .unwrap()
            .to_string_lossy()
            .to_lowercase();
        let dest = format!("pages/page-{:06}.{ext}", index + 1);
        fs::copy(&source, staging.join(format!("{index}.{ext}")))?;
        mapping.insert(rel.clone(), dest.clone());
        pages.push(json!({"url":dest,"width":width,"height":height}));
        if (index + 1) % 16 == 0 || index + 1 == image_names.len() {
            report(progress, "organizing", format!("正在整理图片：{title}"), index + 1, image_names.len());
        }
    }
    fs::create_dir_all(content.join("pages"))?;
    for (index, rel) in image_names.iter().enumerate() {
        let ext = Path::new(rel)
            .extension()
            .unwrap()
            .to_string_lossy()
            .to_lowercase();
        fs::copy(
            staging.join(format!("{index}.{ext}")),
            content.join(&mapping[rel]),
        )?;
    }
    if content.join("manga.json").is_file() {
        let mut raw = storage::read(&content.join("manga.json"), Value::Null)?;
        if let Some(rows) = raw["pages"].as_array_mut() {
            for page in rows {
                let rel = page["url"]
                    .as_str()
                    .or_else(|| page["img_path"].as_str())
                    .unwrap_or("")
                    .replace('\\', "/");
                if let Some(new) = mapping.get(&rel) {
                    page["url"] = json!(new);
                    page["img_path"] = json!(new);
                }
            }
        }
        storage::write(&content.join("manga.json"), &raw)?;
    }
    // Remove duplicated original images only after copying every page and updating its manifest.
    for rel in image_names {
        let target = storage::inside(content, &rel)?;
        if !pages.iter().any(|p| {
            content
                .join(p["url"].as_str().unwrap())
                .canonicalize()
                .ok()
                .as_ref()
                == Some(&target)
        }) {
            fs::remove_file(target)?;
        }
    }
    let resolved_staging = staging.canonicalize()?;
    if resolved_staging.starts_with(content.canonicalize()?) {
        fs::remove_dir_all(resolved_staging)?;
    }
    Ok(pages)
}

fn is_archive(name: &str) -> bool {
    matches!(Path::new(name).extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase().as_str(),
        "zip" | "cbz" | "rar" | "cbr" | "7z" | "cb7" | "tar" | "cbt" | "epub")
}

/// Only image-free containers are expanded. Every leaf volume publishes separately,
/// so one bad child cannot roll back its successful siblings. Extraction never holds Backend's lock.
pub fn import_batch(root: &Path, input: &Path, direction: &str, progress: &dyn Fn(Value), publish: &mut dyn FnMut(Value) -> Result<Value>) -> Vec<Value> {
    struct Batch<'a> {
        root: &'a Path, direction: &'a str, progress: &'a dyn Fn(Value),
        publish: &'a mut dyn FnMut(Value) -> Result<Value>, results: Vec<Value>, visited: usize,
    }
    impl Batch<'_> {
        fn visit(&mut self, input: &Path, source: String, depth: usize) {
            self.visited += 1;
            let result = self.one(input, &source, depth);
            if let Err(error) = result {
                self.results.push(json!({"ok":false,"source":source,"bookId":null,"format":null,"error":format!("{error:#}")}));
            }
        }
        fn one(&mut self, input: &Path, source: &str, depth: usize) -> Result<()> {
            if depth > 5 { bail!("合集嵌套超过 5 层，请先解压后导入"); }
            if self.visited > 200 { bail!("合集包含超过 200 个压缩包，请分批导入"); }
            let input = input.canonicalize().context("导入文件不存在")?;
            let title = input.file_name().unwrap_or_default().to_string_lossy().into_owned();
            report(self.progress, "checking", format!("正在检查：{title}"), 0, 0);
            if input.extension().is_some_and(|s| s.eq_ignore_ascii_case("epub")) {
                bail!("合集内的 EPUB 请先解压后通过 EPUB 导入入口导入");
            }
            if input.is_file() && is_archive(&title) {
                let format = arale_native::format::detect_from_path(&input);
                let entries = arale_native::archive::reader_for(format).list(&input)?;
                let names: Vec<String> = entries.iter().filter(|e| !e.is_dir).map(|e| e.name.clone()).collect();
                if arale_native::pages::collect_pages(&names).is_empty() && names.iter().any(|name| is_archive(name)) {
                    report(self.progress, "extracting", format!("正在展开合集：{title}"), 0, 0);
                    let staging = self.root.join("import-staging");
                    fs::create_dir_all(&staging)?;
                    let temporary = tempfile::Builder::new().prefix("collection-").tempdir_in(staging)?;
                    let output = arale_native::out::OutputRoot::create(temporary.path())?;
                    arale_native::extract::extract_archive(&input, &output, false)?;
                    let mut children = vec![];
                    collect(temporary.path(), temporary.path(), &mut children)?;
                    children.retain(|name| is_archive(name));
                    children.sort_by(|a, b| arale_native::pages::natural_compare(a, b));
                    if children.is_empty() { bail!("合集没有可导入的分卷文件"); }
                    for child in children {
                        self.visit(&storage::inside(temporary.path(), &child)?, format!("{source} → {child}"), depth + 1);
                        if self.visited > 200 { break; }
                    }
                    return Ok(());
                }
            }
            let book = prepare_book(self.root, &input, self.direction, self.progress)?;
            report(self.progress, "publishing", format!("正在入库：{title}"), 0, 0);
            let published = (self.publish)(book.clone());
            if published.is_err() { discard_book(self.root, &book); }
            let published = published?;
            self.results.push(json!({"ok":true,"source":source,"bookId":published["id"],"format":"comic","error":null}));
            Ok(())
        }
    }
    let mut batch = Batch { root, direction, progress, publish, results: vec![], visited: 0 };
    batch.visit(input, input.to_string_lossy().into_owned(), 0);
    batch.results
}

pub fn paths(args: &Value) -> Result<Vec<PathBuf>> {
    args.as_array()
        .context("导入路径必须为数组")?
        .iter()
        .map(|value| Ok(PathBuf::from(value.as_str().context("导入路径必须为文本")?)))
        .collect()
}
