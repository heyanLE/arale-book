use super::*;
use std::fs::OpenOptions;
use std::sync::atomic::Ordering;
use tauri::Manager;

impl Remote {
    fn download_file(&self) -> PathBuf {
        self.root.join("remote/downloads.json")
    }
    fn read_downloads(&self) -> Result<Value> {
        let value = storage::read(&self.download_file(), json!({"version":1,"jobs":[]}))?;
        if value["version"] != 1 || !value["jobs"].is_array() {
            bail!("下载队列格式错误，原文件已保留");
        }
        Ok(value)
    }
    fn edit_downloads(&self, edit: impl FnOnce(&mut Vec<Value>) -> Result<()>) -> Result<Value> {
        fs::create_dir_all(self.root.join("remote"))?;
        // Separate state and worker locks allow another app/CLI to pause or enqueue.
        let gate = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root.join("remote/download-state.lock"))?;
        gate.lock()?;
        let mut value = self.read_downloads()?;
        let previous = value.clone();
        edit(value["jobs"].as_array_mut().unwrap())?;
        if value != previous {
            storage::write(&self.download_file(), &value)?;
        }
        Ok(value)
    }
    pub fn download_status(&self, backend: &Mutex<Backend>) -> Result<Value> {
        let mut state = self.read_downloads()?;
        let b = lock(backend)?;
        for job in state["jobs"].as_array_mut().unwrap() {
            job["outdated"] = json!(b
                .book(text(job, "bookId")?)
                .is_ok_and(|book| book["remote"]["revision"] != job["revision"]));
        }
        Ok(state["jobs"].clone())
    }
    pub fn enqueue_downloads(&self, backend: &Mutex<Backend>, ids: &Value) -> Result<Value> {
        let ids = ids
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 10000)
            .context("请选择要下载的远程漫画")?;
        let mut pending = vec![];
        for id in ids {
            let id = id.as_str().context("无效书籍 ID")?;
            let book = self.snapshot(backend, id)?;
            self.dir(id)?;
            if book["remote"]["available"] == false {
                bail!("服务器已移除此书");
            }
            if pending.iter().any(|job: &Value| job["bookId"] == id) {
                continue;
            }
            pending.push(json!({"bookId":id,"title":book["title"],"revision":book["remote"]["revision"],"status":"queued","stage":"pages","done":0,"total":book["pageCount"],"bytesDone":0,"bytesTotal":0,"error":null,"updatedAt":storage::now(),"attempt":0,"retryAt":0}));
        }
        self.edit_downloads(|jobs| {
            // Keep in-flight work intact; new explicit requests go ahead of waiting books.
            pending.retain(|next| {
                !jobs
                    .iter()
                    .any(|j| j["bookId"] == next["bookId"] && j["status"] == "downloading")
            });
            jobs.retain(|j| !pending.iter().any(|n| n["bookId"] == j["bookId"]));
            let at = jobs
                .iter()
                .position(|j| j["status"] != "downloading")
                .unwrap_or(jobs.len());
            jobs.splice(at..at, pending);
            Ok(())
        })?;
        self.download_status(backend)
    }
    pub fn pause_download(&self, backend: &Mutex<Backend>, id: &str) -> Result<Value> {
        self.edit_downloads(|jobs| {
            if let Some(job) = jobs.iter_mut().find(|j| j["bookId"] == id) {
                job["status"] = json!("paused");
                job["updatedAt"] = json!(storage::now());
            }
            Ok(())
        })?;
        self.download_status(backend)
    }
    fn update_download(&self, id: &str, revision: &Value, patch: Value) -> Result<()> {
        self.edit_downloads(|jobs| {
            if let Some(job) = jobs.iter_mut().find(|j| {
                j["bookId"] == id && j["revision"] == *revision && j["status"] == "downloading"
            }) {
                for (key, value) in patch.as_object().context("无效下载状态")? {
                    job[key] = value.clone();
                }
                job["updatedAt"] = json!(storage::now());
            }
            Ok(())
        })?;
        Ok(())
    }
    async fn download_one(&self, backend: &Mutex<Backend>, job: &Value) -> Result<()> {
        let id = text(job, "bookId")?;
        let book = self.ensure_manifest(backend, id, false).await?;
        if book["remote"]["revision"] != job["revision"] {
            bail!("内容版本已变化，请刷新书架后重新下载");
        }
        self.cache_book(&book)?;
        let pages = book["pages"].as_array().context("缺少页清单")?;
        let total_bytes: u64 = pages.iter().filter_map(|p| p["bytes"].as_u64()).sum();
        self.update_download(id,&job["revision"],json!({"total":pages.len(),"bytesTotal":total_bytes,"stage":"checking"}))?;
        let mut done_bytes=0u64; let mut done=0usize; let mut missing=vec![];
        for (index,page) in pages.iter().enumerate() {
            if self.cached_page_valid(id,page)? {done+=1;done_bytes+=page["bytes"].as_u64().unwrap_or(0);} else {missing.push(index);}
            if index%32==0 {tokio::task::yield_now().await;}
        }
        self.update_download(id,&job["revision"],json!({"done":done,"bytesDone":done_bytes,"stage":"pages"}))?;
        for index in missing {
            let page=&pages[index];
            self.verify_and_cache_asset(backend,id,text(page,"url")?).await?;
            done+=1;done_bytes+=page["bytes"].as_u64().unwrap_or(0);
            self.update_download(id,&job["revision"],json!({"done":done,"bytesDone":done_bytes}))?;
        }
        self.update_download(id, &job["revision"], json!({"stage":"text"}))?;
        let c = self.connection(text(&book["remote"], "connectionId")?)?;
        self.layer(&book, &c).await?;
        storage::write(
            &self.dir(id)?.join("offline-complete.json"),
            &json!({"revision":job["revision"],"ocrRevision":book["remote"]["ocrRevision"],"pages":pages.len(),"bytes":total_bytes,"completedAt":storage::now()}),
        )?;
        self.update_download(
            id,
            &job["revision"],
            json!({"status":"complete","stage":"done","error":null}),
        )?;
        Ok(())
    }
    /// Runs in the app or an explicit local CLI. The OS lock prevents duplicate workers.
    pub async fn run_download_queue(&self, backend: &Mutex<Backend>) -> Result<()> {
        fs::create_dir_all(self.root.join("remote"))?;
        let lease = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root.join("remote/download-worker.lock"))?;
        if lease.try_lock().is_err() {
            return Ok(());
        }
        self.edit_downloads(|jobs| {
            for job in jobs {
                if job["status"] == "downloading" {
                    job["status"] = json!("queued");
                }
            }
            Ok(())
        })?;
        loop {
            let mut selected = None;
            self.edit_downloads(|jobs| {
                if let Some(job) = jobs
                    .iter_mut()
                    .find(|j| j["status"] == "queued" || j["status"] == "waiting")
                {
                    if job["retryAt"].as_u64().unwrap_or(0) > storage::now() {
                        return Ok(());
                    }
                    job["status"] = json!("downloading");
                    job["error"] = Value::Null;
                    job["attempt"] = json!(job["attempt"].as_u64().unwrap_or(0) + 1);
                    job["updatedAt"] = json!(storage::now());
                    selected = Some(job.clone());
                }
                Ok(())
            })?;
            let Some(job) = selected else { break };
            let id = text(&job, "bookId")?;
            let paused = async {
                loop {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    let state = self.read_downloads()?;
                    if !state["jobs"].as_array().unwrap().iter().any(|j| {
                        j["bookId"] == id
                            && j["revision"] == job["revision"]
                            && j["status"] == "downloading"
                    }) {
                        return Ok::<(), anyhow::Error>(());
                    }
                }
            };
            let outcome = tokio::select! {result=self.download_one(backend,&job)=>Some(result), result=paused=>{result?;None}};
            if let Some(Err(error)) = outcome {
                let message = error.to_string();
                let retry = message.contains("连接")
                    || message.contains("中断")
                    || message.contains("HTTP 5")
                    || message.contains("HTTP 429");
                self.update_download(id,&job["revision"],json!({"status":if retry{"waiting"}else{"failed"},"error":message,"retryAt":if retry{storage::now()+30000}else{0}}))?;
                // Keep the first requested volume ahead of later books during outages.
                if retry {
                    break;
                }
            }
        }
        Ok(())
    }
    pub fn pump_downloads(&self, app: &tauri::AppHandle) {
        if !self.read_downloads().is_ok_and(|s| {
            s["jobs"].as_array().unwrap().iter().any(|j| {
                ["queued", "waiting", "downloading"].contains(&j["status"].as_str().unwrap_or(""))
            })
        }) {
            return;
        }
        if self.download_pumping.swap(true, Ordering::AcqRel) {
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let remote = app.state::<Remote>();
            let _ = remote
                .run_download_queue(app.state::<Mutex<Backend>>().inner())
                .await;
            remote.download_pumping.store(false, Ordering::Release);
        });
    }
}
