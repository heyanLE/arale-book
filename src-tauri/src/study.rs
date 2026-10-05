//! Study rules live in shared TS. Native owns checkpoints, source leases and export grants.
use crate::{
    dictionaries, segments,
    storage::{self, Backend},
    State,
};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Cursor, Write},
    path::PathBuf,
    sync::Mutex,
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const SCHEMA: &str = include_str!(concat!(env!("OUT_DIR"), "/anki-schema.sql"));
fn manual_directory(root: &std::path::Path, directory: &str) -> Result<PathBuf> {
    let path = PathBuf::from(directory)
        .canonicalize()
        .context("任务目录已被删除，请重新准备任务")?;
    let allowed = root.join("temp/manual-ai").canonicalize()?;
    if !path.starts_with(allowed) || !path.is_dir() {
        bail!("旧任务目录不在临时任务区，请清除后重新生成");
    }
    Ok(path)
}
fn hash(value: &Value) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
#[derive(Default)]
struct Session {
    owner: String,
    busy: HashSet<String>,
    grants: HashMap<String, (PathBuf, bool)>,
    requests: HashSet<String>,
}
pub struct Study {
    session: Mutex<Session>,
    queue: Mutex<Value>,
    root: PathBuf,
}
impl Study {
    pub fn new(root: PathBuf) -> Result<Self> {
        let mut queue = storage::read(
            &root.join("study-queue.json"),
            json!({"active":null,"pending":[],"recent":[]}),
        )?;
        interrupt(&mut queue);
        storage::write(&root.join("study-queue.json"), &queue)?;
        Ok(Self {
            session: Mutex::new(Session::default()),
            queue: Mutex::new(queue),
            root,
        })
    }
    pub fn busy(&self, id: &str) -> bool {
        if self.session.lock().unwrap().busy.contains(id) {
            return true;
        }
        let q = self.queue.lock().unwrap();
        q["active"]["bookId"] == id
            || q["pending"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|row| row["bookId"] == id))
    }
    fn owner<'a>(&'a self, owner: &str) -> Result<std::sync::MutexGuard<'a, Session>> {
        let session = self.session.lock().unwrap();
        if owner.is_empty() || session.owner != owner {
            bail!("制卡后台已重新加载，旧任务不能继续保存");
        }
        Ok(session)
    }
    pub fn begin_http(&self, owner: &str, id: &str) -> Result<()> {
        uuid::Uuid::parse_str(id)?;
        self.owner(owner)?.requests.insert(id.into());
        Ok(())
    }
    pub fn finish_http(&self, id: &str) {
        self.session.lock().unwrap().requests.remove(id);
    }
    pub fn dispatch(&self, app: &tauri::AppHandle, action: &str, args: &[Value]) -> Result<Value> {
        let text = |i| args.get(i).and_then(Value::as_str).context("缺少制卡参数");
        if action == "study:initialize" {
            let owner = text(0)?;
            uuid::Uuid::parse_str(owner)?;
            let mut session = self.session.lock().unwrap();
            if session.owner != owner {
                for id in &session.requests {
                    app.state::<crate::services::Services>().cancel(id)?;
                }
                *session = Session {
                    owner: owner.into(),
                    ..Session::default()
                };
                let mut q = self.queue.lock().unwrap();
                interrupt(&mut q);
                storage::write(&self.root.join("study-queue.json"), &q)?;
            }
            return Ok(self.queue.lock().unwrap().clone());
        }
        let owner = text(0)?;
        if action == "study:select" {
            drop(self.owner(owner)?);
            let kind = text(1)?;
            let is_dir = kind == "manualAi";
            let chosen = {
                if is_dir {
                    let dir = self.root.join("temp").join("manual-ai");
                    fs::create_dir_all(&dir)?;
                    Some(dir)
                } else {
                    #[cfg(debug_assertions)]
                    if crate::smoke_enabled() {
                        let dir = self.root.join("study-exports");
                        fs::create_dir_all(&dir)?;
                        Some(if is_dir {
                            dir
                        } else {
                            dir.join(format!(
                                "{}.{}",
                                uuid::Uuid::new_v4(),
                                if kind == "package" { "apkg" } else { "tsv" }
                            ))
                        })
                    } else {
                        pick(app, kind)?
                    }
                    #[cfg(not(debug_assertions))]
                    {
                        pick(app, kind)?
                    }
                }
            };
            let Some(path) = chosen else {
                return Ok(Value::Null);
            };
            let path = if is_dir {
                path.canonicalize()?
            } else {
                path.parent()
                    .context("无效导出路径")?
                    .canonicalize()?
                    .join(path.file_name().context("无效文件名")?)
            };
            let token = uuid::Uuid::new_v4().to_string();
            self.owner(owner)?
                .grants
                .insert(token.clone(), (path.clone(), is_dir));
            return Ok(json!({"token":token,"path":path.to_string_lossy()}));
        }
        // Lock order: storage then study session. Dialogs are never under either lock.
        let state = app.state::<State>();
        let backend = state.lock().unwrap();
        let mut session = self.owner(owner)?;
        match action {
            "study:manualAiReveal" => {
                let id = text(1)?;
                backend.book(id)?;
                let kind = text(2)?;
                if !["filter", "cards"].contains(&kind) {
                    bail!("未知自行 AI 阶段");
                }
                let list = storage::read(
                    &backend
                        .root
                        .join("library")
                        .join(id)
                        .join("study-list.json"),
                    Value::Null,
                )?;
                let directory = list["workflow"]["manualAi"][kind]["directory"]
                    .as_str()
                    .context("请先生成任务文件")?;
                let path = manual_directory(&self.root, directory)?;
                drop(session);
                drop(backend);
                crate::system::open_directory(&path)?;
                Ok(Value::Null)
            }
            "study:releaseExport" => {
                session.grants.remove(text(1)?);
                Ok(Value::Null)
            }
            "study:lease" => {
                let id = text(1)?;
                backend.book(id)?;
                if args.get(2) == Some(&Value::Bool(true)) {
                    if app.state::<crate::ocr::Ocr>().is_running(id) {
                        bail!("OCR 正在改变文字层，请稍后制卡");
                    }
                    if !session.busy.insert(id.into()) {
                        bail!("这本书已有制卡操作");
                    }
                } else {
                    session.busy.remove(id);
                }
                Ok(Value::Null)
            }
            "study:snapshot" => snapshot(&backend, text(1)?),
            "study:commit" => {
                let id = text(1)?;
                let expected = args.get(2).context("缺少版本")?;
                let value = args.get(3).context("缺少词单")?;
                commit(&backend, id, expected, value)
            }
            "study:publish" => {
                let channel = text(1)?;
                let payload = args.get(2).context("缺少事件")?;
                if channel == "study:queue" {
                    if !payload["pending"].is_array() || !payload["recent"].is_array() {
                        bail!("无效队列");
                    }
                    storage::write(&self.root.join("study-queue.json"), payload)?;
                    *self.queue.lock().unwrap() = payload.clone();
                } else if !["study:progress", "study:workflow-progress", "study:done"]
                    .contains(&channel)
                {
                    bail!("无效制卡事件");
                }
                crate::event(app, channel, payload.clone());
                Ok(Value::Null)
            }
            "study:writeExport" => {
                let token = text(1)?;
                let relative = text(2)?;
                let (grant, directory) = session.grants.get(token).context("导出位置未获选择")?;
                let path = if *directory {
                    let components: Vec<_> = relative.split('/').collect();
                    if components.len() != 2
                        || !components[0].starts_with("aralebook-")
                        || storage::valid_id(components[0]).is_err()
                        || !(components[1] == "prompts.md"
                            || components[1].starts_with("task-")
                                && components[1].ends_with(".md")
                                && components[1]
                                    .bytes()
                                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'.'))
                    {
                        bail!("非法任务文件路径");
                    }
                    let child = grant.join(components[0]);
                    fs::create_dir_all(&child)?;
                    let child = storage::inside(grant, components[0])?;
                    let target = child.join(components[1]);
                    if target.exists() {
                        bail!("任务文件已存在，保留原文件");
                    }
                    target
                } else {
                    if !relative.is_empty() {
                        bail!("非法导出路径");
                    }
                    grant.clone()
                };
                let bytes = STANDARD.decode(text(3)?)?;
                atomic_bytes(&path, &bytes)?;
                Ok(Value::Null)
            }
            "study:sqlite" => Ok(json!(
                STANDARD.encode(sqlite(args.get(1).context("缺少 Anki 数据")?)?)
            )),
            "study:image" => image(
                &backend,
                text(1)?,
                args.get(2).context("缺少出处")?,
                text(3)?,
            ),
            _ => bail!("未知制卡原生调用"),
        }
    }
}
fn interrupt(queue: &mut Value) {
    let mut recent = queue["recent"].as_array().cloned().unwrap_or_default();
    let mut interrupted = queue["pending"].as_array().cloned().unwrap_or_default();
    if queue["active"].is_object() {
        interrupted.insert(0, queue["active"].clone());
    }
    for mut entry in interrupted.into_iter().rev() {
        entry["status"] = json!("failed");
        entry["finishedAt"] = json!(storage::now());
        entry["error"] = json!("制卡后台已重新加载；已保存检查点，请手动续跑");
        entry["message"] = entry["error"].clone();
        recent.insert(0, entry);
    }
    recent.truncate(20);
    *queue = json!({"active":null,"pending":[],"recent":recent});
}
fn pick(app: &tauri::AppHandle, kind: &str) -> Result<Option<PathBuf>> {
    let dialog = app.dialog().file();
    let result = match kind {
        "package" => dialog
            .set_title("导出 Anki 牌组")
            .set_file_name("aralebook.apkg")
            .add_filter("Anki", &["apkg"])
            .blocking_save_file(),
        "text" => dialog
            .set_title("导出 Anki 文本")
            .set_file_name("aralebook.tsv")
            .add_filter("TSV", &["tsv"])
            .blocking_save_file(),
        _ => bail!("未知导出类型"),
    };
    result
        .map(|p| p.into_path().map_err(Into::into))
        .transpose()
}
fn snapshot(backend: &Backend, id: &str) -> Result<Value> {
    let book = backend.book(id)?;
    let list = storage::read(&backend.dir(id)?.join("study-list.json"), Value::Null)?;
    let segments = segments::read(backend, id)?;
    let mut dicts = dictionaries::list(backend)?;
    dicts.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let manga = storage::read(&backend.dir(id)?.join("content/manga.json"), Value::Null)?;
    Ok(
        json!({"book":book,"segments":segments,"list":list,"revision":hash(&list)?,
        "source":hash(&json!([book["pages"],book["direction"],manga,segments]))?,"dictionary":hash(&json!(dicts))?}),
    )
}
fn commit(backend: &Backend, id: &str, expected: &Value, value: &Value) -> Result<Value> {
    let current = snapshot(backend, id)?;
    for key in ["revision", "source", "dictionary"] {
        if current[key] != expected[key] {
            bail!("制卡数据、文字层或词典已变化，请重新提交任务");
        }
    }
    if value["bookId"] != id || !value["candidates"].is_array() {
        bail!("学习词单格式错误");
    }
    storage::write(&backend.dir(id)?.join("study-list.json"), value)?;
    Ok(json!({"revision":hash(value)?}))
}
fn atomic_bytes(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().context("无效路径")?)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| e.error)?;
    Ok(())
}
fn sqlite(commands: &Value) -> Result<Vec<u8>> {
    let commands = commands.as_array().context("SQL 必须为数组")?;
    if commands
        .first()
        .and_then(|v| v["sql"].as_str())
        .map(|s| s.replace("\r\n", "\n"))
        != Some(SCHEMA.into())
    {
        bail!("非法 Anki schema");
    }
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("collection.anki2");
    let mut connection = rusqlite::Connection::open(&path)?;
    {
        let tx = connection.transaction()?;
        tx.execute_batch(SCHEMA)?;
        for command in commands.iter().skip(1) {
            let sql = command["sql"].as_str().context("缺少 SQL")?;
            let params = command["params"].as_array().context("缺少绑定参数")?;
            let count = match sql {
                "INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)" => 13,
                "INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)" => 11,
                "INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)" => 18,
                _ => bail!("只允许 Anki 参数化写入"),
            };
            if params.len() != count {
                bail!("Anki 参数数量错误");
            }
            let values: Vec<rusqlite::types::Value> = params
                .iter()
                .map(|p| -> Result<_> {
                    Ok(match p {
                        Value::Null => rusqlite::types::Value::Null,
                        Value::String(s) => s.clone().into(),
                        Value::Number(n) if n.as_i64().is_some() => n.as_i64().unwrap().into(),
                        _ => bail!("无效 Anki 参数"),
                    })
                })
                .collect::<Result<_>>()?;
            tx.execute(sql, rusqlite::params_from_iter(values))?;
        }
        tx.commit()?;
    }
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        bail!("Anki SQLite 校验失败：{integrity}");
    }
    connection.close().map_err(|(_, e)| e)?;
    Ok(fs::read(path)?)
}
fn image(backend: &Backend, id: &str, occurrence: &Value, mode: &str) -> Result<Value> {
    let reference = occurrence["ref"].as_str().context("缺少漫画出处")?;
    let (url, block) = reference
        .strip_prefix("page:")
        .and_then(|s| s.rsplit_once('#'))
        .context("无效漫画出处")?;
    let index: usize = block.parse()?;
    let book = backend.book(id)?;
    let page = book["pages"]
        .as_array()
        .context("缺少页图")?
        .iter()
        .position(|p| p["url"] == url)
        .context("原文页已变化")?;
    let raw = storage::read(&backend.dir(id)?.join("content/manga.json"), Value::Null)?;
    let text = crate::page_text_from_raw(book, page, &raw)?;
    let block = text["blocks"].get(index).context("原文文字框已变化")?;
    let joined: String = block["lines"]
        .as_array()
        .context("缺少原文")?
        .iter()
        .map(|v| v.as_str().unwrap_or(""))
        .collect();
    if occurrence["text"] != joined {
        bail!("原文已变化，请重新生成候选");
    }
    let utf16: Vec<u16> = joined.encode_utf16().collect();
    let start = occurrence["start"].as_u64().context("无效词起点")? as usize;
    let end = occurrence["end"].as_u64().context("无效词终点")? as usize;
    if start >= end || end > utf16.len() || String::from_utf16(&utf16[start..end]).is_err() {
        bail!("词偏移与原文不符");
    }
    let path = storage::inside(&backend.dir(id)?.join("content"), url)?;
    if mode == "validate" {
        return Ok(Value::Null);
    }
    let mut img = image::open(path)?;
    if mode == "crop" {
        let b = block["box"].as_array().context("无效文字框")?;
        if b.len() != 4 {
            bail!("无效文字框");
        }
        let v: Vec<f64> = b
            .iter()
            .map(|x| x.as_f64().context("无效文字框"))
            .collect::<Result<_>>()?;
        let padding = (img.width().min(img.height()) as f64 * 0.004)
            .round()
            .max(8.0);
        let x1 = (v[0] - padding).floor().max(0.0);
        let y1 = (v[1] - padding).floor().max(0.0);
        let x2 = (v[2] + padding).ceil().min(img.width() as f64);
        let y2 = (v[3] + padding).ceil().min(img.height() as f64);
        if x2 <= x1 || y2 <= y1 {
            bail!("文字框不在原图内");
        }
        img = img.crop_imm(x1 as u32, y1 as u32, (x2 - x1) as u32, (y2 - y1) as u32);
    } else if mode != "page" {
        bail!("未知配图模式");
    }
    let max = if mode == "crop" { 1600 } else { 2600 };
    let side = img.width().max(img.height());
    if side > max {
        img = img.resize_exact(
            (img.width() as f64 * max as f64 / side as f64).round() as u32,
            (img.height() as f64 * max as f64 / side as f64).round() as u32,
            image::imageops::FilterType::Lanczos3,
        );
    }
    let mut bytes = Cursor::new(Vec::new());
    if mode == "crop" {
        img.write_to(&mut bytes, image::ImageFormat::Png)?;
    } else {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 86)
            .encode_image(&img.to_rgb8())?;
    }
    let bytes = bytes.into_inner();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    Ok(
        json!({"name":format!("aralebook_{}{}.{}",if mode == "page" {"page_"} else {""},&digest[..24],if mode == "page" {"jpg"} else {"png"}),"data":STANDARD.encode(bytes)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sqlite_rejects_untrusted_sql() {
        assert!(sqlite(&json!([{ "sql":"ATTACH DATABASE 'x' AS x" }])).is_err());
        assert!(sqlite(&json!([{ "sql":SCHEMA }, {"sql":"DROP TABLE col", "params":[]}])).is_err());
        let bytes = sqlite(&json!([{ "sql":SCHEMA }])).unwrap();
        assert!(bytes.starts_with(b"SQLite format 3\0"));
    }

    #[test]
    fn manual_tasks_reveal_only_existing_application_temp_directories() {
        let root = tempfile::tempdir().unwrap();
        let inside = root.path().join("temp/manual-ai/aralebook-cards-test");
        fs::create_dir_all(&inside).unwrap();
        assert_eq!(
            manual_directory(root.path(), inside.to_str().unwrap()).unwrap(),
            inside.canonicalize().unwrap()
        );
        assert!(manual_directory(root.path(), root.path().to_str().unwrap()).is_err());
        assert!(manual_directory(root.path(), inside.join("missing").to_str().unwrap()).is_err());
    }
    #[test]
    fn interrupted_queue_preserves_history() {
        let mut q = json!({"active":{"id":"a"},"pending":[{"id":"b"}],"recent":[{"id":"old"}]});
        interrupt(&mut q);
        assert!(q["active"].is_null());
        assert_eq!(q["recent"].as_array().unwrap().len(), 3);
        assert_eq!(q["recent"][0]["status"], "failed");
        interrupt(&mut q);
        assert_eq!(q["recent"].as_array().unwrap().len(), 3);
    }
    #[test]
    fn snapshot_commit_rejects_stale_source_and_preserves_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut backend = Backend::load(dir.path().into()).unwrap();
        backend
            .add(json!({"id":"test","format":"comic","pages":[],"direction":"rtl"}))
            .unwrap();
        let original = snapshot(&backend, "test").unwrap();
        let list = json!({"bookId":"test","candidates":[]});
        commit(&backend, "test", &original, &list).unwrap();
        assert!(commit(&backend, "test", &original, &list).is_err());
        let current = snapshot(&backend, "test").unwrap();
        storage::write(
            &backend.dir("test").unwrap().join("content/manga.json"),
            &json!({"pages":[]}),
        )
        .unwrap();
        assert!(commit(&backend, "test", &current, &list).is_err());
        let current = snapshot(&backend, "test").unwrap();
        let dictionary = backend.root.join("dictionaries/dict_test");
        fs::create_dir_all(&dictionary).unwrap();
        storage::write(
            &dictionary.join("meta.json"),
            &json!({"id":"dict_test","title":"test"}),
        )
        .unwrap();
        assert!(commit(&backend, "test", &current, &list).is_err());
        let file = backend.dir("test").unwrap().join("study-list.json");
        fs::write(&file, b"broken").unwrap();
        assert!(snapshot(&backend, "test").is_err());
        assert_eq!(fs::read(file).unwrap(), b"broken");
    }
    #[test]
    fn replaced_worker_cannot_save_or_keep_a_lease() {
        let dir = tempfile::tempdir().unwrap();
        let service = Study::new(dir.path().into()).unwrap();
        service.session.lock().unwrap().owner = "new".into();
        assert!(service.owner("old").is_err());
        assert!(service.owner("").is_err());
        service.owner("new").unwrap().busy.insert("book".into());
        assert!(service.busy("book"));
    }
}
