//! Rust owns files; the shared browser-safe TypeScript parser owns Yomitan semantics.
use crate::storage;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{fs, io::Read, path::Path};

fn root(data_root: &Path) -> std::path::PathBuf {
    data_root.join("dictionaries")
}
fn directory(data_root: &Path, id: &str, pending: bool) -> Result<std::path::PathBuf> {
    let base = if pending {
        root(data_root).join(".imports")
    } else {
        root(data_root)
    };
    storage::inside(&base, storage::valid_id(id)?)
}
pub fn list(data_root: &Path) -> Result<Vec<Value>> {
    let base = root(data_root);
    fs::create_dir_all(&base)?;
    let mut out = vec![];
    for entry in fs::read_dir(&base)? {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if !entry.file_type()?.is_dir() || storage::valid_id(&id).is_err() {
            continue;
        }
        let path = storage::inside(&base, &id)?;
        let Ok(info) = storage::read(&path.join("meta.json"), Value::Null) else {
            continue;
        };
        if info["id"] == id && info["title"].as_str().is_some_and(|s| !s.is_empty()) {
            out.push(json!({"id":id,"title":info["title"],"format":"yomitan","termCount":info["termCount"].as_u64().unwrap_or(0),"freqCount":info["freqCount"].as_u64().unwrap_or(0),"importedAt":info["importedAt"].as_u64().unwrap_or(0),"enabled":info["enabled"] != false}));
        }
    }
    Ok(out)
}
pub fn status(data_root: &Path) -> Result<Value> {
    let dictionaries = list(data_root)?;
    let count: u64 = dictionaries
        .iter()
        .filter(|d| d["enabled"] != false)
        .map(|d| d["termCount"].as_u64().unwrap_or(0))
        .sum();
    Ok(
        json!({"dir":root(data_root).to_string_lossy(),"dictionaries":dictionaries,"termCount":count,"loaded":false}),
    )
}
pub fn clean_pending(data_root: &Path) -> Result<()> {
    let base = root(data_root).join(".imports");
    if !base.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&base)? {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_dir() && id.starts_with("dict_") && storage::valid_id(&id).is_ok()
        {
            // Canonicalize and check containment before every recursive deletion.
            fs::remove_dir_all(storage::inside(&base, &id)?)?;
        }
    }
    Ok(())
}
fn bank(name: &str) -> bool {
    ["term_bank_", "term_meta_bank_"].iter().any(|prefix| {
        name.strip_prefix(prefix)
            .and_then(|s| s.strip_suffix(".json"))
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()))
    })
}
#[cfg(test)]
pub fn stage(data_root: &Path, source: &Path) -> Result<Value> {
    stage_with_progress(data_root, source, |_| {})
}
pub fn stage_with_progress(data_root: &Path, source: &Path, report: impl Fn(Value)) -> Result<Value> {
    let file = fs::File::open(source).context("无法打开词典 ZIP")?;
    let mut archive = zip::ZipArchive::new(file).context("不是可读取的 ZIP")?;
    let names: Vec<String> = archive.file_names().map(String::from).collect();
    let index = names
        .iter()
        .filter(|n| n.rsplit('/').next() == Some("index.json"))
        .min_by_key(|n| n.len())
        .context("不是 Yomitan 词典：缺少 index.json")?
        .clone();
    let prefix = &index[..index.len() - "index.json".len()];
    let mut banks: Vec<_> = names
        .iter()
        .filter_map(|n| n.strip_prefix(prefix))
        .filter(|n| !n.contains('/') && bank(n))
        .map(String::from)
        .collect();
    banks.sort();
    banks.dedup();
    if banks.is_empty() {
        bail!("不是 Yomitan 词典：缺少 term_bank / term_meta_bank");
    }
    let base = root(data_root).join(".imports");
    fs::create_dir_all(&base)?;
    let id = format!("dict_{}", uuid::Uuid::new_v4().simple());
    let target = base.join(&id);
    fs::create_dir(&target)?;
    let result = (|| {
        let mut total = 0u64;
        let mut extract = |name: &str| -> Result<String> {
            let mut member = archive.by_name(name)?;
            if member.size() > 256 * 1024 * 1024 {
                bail!("词典单个数据 bank 超过 256 MiB");
            }
            total += member.size();
            if total > 2 * 1024 * 1024 * 1024 {
                bail!("词典数据超过 2 GiB");
            }
            let mut text = String::new();
            member
                .read_to_string(&mut text)
                .context("词典数据不是 UTF-8")?;
            Ok(text)
        };
        let raw = extract(&index)?;
        let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let title = parsed["title"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| {
                source
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            });
        report(json!({"stage":"extracting","message":"正在解压词典数据…","done":0,"total":banks.len(),"unit":"files","title":title}));
        for (index, name) in banks.iter().enumerate() {
            fs::write(target.join(name), extract(&format!("{prefix}{name}"))?)?;
            report(json!({"stage":"extracting","message":"正在解压词典数据…","done":index+1,"total":banks.len(),"unit":"files","title":title}));
        }
        let manifest = json!({"id":id,"title":title,"format":parsed["format"],"banks":banks});
        storage::write(&target.join("manifest.json"), &manifest)?;
        Ok(manifest)
    })();
    if result.is_err() {
        discard(data_root, &id)?;
    }
    result
}
pub fn discard(data_root: &Path, id: &str) -> Result<()> {
    let target = directory(data_root, id, true)?;
    fs::remove_dir_all(target)?;
    Ok(())
}
pub fn raw_bank(data_root: &Path, id: &str, name: &str) -> Result<Value> {
    let dir = directory(data_root, id, true)?;
    let manifest = storage::read(&dir.join("manifest.json"), Value::Null)?;
    if !bank(name)
        || !manifest["banks"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == name))
    {
        bail!("无效的词典 bank");
    }
    Ok(json!(fs::read_to_string(storage::inside(&dir, name)?)?))
}
pub fn commit(data_root: &Path, id: &str, terms: &str, frequencies: &str) -> Result<Value> {
    let pending = directory(data_root, id, true)?;
    let manifest = storage::read(&pending.join("manifest.json"), Value::Null)?;
    let mut terms: Value = serde_json::from_str(terms)?;
    let frequencies: Value = serde_json::from_str(frequencies)?;
    let rows = terms.as_array_mut().context("词条必须是数组")?;
    for row in rows.iter_mut() {
        if !row["expression"].as_str().is_some_and(|s| !s.is_empty()) || !row.is_object() {
            bail!("无效的词条");
        }
        row["dictionaryId"] = json!(id);
        row["dictionaryTitle"] = manifest["title"].clone();
    }
    let count = rows.len();
    let freq_count = frequencies.as_array().context("词频必须是数组")?.len();
    let info = json!({"id":id,"title":manifest["title"],"format":"yomitan","termCount":count,"freqCount":freq_count,"importedAt":storage::now(),"enabled":true});
    storage::write(&pending.join("terms.json"), &terms)?;
    storage::write(&pending.join("freq.json"), &frequencies)?;
    // Remove only files listed in our generated manifest. Archive paths are never extraction targets.
    for name in manifest["banks"].as_array().context("导入清单损坏")? {
        fs::remove_file(storage::inside(
            &pending,
            name.as_str().context("bank 名错误")?,
        )?)?;
    }
    fs::remove_file(pending.join("manifest.json"))?;
    storage::write(&pending.join("meta.json"), &info)?;
    fs::rename(&pending, root(data_root).join(id))?;
    Ok(info)
}
pub fn data(data_root: &Path, id: &str) -> Result<Value> {
    if !list(data_root)?.iter().any(|d| d["id"] == id) {
        bail!("词典不存在");
    }
    let dir = directory(data_root, id, false)?;
    let read = |name| -> Result<String> {
        let path = storage::inside(&dir, name)?;
        Ok(fs::read_to_string(path)?)
    };
    Ok(json!({"terms":read("terms.json")?,"frequencies":read("freq.json")?}))
}
pub fn remove(data_root: &Path, id: &str) -> Result<Value> {
    if !list(data_root)?.iter().any(|d| d["id"] == id) {
        bail!("词典不存在");
    }
    fs::remove_dir_all(directory(data_root, id, false)?)?;
    status(data_root)
}
pub fn enabled(data_root: &Path, id: &str, enabled: bool) -> Result<Value> {
    if !list(data_root)?.iter().any(|d| d["id"] == id) {
        bail!("词典不存在");
    }
    let dir = directory(data_root, id, false)?;
    let mut info = storage::read(&dir.join("meta.json"), Value::Null)?;
    info["enabled"] = json!(enabled);
    storage::write(&dir.join("meta.json"), &info)?;
    status(data_root)
}
