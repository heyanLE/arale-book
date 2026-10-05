use crate::storage::{self, Backend};
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

pub fn import(backend: &mut Backend, input: &Path) -> Result<Value> {
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
    let dir = backend.dir(&id)?;
    let content = dir.join("content");
    fs::create_dir_all(&content)?;
    let outcome = import_content(&input, &content, &extension).and_then(|pages| {
        if pages.is_empty() { bail!("未找到可读图片"); }
        if input.is_file() { fs::copy(&input,dir.join(format!("original.{extension}")))?; }
        let settings = storage::read(&backend.root.join("settings.json"), json!({}))?;
        let direction = if settings["direction"] == "ltr" { "ltr" } else { "rtl" };
        let title = if input.is_dir() { input.file_name() } else { input.file_stem() }.and_then(|s| s.to_str()).unwrap_or("未命名");
        let timestamp = storage::now();
        let book = json!({"id":id,"format":"comic","title":title,"titleSort":title.to_lowercase(),"author":"",
            "series":null,"volume":null,"language":null,"publisher":null,"description":null,"tags":[],
            "coverRel":pages[0]["url"],"dir":dir.to_string_lossy(),"addedAt":timestamp,"updatedAt":timestamp,"lastOpenedAt":null,
            "direction":direction,"spine":null,"toc":null,"opfRel":null,"pageCount":pages.len(),"pages":pages});
        backend.add(book)
    });
    if outcome.is_err() {
        // The only cleanup target is this newly generated book directory inside the library.
        let library = backend.root.join("library").canonicalize()?;
        let resolved = dir.canonicalize()?;
        if resolved.starts_with(&library) && resolved != library {
            fs::remove_dir_all(resolved).ok();
        }
    }
    outcome
}

fn import_content(input: &Path, content: &Path, extension: &str) -> Result<Vec<Value>> {
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

pub fn paths(args: &Value) -> Result<Vec<PathBuf>> {
    args.as_array()
        .context("导入路径必须为数组")?
        .iter()
        .map(|value| Ok(PathBuf::from(value.as_str().context("导入路径必须为文本")?)))
        .collect()
}
