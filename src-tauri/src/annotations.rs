use crate::storage::{self, Backend};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
};

fn number(value: &Value, min: f64, max: f64) -> Result<f64> {
    let value = value.as_f64().context("批注数值无效")?;
    if !value.is_finite() || value < min || value > max {
        bail!("批注数值超限");
    }
    Ok(value)
}
fn text(value: &Value, max: usize, empty: bool) -> Result<&str> {
    let value = value.as_str().context("批注文本无效")?;
    if value.encode_utf16().count() > max || (!empty && value.trim().is_empty()) {
        bail!("批注文本长度无效");
    }
    Ok(value)
}
fn color(value: &Value) -> Result<()> {
    let value = text(value, 7, false)?;
    if value.len() != 7
        || !value.starts_with('#')
        || !value[1..].bytes().all(|c| c.is_ascii_hexdigit())
    {
        bail!("批注颜色无效");
    }
    Ok(())
}
pub fn validate(document: &Value) -> Result<()> {
    if document["version"] != 1
        || !document["revision"].is_u64()
        || document["revision"].as_u64().unwrap() > 9007199254740991
        || !document["visible"].is_boolean()
    {
        bail!("批注版本或 revision 无效");
    }
    let pages = document["pages"].as_object().context("批注页面无效")?;
    for (url, binding) in pages {
        text(&json!(url), 1000, false)?;
        number(&binding["width"], 1., 100000.)?;
        number(&binding["height"], 1., 100000.)?;
        text(&binding["signature"], 64, true)?;
    }
    let layers = document["layers"].as_array().context("批注图层无效")?;
    if layers.len() > 100 {
        bail!("图层数量超限");
    }
    let mut ids = HashSet::new();
    let mut object_ids = HashSet::new();
    let mut points = 0;
    let mut texts = 0;
    for layer in layers {
        if !ids.insert(text(&layer["id"], 100, false)?.to_owned()) {
            bail!("图层 ID 重复");
        }
        text(&layer["name"], 100, false)?;
        if !layer["visible"].is_boolean()
            || !layer["locked"].is_boolean()
            || (layer["type"] != "pen" && layer["type"] != "text")
        {
            bail!("图层属性无效");
        }
        for (url, rows) in layer["objects"].as_object().context("图层内容无效")? {
            text(&json!(url), 1000, false)?;
            for row in rows.as_array().context("图层对象无效")? {
                let binding = pages.get(url).context("批注对象没有页面绑定")?;
                let width = binding["width"].as_f64().unwrap();
                let height = binding["height"].as_f64().unwrap();
                if !object_ids.insert(text(&row["id"], 100, false)?.to_owned())
                    || object_ids.len() > 100000
                {
                    bail!("批注对象 ID 或数量无效");
                }
                number(&row["opacity"], 0.05, 1.)?;
                color(&row["color"])?;
                if layer["type"] == "pen" && row["kind"] == "stroke" {
                    number(&row["width"], 0.5, 512.)?;
                    let coords = row["points"].as_array().context("画笔坐标无效")?;
                    points += coords.len();
                    if coords.is_empty() || coords.len() > 20000 || points > 500000 {
                        bail!("画笔坐标数量超限");
                    }
                    for point in coords {
                        number(&point["x"], 0., width)?;
                        number(&point["y"], 0., height)?;
                    }
                } else if layer["type"] == "text" && row["kind"] == "text" {
                    texts += text(&row["text"], 10000, true)?.encode_utf16().count();
                    if texts > 2000000 {
                        bail!("批注文字数量超限");
                    }
                    number(&row["x"], 0., width)?;
                    number(&row["y"], 0., height)?;
                    number(&row["width"], 1., width)?;
                    number(&row["height"], 1., height)?;
                    number(&row["fontSize"], 1., 512.)?;
                    if !row["background"].is_null() {
                        color(&row["background"])?;
                    }
                    if !row["vertical"].is_boolean() {
                        bail!("文字方向无效");
                    }
                } else {
                    bail!("对象与图层类型不匹配");
                }
            }
        }
    }
    Ok(())
}
fn signature(backend: &Backend, id: &str, url: &str) -> Result<String> {
    let file = storage::inside(&backend.dir(id)?.join("content"), url)?;
    Ok(format!("{:x}", Sha256::digest(fs::read(file)?)))
}
fn stale(backend: &Backend, id: &str, document: &Value) -> Result<Vec<String>> {
    let book = backend.book(id)?;
    let pages = book["pages"].as_array().context("批注只支持漫画和图片")?;
    Ok(document["pages"]
        .as_object()
        .unwrap()
        .iter()
        .filter_map(|(url, binding)| {
            let valid = pages.iter().any(|p| {
                p["url"] == *url
                    && p["width"] == binding["width"]
                    && p["height"] == binding["height"]
            }) && signature(backend, id, url).ok().as_deref()
                == binding["signature"].as_str();
            if valid {
                None
            } else {
                Some(url.clone())
            }
        })
        .collect())
}
pub fn read(backend: &Backend, id: &str) -> Result<Value> {
    let book = backend.book(id)?;
    if book["readerMode"]
        .as_str()
        .unwrap_or(book["format"].as_str().unwrap_or(""))
        != "comic"
    {
        bail!("批注只支持漫画和图片");
    }
    let document = storage::read(
        &backend.dir(id)?.join("comic-annotations.json"),
        json!({"version":1,"revision":0,"visible":true,"layers":[],"pages":{}}),
    )?;
    validate(&document)?;
    Ok(json!({"stalePages":stale(backend,id,&document)?,"document":document}))
}
fn contents(document: &Value, url: &str) -> Vec<Value> {
    document["layers"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|layer| {
            layer["objects"][url]
                .as_array()
                .into_iter()
                .flatten()
                .map(|row| json!({"layerId":layer["id"],"row":row}))
        })
        .collect()
}
pub fn write(backend: &Backend, id: &str, mut next: Value) -> Result<Value> {
    let current = read(backend, id)?;
    validate(&next)?;
    if next["revision"] != current["document"]["revision"] {
        bail!("批注已被其他窗口更新；本地修改已保留，请重新读取以继续");
    }
    let stale_urls: HashSet<_> = current["stalePages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let book = backend.book(id)?;
    let pages = book["pages"].as_array().unwrap();
    let mut bindings = BTreeMap::new();
    for layer in next["layers"].as_array().unwrap() {
        for (url, rows) in layer["objects"].as_object().unwrap() {
            if rows.as_array().unwrap().is_empty() {
                continue;
            }
            let binding = if stale_urls.contains(url.as_str()) {
                let previous = contents(&current["document"], url);
                if contents(&next, url)
                    .iter()
                    .any(|row| !previous.contains(row))
                {
                    bail!("原图已变化，请清空该页旧批注后重新绘制");
                }
                current["document"]["pages"][url].clone()
            } else {
                let page = pages
                    .iter()
                    .find(|p| p["url"] == *url)
                    .context("批注页面不存在")?;
                let binding = &next["pages"][url];
                if page["width"] != binding["width"] || page["height"] != binding["height"] {
                    bail!("批注页面尺寸不匹配");
                }
                let hash = signature(backend, id, url)?;
                if binding["signature"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty() && s != hash)
                {
                    bail!("原图已变化，请清空该页旧批注后重新绘制");
                }
                json!({"width":page["width"],"height":page["height"],"signature":hash})
            };
            bindings.insert(url.clone(), binding);
        }
    }
    next["pages"] = serde_json::to_value(bindings)?;
    next["revision"] = json!(current["document"]["revision"].as_u64().unwrap() + 1);
    storage::write(&backend.dir(id)?.join("comic-annotations.json"), &next)?;
    Ok(json!({"stalePages":stale(backend,id,&next)?,"document":next}))
}
