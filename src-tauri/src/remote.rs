//! Authenticated server connections and disposable content caches. Local library files
//! and personal learning sidecars are never imported into or replaced by the server.
use crate::storage::{self, Backend};
use anyhow::{bail, Context, Result};
use reqwest::{Client, Method};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
mod assets;
mod sync;

pub struct Remote {
    root: PathBuf,
    client: Client,
    gate: tokio::sync::Mutex<()>,
    config_gate: Mutex<()>,
    state_gate: Mutex<()>,
    active_book: Mutex<Option<String>>,
    sync_meta: Mutex<Value>,
    asset_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    asset_slots: tokio::sync::Semaphore,
    cover_slots: tokio::sync::Semaphore,
    prefetch_slots: tokio::sync::Semaphore,
    prefetch_epochs: Mutex<HashMap<String, u64>>,
}
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str().with_context(|| format!("服务端数据缺少 {k}"))
}
fn qualified(server: &str, book: &str) -> Result<String> {
    let server = uuid::Uuid::parse_str(server)?.simple().to_string();
    storage::valid_id(book)?;
    let id = format!("rs_{server}_{book}");
    storage::valid_id(&id)?;
    Ok(id)
}
fn content_changed(state: &Value, book: &Value) -> bool {
    let revision = &book["remote"]["revision"];
    (!state["next"].is_null()
        && state["nextContentRevision"].is_string()
        && state["nextContentRevision"] != *revision)
        || (!state["pending"].is_null() && state["pending"]["contentRevision"] != *revision)
        || (state["conflict"]["bookRevision"].is_string()
            && state["conflict"]["bookRevision"] != *revision)
        || (!state["conflict"].is_null() && state["conflict"]["contentRevision"] != *revision)
}
fn digest(v: &str) -> bool {
    v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit())
}
fn lock(backend: &Mutex<Backend>) -> Result<std::sync::MutexGuard<'_, Backend>> {
    backend.lock().map_err(|_| anyhow::anyhow!("书库锁不可用"))
}
fn public_config(config: &Value) -> Value {
    let mut value = config.clone();
    for c in value["connections"].as_array_mut().unwrap() {
        c["hasToken"] = json!(!c["token"].as_str().unwrap_or("").is_empty());
        c["autoSync"] = json!(c["autoSync"] != false);
        c.as_object_mut().unwrap().remove("token");
    }
    value.as_object_mut().unwrap().remove("deviceId");
    value
}
fn normalize_url(value: &str) -> Result<String> {
    let mut url = reqwest::Url::parse(value.trim()).context("服务器 URL 格式错误")?;
    if !["https", "http"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("请输入 http(s) 服务器 URL，不要包含账号、查询参数或片段");
    }
    if !url.path().ends_with('/') {
        let p = format!("{}/", url.path());
        url.set_path(&p);
    }
    Ok(url.to_string())
}
impl Remote {
    pub fn new(root: PathBuf) -> Result<Self> {
        let mut sync_meta = storage::read(&root.join("remote/sync-status.json"), json!({}))?;
        if let Some(states) = sync_meta.as_object_mut() {
            for state in states.values_mut() {
                if state["phase"] == "syncing" {
                    state["phase"] = json!("idle");
                }
            }
        } else {
            bail!("同步状态缓存格式错误");
        }
        let this = Self {
            root,
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(25))
                .connect_timeout(Duration::from_secs(5))
                .build()?,
            gate: tokio::sync::Mutex::new(()),
            config_gate: Mutex::new(()),
            state_gate: Mutex::new(()),
            active_book: Mutex::new(None),
            sync_meta: Mutex::new(sync_meta),
            asset_locks: Mutex::new(HashMap::new()),
            asset_slots: tokio::sync::Semaphore::new(4),
            cover_slots: tokio::sync::Semaphore::new(2),
            prefetch_slots: tokio::sync::Semaphore::new(1),
            prefetch_epochs: Mutex::new(HashMap::new()),
        };
        if !this.config_path().exists() {
            storage::write(
                &this.config_path(),
                &json!({"activeId":null,"deviceId":uuid::Uuid::new_v4().to_string(),"connections":[]}),
            )?;
        }
        this.config()?;
        Ok(this)
    }
    fn config_path(&self) -> PathBuf {
        self.root.join("remote/servers.json")
    }
    fn config(&self) -> Result<Value> {
        let v = storage::read(&self.config_path(), Value::Null)?;
        if !v["connections"].is_array() || !v["deviceId"].is_string() {
            bail!("服务器配置格式错误，原文件已保留");
        }
        Ok(v)
    }
    fn connection(&self, id: &str) -> Result<Value> {
        self.config()?["connections"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .cloned()
            .context("服务器连接已移除；已缓存的页面和学习记录仍保留")
    }
    async fn request(
        &self,
        c: &Value,
        method: Method,
        path: &str,
        body: Option<Value>,
        max: usize,
    ) -> Result<(u16, Vec<u8>)> {
        let url = reqwest::Url::parse(text(c, "url")?)?.join(path)?;
        let mut req = self
            .client
            .request(method, url)
            .bearer_auth(text(c, "token")?);
        if let Some(body) = body {
            req = req
                .header("Content-Type", "application/json")
                .body(serde_json::to_vec(&body)?);
        }
        let mut response = req
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("服务器连接失败，请检查地址和网络"))?;
        let status = response.status().as_u16();
        if response.content_length().is_some_and(|n| n > max as u64) {
            bail!("服务器响应超过大小限制");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("服务器响应中断"))?
        {
            if bytes.len() + chunk.len() > max {
                bail!("服务器响应超过大小限制");
            }
            bytes.extend_from_slice(&chunk);
        }
        if !(200..300).contains(&status) && status != 409 {
            bail!("服务器请求失败（HTTP {status}）");
        }
        Ok((status, bytes))
    }
    async fn json(
        &self,
        c: &Value,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let (status, bytes) = self
            .request(c, method, path, body, 32 * 1024 * 1024)
            .await?;
        let mut value: Value = serde_json::from_slice(&bytes).context("服务端返回了无效 JSON")?;
        if !value.is_object() {
            bail!("服务端 JSON 必须为对象");
        }
        if status == 409 {
            value["_conflict"] = json!(true);
        }
        Ok(value)
    }
    async fn info(&self, c: &Value) -> Result<Value> {
        let info = self.json(c, Method::GET, "api/v1/info", None).await?;
        if info["apiVersion"] != 1 || info["userId"] != "owner" {
            bail!("不兼容的服务器 API 或用户空间");
        }
        uuid::Uuid::parse_str(text(&info, "serverId")?)?;
        if c["serverId"].is_string() && c["serverId"] != info["serverId"] {
            bail!("服务器身份发生变化，请新增连接，避免混用原服务器数据");
        }
        Ok(info)
    }
    fn snapshot(&self, backend: &Mutex<Backend>, id: &str) -> Result<Value> {
        Ok(lock(backend)?.book(id)?.clone())
    }
    fn dir(&self, id: &str) -> Result<PathBuf> {
        storage::valid_id(id)?;
        if !id.starts_with("rs_") {
            bail!("不是远程书籍");
        }
        Ok(self.root.join("remote-cache").join(id))
    }
    fn materialize(&self, c: &Value, server: &Value) -> Result<Value> {
        let id = qualified(text(c, "serverId")?, text(server, "id")?)?;
        let rev = text(server, "revision")?;
        if !digest(rev) || server["format"] != "comic" {
            bail!("不支持的远程书籍或内容版本");
        }
        let pages = server["pages"]
            .as_array()
            .filter(|p| !p.is_empty() && p.len() <= 100000)
            .context("远程页清单无效")?;
        let mut urls = std::collections::HashSet::new();
        for page in pages {
            storage::valid_id(text(page, "id")?)?;
            let url = text(page, "url")?;
            let parts: Vec<_> = url.split('/').collect();
            if parts.len() != 2
                || parts[0] != "pages"
                || !parts[1]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
                || !arale_native::pages::is_comic_image(url)
                || !urls.insert(url)
                || !digest(text(page, "sha256")?)
                || page["bytes"]
                    .as_u64()
                    .is_none_or(|n| n == 0 || n > 64 * 1024 * 1024)
                || ["width", "height"]
                    .iter()
                    .any(|k| page[*k].as_u64().is_none_or(|n| n == 0 || n > 100000))
            {
                bail!("远程页面清单格式错误");
            }
        }
        let mut book = server.clone();
        book["id"] = json!(id);
        book["dir"] = json!(self.dir(&id)?.to_string_lossy());
        book["remote"] = json!({"connectionId":c["id"],"serverId":c["serverId"],"bookId":server["id"],"revision":rev,"ocrRevision":server["ocrRevision"],"available":true});
        book["pages"] = json!(pages
            .iter()
            .map(|p| {
                let mut p = p.clone();
                p["url"] = json!(format!("{rev}/{}", p["url"].as_str().unwrap()));
                p
            })
            .collect::<Vec<_>>());
        book["coverRel"] = json!(format!("{rev}/{}", text(&pages[0], "url")?));
        book["pageCount"] = json!(pages.len());
        book["spine"] = Value::Null;
        book["toc"] = Value::Null;
        book["opfRel"] = Value::Null;
        if book["direction"] != "rtl" && book["direction"] != "ltr" {
            bail!("无效阅读方向");
        }
        for key in ["title", "titleSort", "author"] {
            text(&book, key)?;
        }
        if !book["tags"]
            .as_array()
            .is_some_and(|a| a.iter().all(Value::is_string))
        {
            bail!("无效标签");
        }
        let preferences = storage::read(&self.dir(&id)?.join("preferences.json"), json!({}))?;
        if preferences["direction"] == "rtl" || preferences["direction"] == "ltr" {
            book["direction"] = preferences["direction"].clone();
        }
        Ok(book)
    }
    async fn catalog(&self, backend: &Mutex<Backend>, c: &Value) -> Result<()> {
        let info = self.info(c).await?;
        let cid = text(c, "id")?;
        let compact = info["capabilities"]["catalog"] == true;
        let old_revision = self.meta(cid)["catalogRevision"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let path = if compact {
            format!("api/v1/catalog?revision={old_revision}")
        } else {
            "api/v1/books".into()
        };
        let data = self.json(c, Method::GET, &path, None).await?;
        if data["unchanged"] != true {
            let rows = data["books"].as_array().context("服务端书库清单无效")?;
            let old = lock(backend)?.remote_books.clone();
            let books = rows
                .iter()
                .map(|row| {
                    if compact {
                        self.materialize_summary(c, row, &old)
                    } else {
                        self.materialize(c, row)
                    }
                })
                .collect::<Result<Vec<_>>>()?;
            let mut b = lock(backend)?;
            let mut next = b.remote_books.clone();
            for book in &mut next {
                if book["remote"]["connectionId"] == c["id"] {
                    book["remote"]["available"] = json!(false);
                }
            }
            for book in books {
                if !old.iter().any(|value| value == &book) {
                    self.cache_book(&book)?;
                }
                if let Some(entry) = next.iter_mut().find(|entry| entry["id"] == book["id"]) {
                    *entry = book;
                } else {
                    next.push(book);
                }
            }
            if next != b.remote_books {
                storage::write(&self.root.join("remote/catalog.json"), &json!(next))?;
                b.remote_books = next;
            }
        }
        let books = lock(backend)?
            .remote_books
            .iter()
            .filter(|b| b["remote"]["connectionId"] == c["id"])
            .cloned()
            .collect::<Vec<_>>();
        if compact {
            for book in &books {
                if let Some(position) = data["progress"].get(text(&book["remote"], "bookId")?) {
                    self.receive_position(book, position.clone(), false)?;
                } else {
                    self.receive_position(book, json!({"revision":0,"contentRevision":book["remote"]["revision"],"position":null,"deviceId":""}), false)?;
                }
            }
        }
        let revision = if compact {
            text(&data, "revision")?.to_owned()
        } else {
            format!("{:x}", Sha256::digest(serde_json::to_vec(&data)?))
        };
        if !digest(&revision) {
            bail!("书库版本无效");
        }
        self.update_meta(
            cid,
            json!({"catalogRevision":revision,"compact":compact,"lastCatalogAt":storage::now()}),
        )?;
        Ok(())
    }
    fn layer_current(&self, book: &Value) -> Result<bool> {
        let dir = self.dir(text(book, "id")?)?;
        Ok(dir.join("content/manga.json").is_file()
            && storage::read(&dir.join("layer-version.json"), Value::Null)?
                == json!([book["remote"]["revision"], book["remote"]["ocrRevision"]]))
    }
    async fn layer(&self, book: &Value, c: &Value) -> Result<()> {
        let id = text(book, "id")?;
        let origin = &book["remote"];
        let path = self.dir(id)?.join("content/manga.json");
        if self.layer_current(book)? {
            return Ok(());
        }
        if origin["ocrRevision"].as_u64() == Some(0) {
            let pages: Vec<_> = book["pages"]
                .as_array()
                .context("无页面")?
                .iter()
                .map(|page| json!({"url":page["url"],"width":page["width"],"height":page["height"],"blocks":[]}))
                .collect();
            storage::write(&path, &json!({"pages":pages}))?;
            storage::write(
                &self.dir(id)?.join("layer-version.json"),
                &json!([origin["revision"], 0]),
            )?;
            return Ok(());
        }
        let response = self
            .json(
                c,
                Method::GET,
                &format!(
                    "api/v1/books/{}/ocr?revision={}",
                    text(origin, "bookId")?,
                    text(origin, "revision")?
                ),
                None,
            )
            .await?;
        if response["_conflict"] == true || response["revision"] != origin["revision"] {
            bail!("服务器内容已更新，请刷新书库后重试");
        }
        let mut layer = response["layer"].clone();
        let pages = layer["pages"]
            .as_array_mut()
            .context("服务端文字层格式错误")?;
        let allowed = book["pages"].as_array().unwrap();
        for p in pages {
            let url = format!(
                "{}/{}",
                text(origin, "revision")?,
                p["url"]
                    .as_str()
                    .or_else(|| p["img_path"].as_str())
                    .context("文字层缺少页路径")?
            );
            if !allowed.iter().any(|a| a["url"] == url) {
                bail!("文字层页面与书籍清单不匹配");
            }
            p["url"] = json!(url);
            p.as_object_mut().unwrap().remove("img_path");
        }
        storage::write(&path, &layer)?;
        storage::write(
            &self.dir(id)?.join("layer-version.json"),
            &json!([origin["revision"], response["ocrRevision"]]),
        )?;
        Ok(())
    }
    fn progress_path(&self, id: &str) -> Result<PathBuf> {
        Ok(self.dir(id)?.join("progress-state.json"))
    }
    fn progress(&self, id: &str) -> Result<Value> {
        storage::read(
            &self.progress_path(id)?,
            json!({"current":null,"pending":null,"next":null,"conflict":null}),
        )
    }
    fn tracked(&self) -> Result<Vec<Value>> {
        storage::read(&self.root.join("remote/outbox.json"), json!([]))?
            .as_array()
            .cloned()
            .context("待同步进度索引格式错误，原文件已保留")
    }
    fn track(&self, id: &str, needed: bool) -> Result<()> {
        let mut ids = self.tracked()?;
        let before = ids.clone();
        ids.retain(|v| v != id);
        if needed {
            ids.push(json!(id));
        }
        if ids != before {
            storage::write(&self.root.join("remote/outbox.json"), &json!(ids))?;
        }
        Ok(())
    }
    async fn flush(&self, book: &Value, c: &Value) -> Result<Value> {
        let id = text(book, "id")?;
        let state = self.progress(id)?;
        if !state["conflict"].is_null() || (state["pending"].is_null() && state["next"].is_null()) {
            return Ok(state);
        }
        self.info(c).await?;
        for _ in 0..2 {
            let pending = {
                let _local = self.state_gate.lock().unwrap();
                let mut state = self.progress(id)?;
                if !state["conflict"].is_null() {
                    break;
                }
                if state["pending"].is_null() {
                    if state["next"].is_null() {
                        break;
                    }
                    state["pending"] = json!({"operationId":uuid::Uuid::new_v4().to_string(),"deviceId":self.config()?["deviceId"],
                        "baseRevision":state["current"]["revision"].as_u64().unwrap_or(0),
                        "contentRevision":state["nextContentRevision"].as_str().unwrap_or(text(&book["remote"],"revision")?),"position":state["next"]});
                    state["next"] = Value::Null;
                    state["nextContentRevision"] = Value::Null;
                    storage::write(&self.progress_path(id)?, &state)?;
                }
                state["pending"].clone()
            };
            let result = self
                .json(
                    c,
                    Method::PUT,
                    &format!("api/v1/books/{}/progress", text(&book["remote"], "bookId")?),
                    Some(pending.clone()),
                )
                .await?;
            {
                let _local = self.state_gate.lock().unwrap();
                // A reader may have queued a newer position while the request was in flight.
                let mut state = self.progress(id)?;
                if state["pending"]["operationId"] != pending["operationId"] {
                    break;
                }
                if result["_conflict"] == true {
                    state["conflict"] = result["current"].clone();
                } else {
                    state["current"] = result;
                    state["pending"] = Value::Null;
                    state["remoteCurrent"] = Value::Null;
                }
                storage::write(&self.progress_path(id)?, &state)?;
                self.track(
                    id,
                    !state["pending"].is_null()
                        || !state["next"].is_null()
                        || !state["conflict"].is_null(),
                )?;
                if !state["conflict"].is_null() {
                    break;
                }
            }
        }
        self.progress(id)
    }
    fn display_position(s: &Value, id: &str) -> Value {
        let mut p = if !s["next"].is_null() {
            s["next"].clone()
        } else if !s["pending"].is_null() {
            s["pending"]["position"].clone()
        } else {
            s["current"]["position"].clone()
        };
        if p.is_object() {
            p["bookId"] = json!(id);
        }
        p
    }
    pub async fn handle(
        &self,
        backend: &Mutex<Backend>,
        channel: &str,
        args: &[Value],
    ) -> Result<Value> {
        let first = args.first().unwrap_or(&Value::Null);
        if channel == "remote:connections" {
            return Ok(public_config(&self.config()?));
        }
        // Local switching must stay responsive even while a remote request times out.
        if channel == "remote:activate" {
            let _config_guard = self
                .config_gate
                .lock()
                .map_err(|_| anyhow::anyhow!("配置锁不可用"))?;
            let mut config = self.config()?;
            if !first.is_null() {
                self.connection(first.as_str().context("无效书源 ID")?)?;
            }
            config["activeId"] = first.clone();
            *self.active_book.lock().unwrap() = None;
            storage::write(&self.config_path(), &config)?;
            return Ok(public_config(&config));
        }
        if channel == "remote:autoSync" {
            return self.set_auto_sync(first, args.get(1));
        }
        if channel == "remote:status" {
            return self.sync_snapshot(backend);
        }
        if channel == "remote:readerClosed" {
            let mut active = self.active_book.lock().unwrap();
            if active.as_deref() == first.as_str() {
                *active = None;
            }
            return Ok(Value::Null);
        }
        if channel == "remote:savePosition" {
            return self.save_local_position(backend, first);
        }
        if channel == "remote:prefetch" {
            return self
                .prefetch(backend, first.as_str().context("缺少书籍 ID")?, args.get(1))
                .await;
        }
        if channel == "remote:open" && args.get(1) == Some(&json!(true)) {
            let book = self.snapshot(backend, first.as_str().context("缺少书籍 ID")?)?;
            if Self::has_manifest(&book) {
                return self.open_book(backend, first.as_str().unwrap(), true).await;
            }
        }
        if channel == "remote:info" || channel == "remote:list" {
            let c = self.selected_connection()?;
            if channel == "remote:info" || self.catalog_cached(backend, &c)? {
                return self.cached_view(backend, &c, channel, first);
            }
        }
        if channel == "remote:poll" {
            let Ok(_guard) = self.gate.try_lock() else {
                return self.sync_snapshot(backend);
            };
            self.background_sync(backend).await;
            return self.sync_snapshot(backend);
        }
        let _guard = self.gate.lock().await;
        let arg = || first.as_str().context("缺少服务器或书籍 ID");
        match channel {
            "remote:connections" => Ok(public_config(&self.config()?)),
            "remote:save" | "remote:probe" => {
                let mut config = self.config()?;
                let old = config["connections"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|c| c["id"] == first["id"]);
                let url = normalize_url(text(first, "url")?)?;
                let token = first["token"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or_else(|| {
                        old.filter(|c| c["url"] == url)
                            .and_then(|c| c["token"].as_str())
                    })
                    .context("请填写访问令牌；修改服务器地址时需重新填写")?;
                if token.len() < 16 || token.contains(['\r', '\n']) {
                    bail!("访问令牌格式错误");
                }
                let mut c = json!({"id":old.map(|c|c["id"].clone()).unwrap_or(json!(uuid::Uuid::new_v4().to_string())),"url":url,"token":token,"name":first["name"].as_str().filter(|s|!s.trim().is_empty()).unwrap_or("Arale Server")});
                if let Some(old) = old {
                    c["serverId"] = old["serverId"].clone();
                }
                let info = self.info(&c).await?;
                c["serverId"] = info["serverId"].clone();
                c["userId"] = info["userId"].clone();
                c["autoSync"] = old
                    .map(|value| value["autoSync"] != false)
                    .unwrap_or(true)
                    .into();
                if channel == "remote:probe" {
                    return Ok(info);
                }
                let _config_guard = self
                    .config_gate
                    .lock()
                    .map_err(|_| anyhow::anyhow!("配置锁不可用"))?;
                config = self.config()?;
                if config["connections"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|old| old["serverId"] == c["serverId"] && old["id"] != c["id"])
                {
                    bail!("此服务器已存在，请编辑原连接");
                }
                let list = config["connections"].as_array_mut().unwrap();
                if let Some(old) = list.iter_mut().find(|old| old["id"] == c["id"]) {
                    *old = c;
                } else {
                    list.push(c);
                }
                storage::write(&self.config_path(), &config)?;
                Ok(public_config(&config))
            }
            "remote:remove" => {
                let _config_guard = self
                    .config_gate
                    .lock()
                    .map_err(|_| anyhow::anyhow!("配置锁不可用"))?;
                let mut config = self.config()?;
                if channel == "remote:activate" {
                    if let Some(id) = first.as_str() {
                        self.connection(id)?;
                    }
                    config["activeId"] = first.clone();
                } else {
                    config["connections"]
                        .as_array_mut()
                        .unwrap()
                        .retain(|c| c["id"] != *first);
                    if config["activeId"] == *first {
                        config["activeId"] = Value::Null;
                    }
                }
                storage::write(&self.config_path(), &config)?;
                Ok(public_config(&config))
            }
            "remote:scan" => {
                let c = self.connection(arg()?)?;
                self.update_meta(arg()?, json!({"retryAt":0,"lastAttemptAt":0}))?;
                self.json(&c, Method::POST, "api/v1/library/scan", Some(json!({})))
                    .await
            }
            "remote:list" | "remote:info" => {
                let c = self.selected_connection()?;
                if !self.catalog_cached(backend, &c)? {
                    self.synchronize(backend, &c, true).await?;
                }
                self.cached_view(backend, &c, channel, first)
            }
            "remote:sync" => {
                let c = if first.is_string() {
                    self.connection(arg()?)?
                } else {
                    self.selected_connection()?
                };
                let _ = self.synchronize(backend, &c, true).await;
                self.sync_snapshot(backend)
            }
            "remote:open" => {
                self.open_book(
                    backend,
                    arg()?,
                    args.get(1).and_then(Value::as_bool).unwrap_or(false),
                )
                .await
            }
            "remote:resolve" => {
                let id = arg()?;
                let book = self.snapshot(backend, id)?;
                let c = self.connection(text(&book["remote"], "connectionId")?)?;
                let current = self
                    .json(
                        &c,
                        Method::GET,
                        &format!("api/v1/books/{}/progress", text(&book["remote"], "bookId")?),
                        None,
                    )
                    .await?;
                let choice = args
                    .get(1)
                    .and_then(Value::as_str)
                    .context("缺少冲突解决方式")?;
                if !["local", "remote", "restart"].contains(&choice) {
                    bail!("无效冲突解决方式");
                }
                let manifest = self
                    .json(
                        &c,
                        Method::GET,
                        &format!("api/v1/books/{}", text(&book["remote"], "bookId")?),
                        None,
                    )
                    .await?;
                if manifest["revision"] != book["remote"]["revision"] {
                    bail!("书籍内容已变更，请返回书库刷新后重新打开");
                }
                {
                    let _local = self.state_gate.lock().unwrap();
                    let mut s = self.progress(id)?;
                    if choice != "restart"
                        && (content_changed(&s, &book)
                            || current["contentRevision"] != book["remote"]["revision"])
                    {
                        bail!("内容版本不匹配，请从新版第一页重新定位");
                    }
                    let history_path = self.dir(id)?.join("progress-conflict-history.json");
                    let mut history = storage::read(&history_path, json!([]))?
                        .as_array()
                        .cloned()
                        .context("进度冲突历史格式错误")?;
                    history.push(
                        json!({"at":storage::now(),"choice":choice,"previous":s,"server":current}),
                    );
                    storage::write(&history_path, &json!(history))?;
                    let mut next = if choice == "restart" {
                        json!({"pageIndex":0,"updatedAt":storage::now()})
                    } else {
                        Self::display_position(&s, id)
                    };
                    next["bookId"] = book["remote"]["bookId"].clone();
                    s["discardUntilOpen"] = json!(choice != "local");
                    s["current"] = current;
                    s["pending"] = Value::Null;
                    s["conflict"] = Value::Null;
                    s["next"] = if choice == "local" || choice == "restart" {
                        next
                    } else {
                        Value::Null
                    };
                    s["nextContentRevision"] = book["remote"]["revision"].clone();
                    storage::write(&self.progress_path(id)?, &s)?;
                    self.track(id, !s["next"].is_null())?;
                }
                self.flush(&book, &c).await?;
                Ok(Value::Null)
            }
            "remote:ensurePage" => {
                let book = self.snapshot(backend, arg()?)?;
                let i = args.get(1).and_then(Value::as_u64).context("缺少页码")? as usize;
                let p = book["pages"].get(i).context("页码越界")?;
                self.ensure_asset(backend, arg()?, text(p, "url")?).await?;
                Ok(Value::Null)
            }
            "remote:preferences" => {
                let id = arg()?;
                let patch = args.get(1).context("缺少阅读偏好")?;
                if patch.as_object().is_none_or(|p| p.len() != 1)
                    || (patch["direction"] != "rtl" && patch["direction"] != "ltr")
                {
                    bail!("远程书籍仅支持保存本机阅读方向偏好");
                }
                let mut book = self.snapshot(backend, id)?;
                book["direction"] = patch["direction"].clone();
                storage::write(&self.dir(id)?.join("preferences.json"), patch)?;
                let mut b = lock(backend)?;
                let mut next = b.remote_books.clone();
                *next
                    .iter_mut()
                    .find(|old| old["id"] == id)
                    .context("书不存在")? = book.clone();
                storage::write(&self.root.join("remote/catalog.json"), &json!(next))?;
                b.remote_books = next;
                Ok(book)
            }
            "remote:refreshLayer" => {
                let book = self.snapshot(backend, arg()?)?;
                let c = self.connection(text(&book["remote"], "connectionId")?)?;
                // A single book refresh must not download every page manifest in the library.
                self.info(&c).await?;
                let manifest = self
                    .json(
                        &c,
                        Method::GET,
                        &format!("api/v1/books/{}", text(&book["remote"], "bookId")?),
                        None,
                    )
                    .await?;
                let expected = args
                    .get(1)
                    .and_then(Value::as_str)
                    .unwrap_or(text(&book["remote"], "revision")?);
                if manifest["revision"] != expected {
                    bail!("书籍内容已变更，请返回书库刷新后重新打开");
                }
                let fresh = self.materialize(&c, &manifest)?;
                if fresh["id"] != book["id"] {
                    bail!("服务端返回了其他书籍");
                }
                {
                    let mut b = lock(backend)?;
                    let mut next = b.remote_books.clone();
                    let entry = next
                        .iter_mut()
                        .find(|item| item["id"] == fresh["id"])
                        .context("远程书籍已移除")?;
                    *entry = fresh.clone();
                    self.cache_book(&fresh)?;
                    storage::write(&self.root.join("remote/catalog.json"), &json!(next))?;
                    b.remote_books = next;
                }
                let updated = !self.layer_current(&fresh)?;
                self.layer(&fresh, &c).await?;
                let layer =
                    storage::read(&self.dir(arg()?)?.join("content/manga.json"), json!({}))?;
                let blocks: usize = layer["pages"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|p| p["blocks"].as_array().map_or(0, Vec::len))
                    .sum();
                Ok(json!({"blocks":blocks,"updated":updated}))
            }
            "remote:capability" => {
                let c = self.connection(
                    self.config()?["activeId"]
                        .as_str()
                        .context("未选择服务器")?,
                )?;
                let i = self.info(&c).await?;
                let available = i["capabilities"]["ocr"] == true;
                Ok(
                    json!({"available":available,"reason":if available{Value::Null}else{json!("服务端未配置 OCR 引擎")},"extensionsDir":"由服务器管理","providers":[{"id":"server","label":"服务器 OCR","available":available,"ready":available,"requirement":"由服务器配置和运行","downloadSizeMb":0,"extension":null,"reason":null}],"selected":"server"}),
                )
            }
            "remote:ocrStatus" => {
                let book = self.snapshot(backend, arg()?)?;
                if book["remote"]["ocrRevision"].as_u64().unwrap_or(0) > 0 {
                    Ok(
                        json!({"bookId":book["id"],"ok":true,"provider":"server","pages":book["pageCount"],"blocks":0}),
                    )
                } else {
                    Ok(Value::Null)
                }
            }
            "remote:ocrStart" | "remote:ocrCancel" => {
                let id = arg()?;
                let book = self.snapshot(backend, id)?;
                let c = self.connection(text(&book["remote"], "connectionId")?)?;
                if channel == "remote:ocrStart" {
                    self.update_meta(text(&c, "id")?, json!({"retryAt":0,"lastAttemptAt":0}))?;
                    let r=self.json(&c,Method::POST,&format!("api/v1/books/{}/ocr-jobs",text(&book["remote"],"bookId")?),Some(json!({"operationId":uuid::Uuid::new_v4().to_string(),"force":args.get(1).is_some_and(|a|a["force"]==true)}))).await?;
                    Ok(
                        json!({"bookId":id,"ok":true,"provider":"server","pages":0,"blocks":0,"queued":r["skipped"]!=true,"skipped":r["skipped"]==true}),
                    )
                } else {
                    let state = self.json(&c, Method::GET, "api/v1/state", None).await?;
                    for job in state["jobs"].as_array().into_iter().flatten() {
                        if job["bookId"] == book["remote"]["bookId"]
                            && ["queued", "running"].contains(&job["state"].as_str().unwrap_or(""))
                        {
                            self.json(
                                &c,
                                Method::POST,
                                &format!("api/v1/jobs/{}/cancel", text(job, "id")?),
                                Some(json!({})),
                            )
                            .await?;
                        }
                    }
                    Ok(Value::Null)
                }
            }
            _ => bail!("未知服务器操作"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn urls_and_qualified_ids_are_scoped() {
        assert_eq!(
            normalize_url(" http://127.0.0.1:3737 ").unwrap(),
            "http://127.0.0.1:3737/"
        );
        for url in [
            "file:///etc/passwd",
            "http://user:pass@host/",
            "http://host/?token=x",
            "http://host/#fragment",
        ] {
            assert!(normalize_url(url).is_err());
        }
        let a = qualified("00000000-0000-4000-8000-000000000001", "bk_one").unwrap();
        let b = qualified("00000000-0000-4000-8000-000000000002", "bk_one").unwrap();
        assert_ne!(a, b);
        assert!(qualified("invalid", "bk_one").is_err());
        assert!(qualified("00000000-0000-4000-8000-000000000001", "../x").is_err());
    }
    #[tokio::test]
    async fn idle_progress_needs_no_network_request() -> Result<()> {
        let root = tempfile::tempdir()?;
        let remote = Remote::new(root.path().into())?;
        let state = remote.flush(&json!({"id":"rs_idle"}), &json!({})).await?;
        assert!(state["pending"].is_null());
        assert!(state["next"].is_null());
        Ok(())
    }
    #[tokio::test]
    #[ignore = "requires isolated live server; run npm run server:test -- --native"]
    async fn remote_round_trip() -> Result<()> {
        let url = std::env::var("ARALE_TEST_SERVER_URL")?;
        let token = std::env::var("ARALE_TEST_SERVER_TOKEN")?;
        let a = tempfile::tempdir()?;
        let b = tempfile::tempdir()?;
        let ra = Remote::new(a.path().into())?;
        let rb = Remote::new(b.path().into())?;
        let ba = Mutex::new(Backend::load(a.path().into())?);
        let bb = Mutex::new(Backend::load(b.path().into())?);
        lock(&ba)?.add(json!({"id":"bk_local","title":"Local book","format":"comic"}))?;
        storage::write(
            &a.path().join("positions.json"),
            &json!({"bk_local":{"pageIndex":42}}),
        )?;
        let original = fs::read(a.path().join("library/index.json"))?;
        for (r, backend) in [(&ra, &ba), (&rb, &bb)] {
            let conf = r
                .handle(
                    backend,
                    "remote:save",
                    &[json!({"name":"Isolated server","url":url,"token":token})],
                )
                .await?;
            assert!(conf.to_string().find(&token).is_none());
            let cid = conf["connections"][0]["id"].clone();
            r.handle(backend, "remote:activate", &[cid]).await?;
            r.handle(backend, "remote:list", &[json!({})]).await?;
        }
        let books = ra.handle(&ba, "remote:list", &[json!({})]).await?;
        let summary = &books["books"][0];
        assert_eq!(
            summary["pages"].is_null(),
            std::env::var("ARALE_TEST_LEGACY").as_deref() != Ok("1")
        );
        let book_id = text(summary, "id")?;
        let opened = ra
            .handle(&ba, "remote:open", &[json!(book_id), json!(true)])
            .await?;
        let book = &opened["book"];
        let id = text(book, "id")?;
        let oa = ra
            .handle(&ba, "remote:open", &[json!(id), json!(true)])
            .await?;
        assert_eq!(oa["textLayerPending"], true);
        assert!(crate::page_text(&*lock(&ba)?, id, 0)?["blocks"]
            .as_array()
            .unwrap()
            .is_empty());
        let ob = rb.handle(&bb, "remote:open", &[json!(id)]).await?;
        assert_eq!(oa["position"], ob["position"]);
        ra.handle(
            &ba,
            "remote:refreshLayer",
            &[json!(id), book["remote"]["revision"].clone()],
        )
        .await?;
        assert_eq!(
            ra.handle(&ba, "remote:open", &[json!(id), json!(true)])
                .await?["textLayerPending"],
            false
        );
        let cached = fs::read(ra.dir(id)?.join("content/manga.json"))?;
        assert!(ra
            .handle(
                &ba,
                "remote:refreshLayer",
                &[json!(id), json!("0".repeat(64))]
            )
            .await
            .is_err());
        assert_eq!(fs::read(ra.dir(id)?.join("content/manga.json"))?, cached);
        assert!(!crate::segments::input(&*lock(&ba)?, id)?["units"]
            .as_array()
            .unwrap()
            .is_empty());
        ra.handle(
            &ba,
            "remote:preferences",
            &[json!(id), json!({"direction":"ltr"})],
        )
        .await?;
        ra.handle(&ba, "remote:list", &[json!({})]).await?;
        assert_eq!(ra.snapshot(&ba, id)?["direction"], "ltr");
        ra.ensure_asset(&ba, id, text(&book["pages"][0], "url")?)
            .await?;
        assert!(ra
            .dir(id)?
            .join("content")
            .join(text(&book["pages"][0], "url")?)
            .is_file());
        assert!(!crate::page_text(&*lock(&ba)?, id, 0)?["blocks"]
            .as_array()
            .unwrap()
            .is_empty());
        ra.handle(
            &ba,
            "remote:savePosition",
            &[json!({"bookId":id,"pageIndex":0})],
        )
        .await?;
        ra.handle(&ba, "remote:sync", &[]).await?;
        // B moves away and back while A has advanced the server revision.
        rb.handle(
            &bb,
            "remote:savePosition",
            &[json!({"bookId":id,"pageIndex":0})],
        )
        .await?;
        rb.handle(
            &bb,
            "remote:savePosition",
            &[json!({"bookId":id,"pageIndex":1})],
        )
        .await?;
        let poll = rb.handle(&bb, "remote:poll", &[]).await?;
        assert_eq!(poll["conflicts"].as_array().unwrap().len(), 1);
        rb.handle(&bb, "remote:resolve", &[json!(id), json!("remote")])
            .await?;
        // Reader unmount must not re-submit the discarded position.
        rb.handle(
            &bb,
            "remote:savePosition",
            &[json!({"bookId":id,"pageIndex":1})],
        )
        .await?;
        assert_eq!(
            rb.handle(&bb, "remote:open", &[json!(id)]).await?["position"]["pageIndex"],
            0
        );
        // Simulate lost network without stopping the server or touching real config.
        let saved = rb.config()?;
        let mut broken = saved.clone();
        broken["connections"][0]["url"] = json!("http://127.0.0.1:1/");
        storage::write(&rb.config_path(), &broken)?;
        rb.handle(
            &bb,
            "remote:savePosition",
            &[json!({"bookId":id,"pageIndex":1})],
        )
        .await?;
        assert!(!rb.progress(id)?["next"].is_null() || !rb.progress(id)?["pending"].is_null());
        storage::write(&rb.config_path(), &saved)?;
        rb.handle(&bb, "remote:poll", &[]).await?;
        assert!(rb.progress(id)?["next"].is_null());
        assert!(rb.progress(id)?["pending"].is_null());
        assert_eq!(
            rb.handle(&bb, "remote:open", &[json!(id)]).await?["position"]["pageIndex"],
            1
        );
        // Disabling automatic sync survives restart. Manual sync still sends the outbox.
        let cid = rb.config()?["activeId"].clone();
        rb.handle(&bb, "remote:autoSync", &[cid, json!(false)])
            .await?;
        rb.handle(
            &bb,
            "remote:savePosition",
            &[json!({"bookId":id,"pageIndex":0})],
        )
        .await?;
        rb.handle(&bb, "remote:poll", &[]).await?;
        assert_eq!(rb.progress(id)?["next"]["pageIndex"], 0);
        let rb = Remote::new(b.path().into())?;
        assert_eq!(rb.config()?["connections"][0]["autoSync"], false);
        rb.handle(&bb, "remote:sync", &[]).await?;
        assert!(rb.progress(id)?["next"].is_null());
        assert_eq!(rb.progress(id)?["current"]["position"]["pageIndex"], 0);
        let mut incompatible = ra.progress(id)?;
        incompatible["pending"] = json!({"operationId":uuid::Uuid::new_v4().to_string(),"deviceId":ra.config()?["deviceId"],"baseRevision":0,"contentRevision":"0".repeat(64),"position":{"bookId":book["remote"]["bookId"],"pageIndex":1}});
        ra.track(id, true)?;
        storage::write(&ra.progress_path(id)?, &incompatible)?;
        let conflict = ra.handle(&ba, "remote:poll", &[]).await?;
        assert_eq!(conflict["conflicts"][0]["contentChanged"], true);
        assert!(ra.handle(&ba, "remote:open", &[json!(id)]).await?["position"].is_null());
        ra.handle(&ba, "remote:resolve", &[json!(id), json!("restart")])
            .await?;
        assert_eq!(
            ra.handle(&ba, "remote:open", &[json!(id)]).await?["position"]["pageIndex"],
            0
        );
        assert!(!storage::read(
            &ra.dir(id)?.join("progress-conflict-history.json"),
            Value::Null
        )?
        .as_array()
        .unwrap()
        .is_empty());
        assert_eq!(fs::read(a.path().join("library/index.json"))?, original);
        assert_eq!(
            storage::read(&a.path().join("positions.json"), Value::Null)?["bk_local"]["pageIndex"],
            42
        );
        assert_eq!(lock(&ba)?.books.len(), 1);
        assert_eq!(Backend::load(a.path().into())?.remote_books.len(), 1);
        println!("native remote: image/text read, two-device CAS conflict, discard, offline outbox/retry, local data preserved");
        Ok(())
    }
}
