use super::*;

impl Remote {
    pub(super) fn meta(&self, id: &str) -> Value {
        self.sync_meta
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .unwrap_or(json!({}))
    }
    pub(super) fn update_meta(&self, id: &str, patch: Value) -> Result<()> {
        let mut all = self.sync_meta.lock().unwrap();
        if !all[id].is_object() {
            all[id] = json!({});
        }
        for (key, value) in patch.as_object().context("同步状态无效")? {
            all[id][key] = value.clone();
        }
        storage::write(&self.root.join("remote/sync-status.json"), &all)
    }
    pub(super) fn selected_connection(&self) -> Result<Value> {
        self.connection(
            self.config()?["activeId"]
                .as_str()
                .context("未选择服务器")?,
        )
    }
    pub(super) fn set_auto_sync(&self, id: &Value, enabled: Option<&Value>) -> Result<Value> {
        let enabled = enabled
            .and_then(Value::as_bool)
            .context("缺少自动同步设置")?;
        let _guard = self.config_gate.lock().unwrap();
        let mut config = self.config()?;
        let c = config["connections"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|c| c["id"] == *id)
            .context("服务器连接不存在")?;
        c["autoSync"] = json!(enabled);
        storage::write(&self.config_path(), &config)?;
        if enabled {
            self.update_meta(
                id.as_str().context("无效连接 ID")?,
                json!({"retryAt":0,"lastAttemptAt":0}),
            )?;
        }
        Ok(public_config(&config))
    }
    pub(super) fn has_manifest(book: &Value) -> bool {
        book["pages"].as_array().is_some_and(|p| {
            !p.is_empty() && p.len() as u64 == book["pageCount"].as_u64().unwrap_or(0)
        })
    }
    pub(super) fn materialize_summary(
        &self,
        c: &Value,
        row: &Value,
        old: &[Value],
    ) -> Result<Value> {
        let mut single = row.clone();
        single["pages"] = json!([row["coverPage"]]);
        let mut book = self.materialize(c, &single)?;
        let count = row["pageCount"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 100000)
            .context("远程页数无效")?;
        book["pageCount"] = json!(count);
        book["remote"]["coverPage"] = book["pages"][0].clone();
        book["pages"] = old
            .iter()
            .find(|b| {
                b["id"] == book["id"]
                    && b["remote"]["revision"] == book["remote"]["revision"]
                    && Self::has_manifest(b)
            })
            .map(|b| b["pages"].clone())
            .unwrap_or(Value::Null);
        book.as_object_mut().unwrap().remove("coverPage");
        Ok(book)
    }
    pub(super) fn cache_book(&self, book: &Value) -> Result<()> {
        let dir = self.dir(text(book, "id")?)?;
        storage::write(&dir.join("book.json"), book)?;
        if Self::has_manifest(book) {
            storage::write(
                &dir.join("manifests")
                    .join(format!("{}.json", text(&book["remote"], "revision")?)),
                book,
            )?;
        }
        Ok(())
    }
    pub(super) fn catalog_cached(&self, backend: &Mutex<Backend>, c: &Value) -> Result<bool> {
        Ok(self.meta(text(c, "id")?)["catalogRevision"].is_string()
            || lock(backend)?
                .remote_books
                .iter()
                .any(|b| b["remote"]["connectionId"] == c["id"]))
    }
    pub(super) fn cached_view(
        &self,
        backend: &Mutex<Backend>,
        c: &Value,
        channel: &str,
        query: &Value,
    ) -> Result<Value> {
        let books = lock(backend)?
            .remote_books
            .iter()
            .filter(|b| b["remote"]["connectionId"] == c["id"] && b["remote"]["available"] != false)
            .cloned()
            .collect::<Vec<_>>();
        if channel == "remote:info" {
            Ok(
                json!({"dir":text(c,"url")?,"bookCount":books.len(),"comicCount":books.len(),"epubCount":0}),
            )
        } else {
            Ok(Backend {
                root: self.root.clone(),
                books,
                remote_books: vec![],
            }
            .list(query))
        }
    }
    pub(super) fn receive_position(
        &self,
        book: &Value,
        position: Value,
        opening: bool,
    ) -> Result<()> {
        let id = text(book, "id")?;
        let _local = self.state_gate.lock().unwrap();
        let mut state = self.progress(id)?;
        let before = state.clone();
        if !state["pending"].is_null() || !state["next"].is_null() || !state["conflict"].is_null() {
            // Keep the revision that the local edit was based on. PUT performs the comparison.
            if !state["conflict"].is_null() {
                state["conflict"] = position;
            }
        } else if !opening && self.active_book.lock().unwrap().as_deref() == Some(id) {
            state["remoteCurrent"] = position;
        } else {
            if !position["position"].is_null()
                && position["contentRevision"] != book["remote"]["revision"]
            {
                state["conflict"] = position.clone();
                self.track(id, true)?;
            }
            state["current"] = position;
            state["remoteCurrent"] = Value::Null;
        }
        if state != before {
            storage::write(&self.progress_path(id)?, &state)?;
        }
        Ok(())
    }
    pub(super) fn save_local_position(
        &self,
        backend: &Mutex<Backend>,
        input: &Value,
    ) -> Result<Value> {
        let id = text(input, "bookId")?;
        let book = self.snapshot(backend, id)?;
        let revision = input["contentRevision"]
            .as_str()
            .unwrap_or(text(&book["remote"], "revision")?);
        if !digest(revision) {
            bail!("阅读位置的内容版本无效");
        }
        let manifest = if revision == book["remote"]["revision"] {
            book.clone()
        } else {
            storage::read(
                &self
                    .dir(id)?
                    .join("manifests")
                    .join(format!("{revision}.json")),
                Value::Null,
            )?
        };
        if input["pageIndex"]
            .as_u64()
            .is_none_or(|i| i >= manifest["pageCount"].as_u64().unwrap_or(0))
        {
            bail!("页码越界");
        }
        let _local = self.state_gate.lock().unwrap();
        let mut state = self.progress(id)?;
        if state["discardUntilOpen"] == true {
            return Ok(Value::Null);
        }
        let local_revision = if !state["next"].is_null() {
            &state["nextContentRevision"]
        } else if !state["pending"].is_null() {
            &state["pending"]["contentRevision"]
        } else {
            &state["current"]["contentRevision"]
        };
        // Reader unmount saves its last page too. An unchanged page is not a new edit,
        // especially when another device's position is waiting for the next open.
        if Self::display_position(&state, id)["pageIndex"] == input["pageIndex"]
            && local_revision == revision
        {
            return Ok(Value::Null);
        }
        let mut position = input.clone();
        position
            .as_object_mut()
            .context("位置格式错误")?
            .remove("contentRevision");
        position["bookId"] = book["remote"]["bookId"].clone();
        position["updatedAt"] = json!(storage::now());
        // Index first: after a crash a redundant index entry is harmless; an unindexed edit isn't.
        self.track(id, true)?;
        state["next"] = position;
        state["nextContentRevision"] = json!(revision);
        storage::write(&self.progress_path(id)?, &state)?;
        Ok(Value::Null)
    }
    pub(super) async fn open_book(
        &self,
        backend: &Mutex<Backend>,
        id: &str,
        defer: bool,
    ) -> Result<Value> {
        let mut book = self.snapshot(backend, id)?;
        if !Self::has_manifest(&book) {
            let c = self.connection(text(&book["remote"], "connectionId")?)?;
            self.info(&c).await?;
            let row = self
                .json(
                    &c,
                    Method::GET,
                    &format!("api/v1/books/{}", text(&book["remote"], "bookId")?),
                    None,
                )
                .await?;
            let fresh = self.materialize(&c, &row)?;
            if fresh["id"] != book["id"] {
                bail!("服务端返回了其他书籍");
            }
            self.cache_book(&fresh)?;
            let mut b = lock(backend)?;
            let entry = b
                .remote_books
                .iter_mut()
                .find(|b| b["id"] == id)
                .context("书籍已移除")?;
            *entry = fresh.clone();
            storage::write(
                &self.root.join("remote/catalog.json"),
                &json!(b.remote_books),
            )?;
            book = fresh;
        }
        if !defer {
            if let Ok(c) = self.connection(text(&book["remote"], "connectionId")?) {
                self.layer(&book, &c).await?;
                if c["autoSync"] != false {
                    self.flush(&book, &c).await?;
                    let position = self
                        .json(
                            &c,
                            Method::GET,
                            &format!("api/v1/books/{}/progress", text(&book["remote"], "bookId")?),
                            None,
                        )
                        .await?;
                    self.receive_position(&book, position, true)?;
                }
            }
        }
        let state = {
            let _local = self.state_gate.lock().unwrap();
            let mut s = self.progress(id)?;
            let before = s.clone();
            if s["pending"].is_null()
                && s["next"].is_null()
                && s["conflict"].is_null()
                && !s["remoteCurrent"].is_null()
            {
                s["current"] = s["remoteCurrent"].take();
            }
            s["discardUntilOpen"] = json!(false);
            if s != before {
                storage::write(&self.progress_path(id)?, &s)?;
            }
            *self.active_book.lock().unwrap() = Some(id.into());
            s
        };
        let path = self.dir(id)?.join("content/manga.json");
        if !path.exists() {
            storage::write(&path, &json!({"pages":[]}))?;
        }
        let position = if content_changed(&state, &book)
            || (state["pending"].is_null()
                && state["next"].is_null()
                && state["current"]["contentRevision"] != book["remote"]["revision"])
        {
            Value::Null
        } else {
            Self::display_position(&state, id)
        };
        Ok(
            json!({"book":book,"position":position,"textLayerPending":defer && !self.layer_current(&book)?}),
        )
    }
    pub(super) async fn synchronize(
        &self,
        backend: &Mutex<Backend>,
        c: &Value,
        full: bool,
    ) -> Result<()> {
        let cid = text(c, "id")?;
        self.update_meta(
            cid,
            json!({"phase":"syncing","lastAttemptAt":storage::now()}),
        )?;
        let result: Result<()> = async {
            let state = self.json(c,Method::GET,"api/v1/state",None).await?;
            if state["serverId"] != c["serverId"] { bail!("服务器身份发生变化，请新增连接"); }
            let jobs = state["jobs"].as_array().context("任务列表无效")?.iter().map(|job| {
                let mut job=job.clone(); job["bookId"]=json!(qualified(text(c,"serverId")?,text(&job,"bookId")?)?); Ok(job)
            }).collect::<Result<Vec<_>>>()?;
            self.update_meta(cid,json!({"jobs":jobs,"scan":{"connectionId":cid,"running":state["scan"]["running"],"completedAt":state["scan"]["completedAt"],"errors":state["scan"]["errors"]}}))?;
            if full || self.connection(cid)?["autoSync"] != false {
                let books=lock(backend)?.remote_books.iter().filter(|b| b["remote"]["connectionId"] == c["id"]).cloned().collect::<Vec<_>>();
                for book in &books { self.flush(book,c).await?; }
                let refresh_catalog = full || storage::now().saturating_sub(self.meta(cid)["lastCatalogAt"].as_u64().unwrap_or(0)) >= 30000;
                if refresh_catalog { self.catalog(backend,c).await?; }
                // Legacy servers have no compact progress snapshot.
                if refresh_catalog && self.meta(cid)["compact"] == false {
                    let fresh_books=lock(backend)?.remote_books.iter().filter(|b| b["remote"]["connectionId"] == c["id"] && b["remote"]["available"] != false).cloned().collect::<Vec<_>>();
                    for book in &fresh_books {
                        let p=self.json(c,Method::GET,&format!("api/v1/books/{}/progress",text(&book["remote"],"bookId")?),None).await?;
                        self.receive_position(book,p,false)?;
                    }
                }
                self.update_meta(cid,json!({"lastSyncedAt":storage::now()}))?;
            }
            Ok(())
        }.await;
        match &result {
            Ok(()) => self.update_meta(
                cid,
                json!({"phase":"idle","error":null,"failures":0,"retryAt":0}),
            )?,
            Err(error) => {
                let message = error.to_string();
                let failures = self.meta(cid)["failures"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_add(1)
                    .min(6);
                let phase = if message.contains("401") || message.contains("403") {
                    "auth-error"
                } else if message.contains("连接") || message.contains("中断") {
                    "offline"
                } else {
                    "error"
                };
                self.update_meta(cid,json!({"phase":phase,"error":message,"failures":failures,"retryAt":storage::now()+((1u64<<failures)*3000).min(60000)}))?;
            }
        }
        result
    }
    pub(super) async fn background_sync(&self, backend: &Mutex<Backend>) {
        let Ok(config) = self.config() else {
            return;
        };
        for c in config["connections"].as_array().unwrap() {
            let Ok(cid) = text(c, "id") else { continue };
            let meta = self.meta(cid);
            if meta["retryAt"].as_u64().unwrap_or(0) > storage::now() {
                continue;
            }
            // Pending edits sync on the next 3-second tick; idle catalogues every 30 seconds.
            let pending = self.tracked().unwrap_or_default().iter().any(|id| {
                id.as_str()
                    .and_then(|id| self.snapshot(backend, id).ok())
                    .is_some_and(|b| {
                        b["remote"]["connectionId"] == c["id"]
                            && self.progress(b["id"].as_str().unwrap()).is_ok_and(|s| {
                                s["conflict"].is_null()
                                    && (!s["next"].is_null() || !s["pending"].is_null())
                            })
                    })
            });
            let active_jobs = meta["jobs"].as_array().is_some_and(|jobs| {
                jobs.iter()
                    .any(|j| j["state"] == "running" || j["state"] == "queued")
            });
            let due =
                storage::now().saturating_sub(meta["lastAttemptAt"].as_u64().unwrap_or(0)) >= 30000;
            if due
                || (c["autoSync"] != false && pending)
                || active_jobs
                || meta["scan"]["running"] == true
            {
                let _ = self.synchronize(backend, c, false).await;
            }
        }
    }
    pub(super) fn sync_snapshot(&self, backend: &Mutex<Backend>) -> Result<Value> {
        let books = lock(backend)?.remote_books.clone();
        let mut connections = vec![];
        let mut jobs = vec![];
        let mut scans = vec![];
        let mut conflicts = vec![];
        let mut offline = vec![];
        let _local = self.state_gate.lock().unwrap();
        for c in self.config()?["connections"].as_array().unwrap() {
            let cid = text(c, "id")?;
            let meta = self.meta(cid);
            let mut pending = 0;
            let mut count = 0;
            for b in books
                .iter()
                .filter(|b| b["remote"]["connectionId"] == c["id"])
            {
                let id = text(b, "id")?;
                let s = self.progress(id)?;
                if !s["next"].is_null() || !s["pending"].is_null() {
                    pending += 1;
                }
                if !s["conflict"].is_null() {
                    count += 1;
                    let mut local = Self::display_position(&s, id);
                    if local.is_null() {
                        local = json!({});
                    }
                    conflicts.push(json!({"bookId":id,"title":b["title"],"local":local,"remote":s["conflict"]["position"],"contentChanged":content_changed(&s,b)}));
                }
            }
            let phase = meta["phase"].as_str().unwrap_or("idle");
            if ["offline", "auth-error", "error"].contains(&phase) {
                offline.push(c["id"].clone());
            }
            jobs.extend(meta["jobs"].as_array().into_iter().flatten().cloned());
            if meta["scan"].is_object() {
                scans.push(meta["scan"].clone());
            }
            connections.push(json!({"connectionId":cid,"autoSync":c["autoSync"]!=false,"phase":phase,"lastSyncedAt":meta["lastSyncedAt"],"lastAttemptAt":meta["lastAttemptAt"],"pending":pending,"conflicts":count,"catalogRevision":meta["catalogRevision"].as_str().unwrap_or(""),"error":meta["error"]}));
        }
        Ok(
            json!({"connections":connections,"jobs":jobs,"scans":scans,"conflicts":conflicts,"offline":offline}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(url: &str) -> Result<(tempfile::TempDir, Remote, Mutex<Backend>, Value, Value)> {
        let root = tempfile::tempdir()?;
        let r = Remote::new(root.path().into())?;
        let c = json!({"id":"test","serverId":"00000000-0000-4000-8000-000000000001","url":url,"token":"isolated-test-token","autoSync":false});
        storage::write(
            &r.config_path(),
            &json!({"activeId":"test","deviceId":"device","connections":[c]}),
        )?;
        let row = json!({"id":"bk_test","revision":"a".repeat(64),"format":"comic","title":"Test","titleSort":"Test","author":"","tags":[],"direction":"rtl","ocrRevision":0,"pages":[{"id":"p0","url":"pages/0.png","sha256":"b".repeat(64),"width":10,"height":20,"bytes":2},{"id":"p1","url":"pages/1.png","sha256":"b".repeat(64),"width":10,"height":20,"bytes":2}]});
        let book = r.materialize(&c, &row)?;
        r.cache_book(&book)?;
        let mut b = Backend::load(root.path().into())?;
        b.remote_books.push(book.clone());
        r.receive_position(
            &book,
            json!({"revision":1,"contentRevision":row["revision"],"position":{"pageIndex":0}}),
            true,
        )?;
        Ok((root, r, Mutex::new(b), book, c))
    }
    #[tokio::test]
    async fn cached_open_list_and_save_do_not_wait_for_network_gate() -> Result<()> {
        let (root, r, b, book, _) = fixture("http://127.0.0.1:1/")?;
        let id = text(&book, "id")?;
        let _network = r.gate.lock().await;
        let start = std::time::Instant::now();
        let opened = tokio::time::timeout(
            Duration::from_millis(500),
            r.handle(&b, "remote:open", &[json!(id), json!(true)]),
        )
        .await??;
        assert_eq!(opened["position"]["pageIndex"], 0);
        tokio::time::timeout(
            Duration::from_millis(500),
            r.handle(
                &b,
                "remote:savePosition",
                &[json!({"bookId":id,"pageIndex":1})],
            ),
        )
        .await??;
        assert_eq!(r.handle(&b, "remote:list", &[json!({})]).await?["total"], 1);
        assert_eq!(r.sync_snapshot(&b)?["connections"][0]["pending"], 1);
        let restarted = Remote::new(root.path().into())?;
        assert_eq!(restarted.progress(id)?["next"]["pageIndex"], 1);
        assert_eq!(restarted.config()?["connections"][0]["autoSync"], false);
        println!(
            "cached list/open/save while network gate held: {:?}",
            start.elapsed()
        );
        Ok(())
    }
    #[test]
    fn remote_position_does_not_rebase_a_local_edit_or_move_an_active_reader() -> Result<()> {
        let (_root, r, b, book, _) = fixture("http://127.0.0.1:1/")?;
        let id = text(&book, "id")?;
        *r.active_book.lock().unwrap() = Some(id.into());
        let other = json!({"revision":2,"contentRevision":book["remote"]["revision"],"position":{"pageIndex":1}});
        r.receive_position(&book, other.clone(), false)?;
        assert_eq!(r.progress(id)?["current"]["revision"], 1);
        assert_eq!(r.progress(id)?["remoteCurrent"]["revision"], 2);
        r.save_local_position(&b, &json!({"bookId":id,"pageIndex":0}))?;
        assert!(r.progress(id)?["next"].is_null());
        r.save_local_position(&b, &json!({"bookId":id,"pageIndex":1}))?;
        r.receive_position(&book, other, false)?;
        assert_eq!(r.progress(id)?["current"]["revision"], 1);
        assert_eq!(r.progress(id)?["next"]["pageIndex"], 1);
        Ok(())
    }
    #[tokio::test]
    async fn unchanged_reader_close_allows_remote_position_on_next_open() -> Result<()> {
        let (_root, r, b, book, _) = fixture("http://127.0.0.1:1/")?;
        let id = text(&book, "id")?;
        r.open_book(&b, id, true).await?;
        r.receive_position(&book,json!({"revision":2,"contentRevision":book["remote"]["revision"],"position":{"pageIndex":1}}),false)?;
        r.save_local_position(&b, &json!({"bookId":id,"pageIndex":0}))?;
        r.handle(&b, "remote:readerClosed", &[json!(id)]).await?;
        let reopened = r.open_book(&b, id, true).await?;
        assert_eq!(reopened["position"]["pageIndex"], 1);
        assert_eq!(r.sync_snapshot(&b)?["connections"][0]["pending"], 0);
        Ok(())
    }
    #[tokio::test]
    async fn duplicate_page_requests_share_one_download() -> Result<()> {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let url = format!("http://{}/", listener.local_addr()?);
        let (_root, r, b, book, _) = fixture(&url)?;
        let id = text(&book, "id")?;
        let bytes = b"ok";
        lock(&b)?.remote_books[0]["pages"][0]["sha256"] =
            json!(format!("{:x}", Sha256::digest(bytes)));
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buf = [0; 4096];
            socket.read(&mut buf).unwrap();
            std::thread::sleep(Duration::from_millis(30));
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
        });
        let relative = text(&book["pages"][0], "url")?;
        // Saturated shelf and prefetch budgets do not delay the active reader.
        let _covers = r.cover_slots.acquire_many(2).await?;
        let _prefetch = r.prefetch_slots.acquire().await?;
        *r.active_book.lock().unwrap() = Some(id.into());
        let (a, b) = tokio::join!(
            r.ensure_asset(&b, id, relative),
            r.ensure_asset(&b, id, relative)
        );
        a?;
        b?;
        server.join().unwrap();
        assert_eq!(fs::read(r.dir(id)?.join("content").join(relative))?, bytes);
        Ok(())
    }
    #[tokio::test]
    async fn obsolete_prefetch_is_dropped_after_waiting_for_a_slot() -> Result<()> {
        let (_root, r, b, book, _) = fixture("http://127.0.0.1:1/")?;
        let id = text(&book, "id")?;
        let slot = r.prefetch_slots.acquire().await?;
        let pages = json!([0]);
        let (old, ()) = tokio::join!(r.prefetch(&b, id, Some(&pages)), async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            r.prefetch(&b, id, Some(&json!([]))).await.unwrap();
            drop(slot);
        });
        old?;
        assert!(!r
            .dir(id)?
            .join("content")
            .join(text(&book["pages"][0], "url")?)
            .exists());
        Ok(())
    }
    #[tokio::test]
    async fn saving_during_upload_preserves_newer_position() -> Result<()> {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let url = format!("http://{}/", listener.local_addr()?);
        let (_root, r, b, book, c) = fixture(&url)?;
        let id = text(&book, "id")?;
        let (arrived, notice) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let mut writes = vec![];
            for index in 0..3 {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut raw = vec![];
                let mut buf = [0; 4096];
                let split;
                loop {
                    let n = socket.read(&mut buf).unwrap();
                    assert!(n > 0);
                    raw.extend_from_slice(&buf[..n]);
                    if let Some(i) = raw.windows(4).position(|s| s == b"\r\n\r\n") {
                        split = i + 4;
                        break;
                    }
                }
                let headers = String::from_utf8_lossy(&raw[..split]).to_lowercase();
                let size = headers
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length: "))
                    .map(|v| v.parse::<usize>().unwrap())
                    .unwrap_or(0);
                while raw.len() < split + size {
                    let n = socket.read(&mut buf).unwrap();
                    raw.extend_from_slice(&buf[..n]);
                }
                let response=if index==0 {json!({"apiVersion":1,"userId":"owner","serverId":"00000000-0000-4000-8000-000000000001"})} else {
                    let payload:Value=serde_json::from_slice(&raw[split..split+size]).unwrap();writes.push(payload.clone());
                    if index==1 {arrived.send(()).unwrap();wait.recv_timeout(Duration::from_secs(5)).unwrap();}
                    json!({"revision":index+1,"contentRevision":payload["contentRevision"],"position":payload["position"]})
                }.to_string();
                write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
            }
            writes
        });
        r.receive_position(&book,json!({"revision":1,"contentRevision":book["remote"]["revision"],"position":{"pageIndex":1}}),true)?;
        r.save_local_position(&b, &json!({"bookId":id,"pageIndex":0}))?;
        let (flushed, ()) = tokio::join!(r.flush(&book, &c), async {
            while notice.try_recv().is_err() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            r.save_local_position(&b, &json!({"bookId":id,"pageIndex":1}))
                .unwrap();
            release.send(()).unwrap();
        });
        let state = flushed?;
        assert_eq!(state["current"]["position"]["pageIndex"], 1);
        assert!(state["next"].is_null());
        assert!(state["pending"].is_null());
        let writes = server.join().unwrap();
        assert_eq!(writes[0]["baseRevision"], 1);
        assert_eq!(writes[1]["baseRevision"], 2);
        assert_eq!(writes[1]["position"]["pageIndex"], 1);
        Ok(())
    }
}
