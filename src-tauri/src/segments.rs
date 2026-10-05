use crate::{
    page_text_from_raw,
    storage::{self, Backend},
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub fn read(backend: &Backend, id: &str) -> Result<Value> {
    backend.book(id)?;
    let artifact =
        storage::read(&backend.dir(id)?.join("segments.json"), Value::Null).unwrap_or(Value::Null);
    if !artifact["units"].is_array() || !artifact["vocabulary"].is_array() {
        return Ok(Value::Null);
    }
    Ok(artifact)
}
pub fn input(backend: &Backend, id: &str) -> Result<Value> {
    let book = backend.book(id)?;
    if book["format"] == "epub" && book["readerMode"] != "comic" {
        let units = crate::epub::units(backend, id)?;
        let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&units)?));
        return Ok(json!({"units":units,"fingerprint":fingerprint}));
    }
    let mut units = vec![];
    // Load the text layer once per job, rather than reparse the entire book for every page.
    let raw = storage::read(
        &backend.dir(id)?.join("content/manga.json"),
        json!({"pages":[]}),
    )?;
    for (page_index, page) in book["pages"]
        .as_array()
        .context("缺少漫画页")?
        .iter()
        .enumerate()
    {
        let text = page_text_from_raw(book, page_index, &raw)?;
        for (block_index, block) in text["blocks"]
            .as_array()
            .context("文字层格式错误")?
            .iter()
            .enumerate()
        {
            let lines = block["lines"].as_array().context("文字块格式错误")?;
            let joined: String = lines
                .iter()
                .map(|line| line.as_str().unwrap_or(""))
                .collect();
            units.push(json!({"ref":format!("page:{}#{block_index}",page["url"].as_str().unwrap_or("")),"text":joined,"label":format!("第 {} 页 第 {} 块",page_index+1,block_index+1)}));
        }
    }
    let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&units)?));
    Ok(json!({"units":units,"fingerprint":fingerprint}))
}
pub fn commit(backend: &Backend, id: &str, raw: &str, fingerprint: &str) -> Result<Value> {
    let input = input(backend, id)?;
    if input["fingerprint"] != fingerprint {
        bail!("文字层已改变，请重新分词");
    }
    let mut artifact: Value = serde_json::from_str(raw)?;
    if artifact["bookId"] != id
        || artifact["engine"] != "kuromoji-morph-v1"
        || !artifact["vocabulary"].is_array()
    {
        bail!("分词产物格式错误");
    }
    let units = artifact["units"].as_array().context("分词单元必须为数组")?;
    let sources = input["units"].as_array().unwrap();
    if units.len() != sources.len() {
        bail!("分词单元数量与原文不符");
    }
    for (unit, source) in units.iter().zip(sources) {
        if unit["ref"] != source["ref"] || unit["text"] != source["text"] {
            bail!("分词单元与原文不符");
        }
        let text: Vec<u16> = source["text"].as_str().unwrap().encode_utf16().collect();
        for token in unit["tokens"].as_array().context("tokens 必须是数组")? {
            let start = token["start"].as_u64().context("无效的 token 起点")? as usize;
            let end = token["end"].as_u64().context("无效的 token 终点")? as usize;
            if start >= end
                || end > text.len()
                || String::from_utf16(&text[start..end]).ok().as_deref()
                    != token["surface"].as_str()
            {
                bail!("token 的 UTF-16 偏移与原文不符");
            }
        }
    }
    artifact["generatedAt"] = json!(storage::now());
    storage::write(&backend.dir(id)?.join("segments.json"), &artifact)?;
    Ok(Value::Null)
}
pub fn clear(backend: &Backend, id: &str) -> Result<Value> {
    backend.book(id)?;
    let path = backend.dir(id)?.join("segments.json");
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(Value::Null)
}
