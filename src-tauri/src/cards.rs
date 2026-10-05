use crate::storage::{self, Backend};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

pub fn list(backend: &Backend, book: &str) -> Result<Vec<Value>> {
    backend.book(book)?;
    let raw = storage::read(
        &backend.dir(book)?.join("cards.json"),
        json!({"version":1,"cards":[]}),
    )?;
    let mut cards = raw["cards"]
        .as_array()
        .context("词卡文件格式错误，原文件已保留")?
        .clone();
    cards.sort_by(|a, b| {
        b["createdAt"]
            .as_u64()
            .cmp(&a["createdAt"].as_u64())
            .then_with(|| b["id"].as_str().cmp(&a["id"].as_str()))
    });
    Ok(cards)
}
fn source(input: &Value) -> Value {
    match input["kind"].as_str() {
        Some("comic") if input["pageIndex"].is_u64() && input["pageUrl"].is_string() => {
            json!({"kind":"comic", "pageIndex":input["pageIndex"], "pageUrl":input["pageUrl"]})
        }
        Some("epub") if input["spineIndex"].is_u64() => {
            json!({"kind":"epub", "spineIndex":input["spineIndex"]})
        }
        _ => Value::Null,
    }
}
pub fn mutate(backend: &Backend, book: &str, channel: &str, args: &[Value]) -> Result<Value> {
    let mut cards = list(backend, book)?;
    let now = storage::now();
    let value = if channel == "cards:add" {
        let draft = args.get(1).context("缺少词卡内容")?;
        let string = |key: &str| draft[key].as_str().unwrap_or("");
        let word = if !string("word").trim().is_empty() {
            string("word")
        } else if !string("dictionaryExpression").is_empty() {
            string("dictionaryExpression")
        } else {
            "（未命名）"
        };
        if let Some(existing) = cards.iter_mut().find(|card| {
            card["word"] == word && card["dictionaryExpression"] == string("dictionaryExpression")
        }) {
            existing["context"] = json!(string("context"));
            existing["offset"] = json!(draft["offset"].as_u64().unwrap_or(0));
            existing["length"] = json!(draft["length"].as_u64().unwrap_or(0));
            existing["updatedAt"] = json!(now);
            let new_source = source(&draft["source"]);
            if !new_source.is_null() {
                existing["source"] = new_source;
            }
            existing.clone()
        } else {
            let mut card = json!({"id":storage::id(),"word":word,"context":string("context"),"offset":draft["offset"].as_u64().unwrap_or(0),
                "length":draft["length"].as_u64().unwrap_or(0),"source":source(&draft["source"]),"note":"","analyses":[],"createdAt":now,"updatedAt":now});
            for key in [
                "dictionaryExpression",
                "dictionaryId",
                "dictionaryTitle",
                "dictionaryReading",
            ] {
                card[key] = json!(string(key));
            }
            cards.push(card.clone());
            card
        }
    } else {
        let id = args.get(1).and_then(Value::as_str).context("缺少词卡 ID")?;
        if channel == "cards:remove" {
            let previous = cards.len();
            cards.retain(|card| card["id"] != id);
            json!(previous != cards.len())
        } else if channel == "cards:update" {
            let patch = args.get(2).context("缺少词卡修改")?;
            if let Some(card) = cards.iter_mut().find(|card| card["id"] == id) {
                if let Some(word) = patch["word"].as_str().filter(|s| !s.trim().is_empty()) {
                    card["word"] = json!(word);
                }
                if let Some(note) = patch["note"].as_str() {
                    card["note"] = json!(note);
                }
                if let Some(analyses) = patch.get("analyses") {
                    if !analyses.is_array() {
                        bail!("分析必须为数组");
                    }
                    card["analyses"] = analyses.clone();
                }
                card["updatedAt"] = json!(now);
                card.clone()
            } else {
                Value::Null
            }
        } else {
            bail!("未知词卡操作")
        }
    };
    storage::write(
        &backend.dir(book)?.join("cards.json"),
        &json!({"version":1,"cards":cards}),
    )?;
    Ok(value)
}
