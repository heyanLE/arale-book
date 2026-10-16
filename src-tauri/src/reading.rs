//! Personal reading records, independent from OCR, word cards and machine outputs.
use crate::storage::{self, Backend};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    book_id: String,
    book_title: String,
    kind: String,
    title: String,
    quote: String,
    note: String,
    position: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_url: Option<String>,
    created_at: u64,
    updated_at: u64,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Day {
    day: String,
    book_id: String,
    book_title: String,
    active_ms: u64,
    locations: Vec<String>,
    lookups: u64,
    words: BTreeMap<String, u64>,
}
#[derive(Serialize, Deserialize)]
struct Store {
    version: u32,
    entries: Vec<Entry>,
    days: Vec<Day>,
    seen: Vec<String>,
}

fn load(backend: &Backend) -> Result<Store> {
    let value = storage::read(&backend.root.join("reading-journal.json"), json!({"version":1,"entries":[],"days":[],"seen":[]}))?;
    let store: Store = serde_json::from_value(value).context("阅读记录格式错误，原文件已保留")?;
    if store.version != 1 { bail!("不支持此阅读记录版本，原文件已保留"); }
    Ok(store)
}
fn persist(backend: &Backend, store: &Store) -> Result<()> {
    storage::write(&backend.root.join("reading-journal.json"), &serde_json::to_value(store)?)
}
fn text(value: &Value, key: &str, max: usize) -> Result<String> {
    let value = value[key].as_str().context(format!("缺少 {key}"))?;
    if value.chars().count() > max || value.contains('\0') { bail!("{key} 内容过长或无效"); }
    Ok(value.to_owned())
}
fn position(book: &Value, input: &Value) -> Result<Value> {
    let id = book["id"].as_str().context("缺少书 ID")?;
    if input["bookId"] != id { bail!("阅读位置不属于此书"); }
    let comic = book["readerMode"].as_str().unwrap_or(book["format"].as_str().unwrap_or("")) == "comic";
    let key = if comic { "pageIndex" } else { "spineIndex" };
    let index = input[key].as_u64().context("阅读位置无效")?;
    let list = book[if comic { "pages" } else { "spine" }].as_array().context("书籍没有可读内容")?;
    if index as usize >= list.len() { bail!("阅读位置超出书籍范围"); }
    let mut result = json!({"bookId":id,"updatedAt":storage::now()});
    result[key] = json!(index);
    if !comic {
        if let Some(href) = input["spineHref"].as_str() {
            if list[index as usize]["href"] != href { bail!("章节位置已失效，请重新定位"); }
        }
        if input["charOffset"].as_u64().unwrap_or(0) > 100_000_000 { bail!("原文偏移无效"); }
        result["charOffset"] = json!(input["charOffset"].as_u64().unwrap_or(0));
        result["spineHref"] = list[index as usize]["href"].clone();
    }
    Ok(result)
}
pub fn snapshot(backend: &Backend) -> Result<Value> {
    let store = load(backend)?;
    let entries: Vec<Value> = store.entries.into_iter().map(|entry| {
        let available = backend.book(&entry.book_id).is_ok();
        let mut value = serde_json::to_value(entry).unwrap();
        value["available"] = json!(available);
        value
    }).collect();
    Ok(json!({"entries":entries,"days":store.days}))
}
pub fn save(backend: &Backend, draft: &Value) -> Result<Value> {
    let id = draft["bookId"].as_str().context("缺少书 ID")?;
    let book = backend.book(id)?;
    let kind = text(draft, "kind", 20)?;
    if !["bookmark", "excerpt", "note"].contains(&kind.as_str()) { bail!("未知阅读记录类型"); }
    let title = text(draft, "title", 200)?;
    let quote = text(draft, "quote", 20_000)?;
    let note = text(draft, "note", 50_000)?;
    if kind == "excerpt" && quote.trim().is_empty() { bail!("摘录不能为空"); }
    if kind == "note" && note.trim().is_empty() { bail!("笔记不能为空"); }
    let pos = position(book, &draft["position"])?;
    let page_url = if let Some(index) = pos["pageIndex"].as_u64() {
        Some(book["pages"][index as usize]["url"].as_str().context("页图路径无效")?.to_owned())
    } else { None };
    if let Some(expected) = draft["pageUrl"].as_str() {
        if page_url.as_deref() != Some(expected) { bail!("页图位置已失效，请重新定位"); }
    }
    let mut store = load(backend)?;
    let existing = draft["id"].as_str();
    let previous = if let Some(entry_id) = existing {
        let old = store.entries.iter().find(|entry| entry.id == entry_id && entry.book_id == id).context("阅读记录已删除，请刷新")?;
        if Some(old.updated_at) != draft["updatedAt"].as_u64() { bail!("阅读记录已变更，请刷新后重试"); }
        Some(old.clone())
    } else { None };
    if existing.is_none() && kind == "bookmark" {
        if let Some(old) = store.entries.iter().find(|entry| entry.book_id == id && entry.kind == kind && entry.position["pageIndex"] == pos["pageIndex"] && entry.position["spineIndex"] == pos["spineIndex"] && entry.position["charOffset"] == pos["charOffset"]) {
            return Ok(serde_json::to_value(old)?);
        }
    }
    let now = storage::now().max(previous.as_ref().map(|old| old.updated_at + 1).unwrap_or(0));
    let entry = Entry { id: previous.as_ref().map(|old| old.id.clone()).unwrap_or_else(storage::id), book_id: id.to_owned(),
        book_title: book["title"].as_str().unwrap_or("未命名").to_owned(), kind, title, quote, note,
        position: pos, page_url, created_at: previous.map(|old| old.created_at).unwrap_or(now), updated_at: now };
    store.entries.retain(|old| old.id != entry.id);
    store.entries.insert(0, entry.clone());
    persist(backend, &store)?;
    Ok(serde_json::to_value(entry)?)
}
pub fn remove(backend: &Backend, id: &str, revision: u64) -> Result<Value> {
    let mut store = load(backend)?;
    let entry = store.entries.iter().find(|entry| entry.id == id).context("阅读记录已删除，请刷新")?;
    if entry.updated_at != revision { bail!("阅读记录已变更，请刷新后重试"); }
    let removed = serde_json::to_value(entry)?;
    store.entries.retain(|entry| entry.id != id);
    persist(backend, &store)?;
    Ok(removed)
}
pub fn record(backend: &Backend, input: &Value) -> Result<Value> {
    let id = text(input, "id", 100)?;
    storage::valid_id(&id)?;
    let book_id = text(input, "bookId", 100)?;
    storage::valid_id(&book_id)?;
    // Removal may race a persisted outbox packet. Acknowledge it without recreating the book.
    let book = match backend.book(&book_id) { Ok(book) => book, Err(_) => return Ok(json!(true)) };
    let day = text(input, "day", 10)?;
    let parts: Vec<_> = day.split('-').collect();
    let valid_day = parts.len() == 3 && parts[0].len() == 4 && parts[1].len() == 2 && parts[2].len() == 2 &&
        parts[0].parse::<u32>().is_ok_and(|year| (2000..=9999).contains(&year)) &&
        parts[1].parse::<u32>().is_ok_and(|month| (1..=12).contains(&month)) &&
        parts[2].parse::<u32>().is_ok_and(|day| (1..=31).contains(&day));
    if !valid_day { bail!("统计日期无效"); }
    let year = parts[0].parse::<u32>()?;
    let month = parts[1].parse::<usize>()?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = [31, if leap {29} else {28}, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if parts[2].parse::<u32>()? > days_in_month[month - 1] { bail!("统计日期无效"); }
    let ms = input["activeMs"].as_u64().filter(|ms| *ms <= 60_000).context("统计时长无效")?;
    let locations = input["locations"].as_array().context("缺少阅读位置")?;
    if locations.len() > 4 { bail!("阅读位置过多"); }
    for location in locations {
        let location = location.as_str().context("阅读位置无效")?;
        let (kind, index) = location.split_once(':').context("阅读位置无效")?;
        let index: usize = index.parse().context("阅读位置无效")?;
        let mode = book["readerMode"].as_str().unwrap_or(book["format"].as_str().unwrap_or(""));
        let list = match (kind, mode) { ("page", "comic") => &book["pages"], ("chapter", "epub") => &book["spine"], _ => bail!("阅读位置类型无效") };
        if index >= list.as_array().context("书籍没有可读内容")?.len() { bail!("阅读位置越界"); }
    }
    let word = input.get("word").map(|_| text(input, "word", 200)).transpose()?;
    let mut store = load(backend)?;
    if store.seen.contains(&id) { return Ok(json!(true)); }
    let row_index = store.days.iter().position(|row| row.book_id == book_id && row.day == day).unwrap_or_else(|| {
        store.days.push(Day { day: day.clone(), book_id: book_id.clone(), book_title: book["title"].as_str().unwrap_or("未命名").to_owned(), active_ms: 0, locations: vec![], lookups: 0, words: BTreeMap::new() }); store.days.len() - 1
    });
    let row = &mut store.days[row_index];
    row.active_ms += ms;
    for location in locations { let value = location.as_str().unwrap().to_owned(); if !row.locations.contains(&value) { row.locations.push(value); } }
    if let Some(word) = word.filter(|word| !word.trim().is_empty()) { row.lookups += 1; *row.words.entry(word).or_default() += 1; }
    store.seen.push(id);
    if store.seen.len() > 4096 { store.seen.remove(0); }
    persist(backend, &store)?;
    Ok(json!(true))
}

pub fn markdown(backend: &Backend, ids: &[Value]) -> Result<String> {
    if ids.is_empty() || ids.len() > 100_000 { bail!("请选择要导出的阅读记录"); }
    let store = load(backend)?;
    let mut result = String::new();
    for id in ids {
        let id = id.as_str().context("记录 ID 无效")?;
        let entry = store.entries.iter().find(|entry| entry.id == id).context("记录已删除，请刷新后导出")?;
        let location = if let Some(index) = entry.position["pageIndex"].as_u64() {
            format!("第 {} 页", index + 1)
        } else { format!("第 {} 章 · 字符 {}", entry.position["spineIndex"].as_u64().unwrap_or(0) + 1, entry.position["charOffset"].as_u64().unwrap_or(0)) };
        result.push_str(&format!("## {}\n\n{} · {}\n\n", entry.title.replace(['\r','\n'], " "), entry.book_title.replace(['\r','\n'], " "), location));
        if !entry.quote.is_empty() {
            for line in entry.quote.split('\n') { result.push_str(&format!("> {line}\n")); }
            result.push('\n');
        }
        result.push_str(&entry.note); result.push_str("\n\n");
    }
    Ok(result)
}
pub fn write_export(path: &std::path::Path, text: &str) -> Result<()> {
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new_in(path.parent().context("导出目录无效")?)?;
    file.write_all(text.as_bytes())?; file.as_file().sync_all()?;
    file.persist(path).map_err(|error| error.error).context("无法保存导出文件，原文件已保留")?;
    Ok(())
}
