use crate::storage;
use anyhow::{bail, Context, Result};
use reqwest::{Client, Url};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};

const DEFAULT_URL: &str = "https://raw.githubusercontent.com/heyanLE/arale-book-ocr-manga/main/repositories/default.jsonl";
const BUNDLED: &str = include_str!("../../engines/repositories/default.jsonl");
pub fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub fn emit(app: &tauri::AppHandle, channel: &str, payload: Value) {
    let _ = app.emit_to(
        "main",
        "arale:event",
        json!({"channel":channel,"payload":payload}),
    );
}
fn ext_id(id: &str) -> Result<&str> {
    if id.is_empty()
        || id.len() > 100
        || id.starts_with('.')
        || id.ends_with('.')
        || id.contains("..")
        || reserved_name(id)
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        bail!("扩展 ID 无效");
    }
    Ok(id)
}
fn reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3] >= b'1'
            && stem.as_bytes()[3] <= b'9')
}
fn platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}
fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
struct Busy {
    install: Option<(String, Arc<AtomicBool>)>,
    uses: HashMap<String, usize>,
}
pub struct Extensions {
    root: PathBuf,
    lock: Mutex<()>,
    busy: Mutex<Busy>,
    client: Client,
}
pub struct Lease {
    service: tauri::AppHandle,
    id: String,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let service = self.service.state::<Extensions>();
        let mut busy = service.busy.lock().unwrap();
        if let Some(value) = busy.uses.get_mut(&self.id) {
            *value = value.saturating_sub(1);
        }
    }
}
pub struct Runner {
    pub dir: PathBuf,
    pub manifest: Value,
    pub _lease: Lease,
}

impl Extensions {
    pub fn new(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(root.join(".staging"))?;
        if !root
            .join(".staging")
            .canonicalize()?
            .starts_with(root.canonicalize()?)
        {
            bail!("扩展暂存目录越界");
        }
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::custom(|a| {
                if a.previous().len() < 5
                    && a.url().scheme() == "https"
                    && a.url().username().is_empty()
                    && a.url().password().is_none()
                {
                    a.follow()
                } else {
                    a.stop()
                }
            }))
            .build()?;
        let value = Self {
            root,
            lock: Mutex::new(()),
            busy: Mutex::new(Busy {
                install: None,
                uses: HashMap::new(),
            }),
            client,
        };
        value.recover()?;
        Ok(value)
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    fn repositories(&self) -> Result<Vec<Value>> {
        storage::read(
            &self.root.join("repositories.json"),
            json!([{"name":"arale-book-ocr-manga","url":DEFAULT_URL}]),
        )?
        .as_array()
        .cloned()
        .context("仓库配置格式错误，原文件已保留")
    }
    fn installed(&self) -> Result<Vec<Value>> {
        let mut values = storage::read(&self.root.join("installed.json"), json!([]))?
            .as_array()
            .cloned()
            .context("扩展记录格式错误，原文件已保留")?;
        for item in &mut values {
            item["dir"] = json!(self.root.join(ext_id(text(item, "id"))?).to_string_lossy());
        }
        #[cfg(debug_assertions)]
        if std::env::var("ARALE_TAURI_NO_DEV_ENGINE").as_deref() != Ok("1") {
            let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
                "../engines/arale_onnx_v1/build/dev-{}-{}",
                platform(),
                arch()
            ));
            if dir.join("extension.json").is_file() {
                let manifest = storage::read(&dir.join("extension.json"), Value::Null)?;
                validate_manifest(&dir, &manifest, None)?;
                values.retain(|v| v["id"] != manifest["id"]);
                values.push(json!({"id":manifest["id"],"version":manifest["version"],"installedAt":0,"dir":dir.canonicalize()?.to_string_lossy(),"sha256":"","bytes":0,"local":true}));
            }
        }
        Ok(values)
    }
    fn catalog(&self) -> Result<(Vec<Value>, &'static str)> {
        let mut entries = Vec::new();
        let mut ids = HashSet::new();
        let mut cached = false;
        for repo in self.repositories()? {
            let file = self
                .root
                .join("repositories")
                .join(format!("{}.jsonl", hash(text(&repo, "url"))));
            let source = if file.is_file() {
                cached = true;
                fs::read_to_string(file)?
            } else if text(&repo, "url") == DEFAULT_URL {
                BUNDLED.into()
            } else {
                continue;
            };
            for entry in parse_repository(&source)? {
                if ids.insert(text(&entry, "id").to_owned()) {
                    entries.push(entry);
                }
            }
        }
        Ok((
            entries,
            if cached {
                "cache"
            } else if ids.is_empty() {
                "none"
            } else {
                "bundled"
            },
        ))
    }
    pub fn list(&self) -> Result<Value> {
        let _guard = self.lock.lock().unwrap();
        let (entries, source) = self.catalog()?;
        let installed = self.installed()?;
        let statuses:Vec<_>=entries.into_iter().map(|mut entry|{
            let found=installed.iter().find(|v|v["id"]==entry["id"]);
            let resolved=resolve_download(&entry);
            entry["bytes"]=resolved["bytes"].clone();entry["installedBytes"]=resolved["installedBytes"].clone();
            let reason=support(&entry);
            json!({"updateAvailable":found.is_some_and(|v| v["local"]!=true && v["version"]!=entry["version"]),"entry":entry,"installed":found,"supported":reason.is_none(),"unsupportedReason":reason})
        }).collect();
        Ok(
            json!({"statuses":statuses,"repositories":self.repositories()?,"source":source,"error":if source=="none" {Some("尚未取得仓库索引，请刷新仓库")}else{None}}),
        )
    }
    pub fn repository(&self, name: &str, url: &str, remove: bool) -> Result<Value> {
        let _guard = self.lock.lock().unwrap();
        let mut all = self.repositories()?;
        if remove {
            if !all.iter().any(|v| text(v, "url") == url) {
                bail!("找不到仓库");
            }
            all.retain(|v| text(v, "url") != url);
        } else {
            let parsed = Url::parse(url).context("仓库地址无效")?;
            if name.trim().is_empty()
                || parsed.scheme() != "https"
                || !parsed.path().ends_with(".jsonl")
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                bail!("仓库需要名称和 HTTPS JSONL 地址");
            }
            if all.iter().any(|v| text(v, "url") == url) {
                bail!("仓库已存在");
            }
            all.push(json!({"name":name.trim(),"url":url}));
        }
        storage::write(&self.root.join("repositories.json"), &json!(all))?;
        Ok(json!({"ok":true,"error":null}))
    }
    fn progress(
        app: &tauri::AppHandle,
        id: &str,
        phase: &str,
        received: u64,
        total: u64,
        message: &str,
    ) {
        emit(
            app,
            "extensions:progress",
            json!({"id":id,"phase":phase,"received":received,"total":total,"message":message}),
        );
    }
    async fn download(
        &self,
        app: &tauri::AppHandle,
        url: &str,
        dest: &Path,
        id: &str,
        cancel: &AtomicBool,
        max: u64,
    ) -> Result<(u64, String)> {
        let parsed = Url::parse(url)?;
        if parsed.scheme() != "https"
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            bail!("扩展下载只允许 HTTPS");
        }
        #[cfg(debug_assertions)]
        let parsed = if std::env::var("ARALE_TAURI_SMOKE").as_deref() == Ok("1")
            && parsed.host_str() == Some("tauri-smoke.invalid")
        {
            let mut mapped = Url::parse(&std::env::var("ARALE_TAURI_TEST_SERVER")?)?;
            if mapped.scheme() != "http" || mapped.host_str() != Some("127.0.0.1") {
                bail!("测试服务器无效");
            }
            mapped.set_path(parsed.path());
            mapped.set_query(parsed.query());
            mapped
        } else {
            parsed
        };
        let work = async {
            let mut response = tokio::time::timeout(
                Duration::from_secs(30),
                self.client
                    .get(parsed)
                    .header("User-Agent", "ARaLeBook/0.1")
                    .send(),
            )
            .await
            .context("下载 30 秒未收到响应")?
            .map_err(|e| e.without_url())?;
            if response.status() != 200 {
                bail!("下载服务器返回 HTTP {}", response.status());
            }
            let total = response.content_length().unwrap_or(0);
            if total > max {
                bail!("下载内容过大");
            }
            let mut file = tokio::fs::File::create(dest).await?;
            let mut digest = Sha256::new();
            let mut received = 0;
            let mut tick = 0;
            while let Some(chunk) = tokio::time::timeout(Duration::from_secs(30), response.chunk())
                .await
                .context("下载 30 秒未收到数据")?
                .map_err(|e| e.without_url())?
            {
                received += chunk.len() as u64;
                if received > max {
                    bail!("下载内容过大");
                }
                digest.update(&chunk);
                tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await?;
                if storage::now().saturating_sub(tick) > 250 {
                    Self::progress(app, id, "downloading", received, total, "");
                    tick = storage::now();
                }
            }
            file.sync_all().await?;
            if total > 0 && received != total {
                bail!("下载不完整：期望 {total} 字节，实际 {received} 字节");
            }
            Ok((received, format!("{:x}", digest.finalize())))
        };
        tokio::pin!(work);
        loop {
            tokio::select! {result=&mut work=>return result,_=tokio::time::sleep(Duration::from_millis(100))=>{if cancel.load(Ordering::SeqCst){bail!("已取消");}}}
        }
    }
    pub async fn refresh(&self, app: &tauri::AppHandle) -> Result<Value> {
        let repos = {
            let _guard = self.lock.lock().unwrap();
            self.repositories()?
        };
        let stage = tempfile::Builder::new()
            .prefix("refresh-")
            .tempdir_in(self.root.join(".staging"))?;
        let mut count = 0;
        let mut errors = Vec::new();
        for repo in repos {
            let url = text(&repo, "url");
            let dest = stage.path().join("index.jsonl");
            let result = async {
                self.download(
                    app,
                    url,
                    &dest,
                    "repository",
                    &AtomicBool::new(false),
                    4 * 1024 * 1024,
                )
                .await?;
                let source = fs::read_to_string(&dest)?;
                let entries = parse_repository(&source)?;
                let _guard = self.lock.lock().unwrap();
                fs::create_dir_all(self.root.join("repositories"))?;
                atomic_text(
                    &self
                        .root
                        .join("repositories")
                        .join(format!("{}.jsonl", hash(url))),
                    &source,
                )?;
                Ok::<usize, anyhow::Error>(entries.len())
            }
            .await;
            match result {
                Ok(n) => count += n,
                Err(e) => errors.push(format!("{}: {e:#}", text(&repo, "name"))),
            }
        }
        emit(app, "extensions:changed", json!({}));
        Ok(
            json!({"ok":errors.is_empty(),"count":count,"error":if errors.is_empty(){None}else{Some(errors.join("；"))},"source":if count>0{"remote"}else{"cache"}}),
        )
    }
    pub fn cancel(&self, id: &str) -> Value {
        if let Some((running, cancel)) = &self.busy.lock().unwrap().install {
            if running == id {
                cancel.store(true, Ordering::SeqCst);
            }
        }
        Value::Null
    }
    pub async fn install(&self, app: &tauri::AppHandle, id: &str) -> Result<Value> {
        ext_id(id)?;
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut busy = self.busy.lock().unwrap();
            if busy.install.is_some() {
                bail!("已有扩展正在安装，请等待结束");
            }
            if busy.uses.get(id).copied().unwrap_or(0) > 0 {
                bail!("OCR 正在使用这个扩展，请先取消或等待识别结束");
            }
            busy.install = Some((id.into(), cancel.clone()));
        }
        Self::progress(app, id, "resolving", 0, 0, "");
        let result = self.install_all(app, id, &cancel).await;
        self.busy.lock().unwrap().install = None;
        match result {
            Ok(()) => {
                emit(app, "extensions:changed", json!({}));
                Ok(json!({"ok":true,"error":null}))
            }
            Err(e) => {
                Self::progress(app, id, "failed", 0, 0, &format!("{e:#}"));
                Ok(json!({"ok":false,"error":format!("{e:#}")}))
            }
        }
    }
    async fn install_all(
        &self,
        app: &tauri::AppHandle,
        id: &str,
        cancel: &Arc<AtomicBool>,
    ) -> Result<()> {
        let requested = id.to_owned();
        let entries = {
            let _guard = self.lock.lock().unwrap();
            self.catalog()?.0
        };
        let mut ordered = Vec::new();
        dependency_order(
            id,
            &entries,
            &mut HashSet::new(),
            &mut HashSet::new(),
            &mut ordered,
        )?;
        for entry in ordered {
            let id = text(&entry, "id");
            {
                let _guard = self.lock.lock().unwrap();
                let found = self.installed()?.into_iter().find(|v| text(v, "id") == id);
                if found.as_ref().is_some_and(|v| v["local"] == true) {
                    bail!("开发包由 submodule 直接加载，不能安装或覆盖");
                }
                if id != requested && found.is_some() {
                    continue;
                }
            }
            if let Some(reason) = support(&entry) {
                bail!("{reason}");
            }
            if self.busy.lock().unwrap().uses.get(id).copied().unwrap_or(0) > 0 {
                bail!("扩展正在被 OCR 使用");
            }
            let download = resolve_download(&entry);
            let expected = text(&download, "sha256");
            if expected.len() != 64
                || !expected
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            {
                bail!("该平台包尚未发布有效 sha256，拒绝安装");
            }
            let stage = self
                .root
                .join(".staging")
                .join(format!("stage-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&stage)?;
            let result=async {
                let archive=stage.join("download.zip");let mut got=None;let mut last=String::new();
                for url in download["urls"].as_array().context("没有下载地址")? {
                    match self.download(app,url.as_str().context("下载地址错误")?,&archive,id,cancel,2*1024*1024*1024).await {Ok(v)=>{got=Some(v);break;},Err(e)=>{if cancel.load(Ordering::SeqCst){bail!("已取消");}last=format!("{e:#}");}}
                }
                let (bytes,digest)=got.with_context(||format!("下载失败：{last}"))?;
                Self::progress(app,id,"verifying",bytes,bytes,"");
                if download["bytes"].as_u64().is_some_and(|n|n>0 && n!=bytes){bail!("下载大小与清单不一致");}if digest!=expected {bail!("下载内容的 sha256 与清单不一致，已丢弃");}
                if cancel.load(Ordering::SeqCst){bail!("已取消");}
                Self::progress(app,id,"extracting",bytes,bytes,"");
                let unpacked=stage.join("unpacked");let archive_copy=archive.clone();let dest=unpacked.clone();let check=cancel.clone();
                let extract=tauri::async_runtime::spawn_blocking(move||extract_zip(&archive_copy,&dest,&check));
                extract.await??;
                if cancel.load(Ordering::SeqCst){bail!("已取消");}
                let manifest=storage::read(&unpacked.join("extension.json"),Value::Null)?;validate_manifest(&unpacked,&manifest,Some(&entry))?;
                let record=json!({"id":id,"version":entry["version"],"installedAt":storage::now(),"dir":self.root.join(id).to_string_lossy(),"sha256":digest,"bytes":bytes,"installToken":stage.file_name().unwrap().to_string_lossy()});
                let _guard=self.lock.lock().unwrap();
                let mut records=storage::read(&self.root.join("installed.json"),json!([]))?.as_array().cloned().context("扩展记录格式错误")?;
                storage::write(&stage.join("transaction.json"),&json!({"id":id,"record":record,"kind":"install"}))?;
                storage::write(&unpacked.join(".arale-install.json"),&json!({"token":record["installToken"]}))?;
                let target=self.root.join(id);if target.exists(){storage::rename_directory(&target,&stage.join("previous"))?;}
                if let Err(e)=storage::rename_directory(&unpacked,&target){if stage.join("previous").exists(){storage::rename_directory(&stage.join("previous"),&target)?;}return Err(e.into());}
                records.retain(|v|text(v,"id")!=id);records.push(record);
                if let Err(e)=storage::write(&self.root.join("installed.json"),&json!(records)){remove_inside(&self.root,&target)?;if stage.join("previous").exists(){storage::rename_directory(&stage.join("previous"),&target)?;}return Err(e);}
                Self::progress(app,id,"done",bytes,bytes,"");Ok::<(),anyhow::Error>(())
            }.await;
            // Recovery decides whether a transaction committed before removing its backup.
            {
                let _guard = self.lock.lock().unwrap();
                self.recover_stage(&stage)?;
            }
            result?;
        }
        Ok(())
    }
    pub fn remove(&self, id: &str) -> Result<Value> {
        ext_id(id)?;
        let busy = self.busy.lock().unwrap();
        if busy.install.is_some() || busy.uses.get(id).copied().unwrap_or(0) > 0 {
            bail!("扩展正在安装或被 OCR 使用");
        }
        let _guard = self.lock.lock().unwrap();
        if self
            .installed()?
            .iter()
            .any(|v| text(v, "id") == id && v["local"] == true)
        {
            bail!("开发包由 submodule 提供，不能从应用里删除");
        }
        let mut records = storage::read(&self.root.join("installed.json"), json!([]))?
            .as_array()
            .cloned()
            .context("扩展记录格式错误")?;
        let stage = self
            .root
            .join(".staging")
            .join(format!("stage-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&stage)?;
        storage::write(
            &stage.join("transaction.json"),
            &json!({"id":id,"kind":"remove"}),
        )?;
        let target = self.root.join(id);
        if target.exists() {
            storage::rename_directory(&target, &stage.join("previous"))?;
        }
        records.retain(|v| text(v, "id") != id);
        let outcome = storage::write(&self.root.join("installed.json"), &json!(records));
        self.recover_stage(&stage)?;
        outcome?;
        Ok(json!({"ok":true,"error":null}))
    }
    fn recover(&self) -> Result<()> {
        for entry in fs::read_dir(self.root.join(".staging"))? {
            let path = entry?.path();
            let name = path.file_name().unwrap().to_string_lossy();
            if name
                .strip_prefix("stage-")
                .is_some_and(|n| uuid::Uuid::parse_str(n).is_ok())
            {
                self.recover_stage(&path)?;
            }
        }
        Ok(())
    }
    fn recover_stage(&self, stage: &Path) -> Result<()> {
        let journal = storage::read(&stage.join("transaction.json"), Value::Null)?;
        if !journal.is_null() {
            let id = ext_id(text(&journal, "id"))?;
            let target = self.root.join(id);
            let records = storage::read(&self.root.join("installed.json"), json!([]))?;
            let installed = records
                .as_array()
                .context("扩展记录格式错误")?
                .iter()
                .find(|v| text(v, "id") == id);
            let committed = if journal["kind"] == "remove" {
                installed.is_none()
            } else {
                installed.is_some_and(|v| v["installToken"] == journal["record"]["installToken"])
            };
            if !committed {
                let marker = if target.exists() {
                    storage::read(&target.join(".arale-install.json"), Value::Null)?
                } else {
                    Value::Null
                };
                if target.exists()
                    && marker["token"] == journal["record"]["installToken"]
                    && !marker.is_null()
                {
                    remove_inside(&self.root, &target)?;
                }
                if stage.join("previous").exists() {
                    if target.exists() {
                        bail!("扩展恢复遇到未知目标目录，原文件已保留");
                    }
                    storage::rename_directory(&stage.join("previous"), &target)?;
                }
            }
        }
        remove_inside(&self.root.join(".staging"), stage)
    }
    pub fn statuses(&self) -> Result<Vec<Value>> {
        let _guard = self.lock.lock().unwrap();
        let entries = self.catalog()?.0;
        let installed = self.installed()?;
        let mut ids: Vec<_> = entries
            .iter()
            .filter(|v| v["kind"] == "ocr-engine")
            .map(|v| text(v, "provides").to_owned())
            .collect();
        for item in &installed {
            let manifest = storage::read(
                &Path::new(text(item, "dir")).join("extension.json"),
                Value::Null,
            )?;
            ids.push(text(&manifest, "provides").into());
        }
        ids.sort();
        ids.dedup();
        let mut result = Vec::new();
        for provider in ids {
            if provider.is_empty() || provider == "system" {
                continue;
            }
            let found = installed.iter().find(|v| {
                storage::read(
                    &Path::new(text(v, "dir")).join("extension.json"),
                    Value::Null,
                )
                .ok()
                .is_some_and(|m| text(&m, "provides") == provider)
            });
            let entry = entries.iter().find(|v| text(v, "provides") == provider);
            let bytes = entry
                .map(resolve_download)
                .and_then(|v| v["bytes"].as_u64())
                .unwrap_or(0);
            let mut reason = None;
            let mut label = entry
                .map(|v| text(v, "name"))
                .unwrap_or(&provider)
                .to_owned();
            let mut requirement = "需要先安装扩展".to_owned();
            if let Some(found) = found {
                let dir = Path::new(text(found, "dir"));
                let manifest = storage::read(&dir.join("extension.json"), Value::Null)?;
                if let Err(e) = validate_manifest(dir, &manifest, None) {
                    reason = Some(format!("扩展损坏：{e:#}"));
                }
                if let Some(name) = manifest["engine"]["label"].as_str() {
                    label = name.into();
                }
                requirement = manifest["engine"]["requirement"]
                    .as_str()
                    .unwrap_or("来自已安装 OCR 扩展")
                    .into();
            } else {
                reason = Some(format!(
                    "还没有安装这个扩展（约 {} MB）。到「设置 → 扩展」安装。",
                    bytes / (1024 * 1024)
                ));
            }
            result.push(json!({"id":provider,"label":label,"available":reason.is_none(),"ready":reason.is_none(),"reason":reason,"requirement":requirement,"downloadSizeMb":if found.is_some(){0}else{bytes/(1024*1024)},"extension":{"id":found.map(|v|text(v,"id")).or_else(||entry.map(|v|text(v,"id"))).unwrap_or(""),"bytes":bytes,"installed":found.is_some()}}));
        }
        Ok(result)
    }
    pub fn claim(&self, app: &tauri::AppHandle, provider: &str) -> Result<Runner> {
        let mut busy = self.busy.lock().unwrap();
        let _guard = self.lock.lock().unwrap();
        for item in self.installed()? {
            let dir = PathBuf::from(text(&item, "dir"));
            let manifest = storage::read(&dir.join("extension.json"), Value::Null)?;
            if text(&manifest, "provides") != provider {
                continue;
            }
            let id = text(&item, "id").to_owned();
            if busy.install.is_some() {
                bail!("扩展正在安装，请稍后启动 OCR");
            }
            validate_manifest(&dir, &manifest, None)?;
            *busy.uses.entry(id.clone()).or_default() += 1;
            return Ok(Runner {
                dir,
                manifest,
                _lease: Lease {
                    service: app.clone(),
                    id,
                },
            });
        }
        bail!("还没有安装 OCR 扩展：{provider}")
    }
}

fn dependency_order(
    id: &str,
    entries: &[Value],
    visiting: &mut HashSet<String>,
    done: &mut HashSet<String>,
    output: &mut Vec<Value>,
) -> Result<()> {
    if done.contains(id) {
        return Ok(());
    }
    if visiting.len() > 32 || !visiting.insert(id.into()) {
        bail!("扩展依赖循环或过深");
    }
    let entry = entries
        .iter()
        .find(|v| text(v, "id") == id)
        .with_context(|| format!("清单里没有扩展：{id}"))?;
    for dep in entry["requires"].as_array().into_iter().flatten() {
        dependency_order(
            dep.as_str().context("依赖 ID 错误")?,
            entries,
            visiting,
            done,
            output,
        )?;
    }
    visiting.remove(id);
    done.insert(id.into());
    output.push(entry.clone());
    Ok(())
}
fn support(entry: &Value) -> Option<String> {
    for (key, current) in [("platforms", platform()), ("arch", arch())] {
        if entry[key]
            .as_array()
            .is_some_and(|v| !v.is_empty() && !v.iter().any(|s| s == current))
        {
            return Some(format!("这个扩展不支持当前 {current}"));
        }
    }
    if cfg!(target_os = "macos")
        && entry["minMacOS"].as_u64().is_some_and(|min| {
            std::process::Command::new("/usr/bin/sw_vers")
                .arg("-productVersion")
                .output()
                .ok()
                .and_then(|v| String::from_utf8(v.stdout).ok())
                .and_then(|s| s.split('.').next()?.parse::<u64>().ok())
                .is_none_or(|major| major < min)
        })
    {
        return Some(format!("需要 macOS {} 或更高版本", entry["minMacOS"]));
    }
    None
}
fn resolve_download(entry: &Value) -> Value {
    let key = format!("{}-{}", platform(), arch());
    let asset = &entry["release"]["assets"][&key];
    let mut urls = entry["urls"].as_array().cloned().unwrap_or_default();
    if asset.is_object() {
        urls.push(json!(format!(
            "https://github.com/{}/releases/download/{}/{}",
            text(&entry["release"], "repo"),
            percent_encoding::utf8_percent_encode(
                text(&entry["release"], "tag"),
                percent_encoding::NON_ALPHANUMERIC
            ),
            percent_encoding::utf8_percent_encode(
                text(asset, "asset"),
                percent_encoding::NON_ALPHANUMERIC
            )
        )));
    }
    json!({"urls":urls,"sha256":asset.get("sha256").unwrap_or(&entry["sha256"]),"bytes":asset.get("bytes").unwrap_or(&entry["bytes"]),"installedBytes":asset.get("installedBytes").unwrap_or(&entry["installedBytes"])})
}
pub fn parse_repository(source: &str) -> Result<Vec<Value>> {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for line in source.lines().filter(|s| !s.trim().is_empty()) {
        let mut entry: Value = serde_json::from_str(line).context("仓库包含无效 JSON 行")?;
        for key in ["id", "name", "version", "provides", "kind"] {
            if text(&entry, key).is_empty() {
                bail!("仓库条目缺少 {key}");
            }
        }
        ext_id(text(&entry, "id"))?;
        if !seen.insert(text(&entry, "id").to_owned()) {
            bail!("仓库条目 ID 重复");
        }
        for key in ["summary", "sha256", "license", "homepage", "notes"] {
            if !entry[key].is_string() {
                entry[key] = json!("");
            }
        }
        for key in ["urls", "platforms", "arch", "requires"] {
            let values: Vec<_> = entry[key]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|v| v.is_string())
                .cloned()
                .collect();
            entry[key] = json!(values);
        }
        for key in ["bytes", "installedBytes"] {
            if !entry[key].is_u64() {
                entry[key] = json!(0);
            }
        }
        if entry["urls"].as_array().unwrap().is_empty() && !entry["release"].is_object() {
            bail!("仓库条目没有下载地址");
        }
        if let Some(release) = entry.get("release") {
            let repo = text(release, "repo");
            let parts: Vec<_> = repo.split('/').collect();
            if parts.len() != 2
                || parts.iter().any(|p| {
                    p.is_empty()
                        || !p
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                })
                || text(release, "tag").is_empty()
            {
                bail!("Release 身份无效");
            }
            let assets = release["assets"]
                .as_object()
                .context("Release 缺少 assets")?;
            if assets.is_empty() {
                bail!("Release assets 为空");
            }
            for asset in assets.values() {
                let name = text(asset, "asset");
                if name.is_empty() || name.contains(['/', '\\']) || name.contains("..") {
                    bail!("Release 包名不能带路径");
                }
                let digest = text(asset, "sha256");
                if !digest.is_empty()
                    && (digest.len() != 64
                        || !digest
                            .bytes()
                            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
                {
                    bail!("Release sha256 无效");
                }
            }
        }
        entry["kind"] = json!("ocr-engine");
        entries.push(entry);
    }
    Ok(entries)
}
pub fn validate_manifest(dir: &Path, manifest: &Value, entry: Option<&Value>) -> Result<()> {
    ext_id(text(manifest, "id"))?;
    if text(manifest, "version").is_empty() || text(manifest, "provides").is_empty() {
        bail!("扩展自描述缺少 version / provides");
    }
    if let Some(entry) = entry {
        for key in ["id", "version", "provides"] {
            if entry[key] != manifest[key] {
                bail!("扩展自描述的 {key} 与清单不一致");
            }
        }
    }
    let program = storage::inside(dir, text(&manifest["runner"], "program"))?;
    if !program.is_file() {
        bail!("runner 不是文件");
    }
    let args = manifest["runner"]["args"]
        .as_array()
        .context("runner 缺少 args")?;
    if !args.iter().all(Value::is_string) {
        bail!("runner args 格式错误");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&program)?.permissions().mode();
        fs::set_permissions(program, fs::Permissions::from_mode(mode | 0o111))?;
    }
    Ok(())
}
fn extract_zip(archive: &Path, dest: &Path, cancel: &AtomicBool) -> Result<()> {
    fs::create_dir(dest)?;
    let mut zip = zip::ZipArchive::new(fs::File::open(archive)?)?;
    if zip.len() > 100_000 {
        bail!("扩展成员过多");
    }
    let mut seen = HashSet::new();
    let mut total = 0u64;
    for index in 0..zip.len() {
        if cancel.load(Ordering::SeqCst) {
            bail!("已取消");
        }
        let mut member = zip.by_index(index)?;
        let relative = member.name().replace('\\', "/");
        if relative.starts_with('/')
            || relative.contains(':')
            || relative.contains('\0')
            || relative.split('/').any(|s| s == "..")
            || member.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
        {
            bail!("扩展归档含越界路径或符号链接");
        }
        let segments: Vec<_> = relative
            .split('/')
            .filter(|s| !s.is_empty() && *s != ".")
            .collect();
        if segments.iter().any(|s| {
            s.ends_with(['.', ' ']) || s.contains(['<', '>', '|', '?', '*']) || reserved_name(s)
        }) {
            bail!("扩展归档含 Windows 路径别名或设备名称");
        }
        if segments.is_empty() {
            continue;
        }
        let relative = segments.join("/");
        if !seen.insert(relative.to_lowercase()) {
            bail!("扩展归档成员重复");
        }
        let target = dest.join(&relative);
        if member.is_dir() {
            fs::create_dir_all(target)?;
            continue;
        }
        if member.size() > 1024 * 1024 * 1024 {
            bail!("扩展单个文件过大");
        }
        fs::create_dir_all(target.parent().unwrap())?;
        let mut output = fs::File::create(&target)?;
        let mut actual = 0u64;
        let mut chunk = [0u8; 64 * 1024];
        loop {
            if cancel.load(Ordering::SeqCst) {
                bail!("已取消");
            }
            let size = member.read(&mut chunk)?;
            if size == 0 {
                break;
            }
            actual += size as u64;
            total += size as u64;
            if actual > 1024 * 1024 * 1024 || total > 4 * 1024 * 1024 * 1024 {
                bail!("扩展解压体积过大");
            }
            output.write_all(&chunk[..size])?;
        }
    }
    Ok(())
}
fn remove_inside(root: &Path, target: &Path) -> Result<()> {
    if !target.exists() {
        return Ok(());
    }
    let root = root.canonicalize()?;
    let target = target.canonicalize()?;
    if !target.starts_with(&root) || target == root {
        bail!("拒绝移除越界目录");
    }
    fs::remove_dir_all(target)?;
    Ok(())
}
fn atomic_text(path: &Path, value: &str) -> Result<()> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().context("没有父目录")?)?;
    file.write_all(value.as_bytes())?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|e| e.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn archive(root: &Path, names: &[&str]) -> PathBuf {
        let path = root.join("fixture.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for name in names {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"fixture").unwrap();
        }
        zip.finish().unwrap();
        path
    }
    #[test]
    fn repository_validation_and_dependency_cycles() {
        assert_eq!(parse_repository(BUNDLED).unwrap().len(), 1);
        let item = json!({"id":"engine","name":"Engine","kind":"ocr-engine","provides":"arale_onnx_v1","version":"1","urls":["https://example.invalid/a.zip"],"requires":["engine"]});
        let entries = parse_repository(&item.to_string()).unwrap();
        assert!(dependency_order(
            "engine",
            &entries,
            &mut HashSet::new(),
            &mut HashSet::new(),
            &mut vec![]
        )
        .is_err());
        assert!(parse_repository(&format!("{item}\n{item}")).is_err());
        assert!(ext_id("../escape").is_err());
    }
    #[test]
    fn archive_paths_duplicates_and_cancellation() {
        let root = tempfile::tempdir().unwrap();
        for (index, names) in [
            vec!["../escape"],
            vec!["a.txt", "A.txt"],
            vec!["C:/escape"],
            vec!["safe/../../escape"],
            vec!["CON.txt"],
            vec!["safe/.. /escape"],
        ]
        .iter()
        .enumerate()
        {
            let zip = archive(root.path(), names);
            assert!(extract_zip(
                &zip,
                &root.path().join(index.to_string()),
                &AtomicBool::new(false)
            )
            .is_err());
        }
        let zip = archive(root.path(), &["safe.txt"]);
        assert!(extract_zip(&zip, &root.path().join("cancel"), &AtomicBool::new(true)).is_err());
        extract_zip(&zip, &root.path().join("valid"), &AtomicBool::new(false)).unwrap();
        assert_eq!(
            fs::read(root.path().join("valid/safe.txt")).unwrap(),
            b"fixture"
        );
        assert!(!root.path().join("escape").exists());
    }
    #[test]
    fn manifest_identity_and_runner_boundary() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("runner"), b"runner").unwrap();
        let manifest = json!({"id":"engine","version":"1","provides":"provider","runner":{"program":"runner","args":[]}});
        validate_manifest(root.path(), &manifest, Some(&manifest)).unwrap();
        let mut mismatch = manifest.clone();
        mismatch["version"] = json!("2");
        assert!(validate_manifest(root.path(), &manifest, Some(&mismatch)).is_err());
        let mut escaped = manifest;
        escaped["runner"]["program"] = json!("../runner");
        assert!(validate_manifest(root.path(), &escaped, None).is_err());
    }
    #[test]
    fn crash_recovery_rolls_back_or_keeps_committed_package() {
        for committed in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let stage = root
                .path()
                .join(".staging")
                .join(format!("stage-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(stage.join("previous")).unwrap();
            fs::write(stage.join("previous/old"), b"old").unwrap();
            fs::create_dir(root.path().join("engine")).unwrap();
            fs::write(root.path().join("engine/new"), b"new").unwrap();
            let record = json!({"id":"engine","installToken":"new"});
            storage::write(
                &stage.join("transaction.json"),
                &json!({"id":"engine","kind":"install","record":record}),
            )
            .unwrap();
            storage::write(
                &root.path().join("engine/.arale-install.json"),
                &json!({"token":"new"}),
            )
            .unwrap();
            storage::write(
                &root.path().join("installed.json"),
                &if committed {
                    json!([record])
                } else {
                    json!([])
                },
            )
            .unwrap();
            Extensions::new(root.path().into()).unwrap();
            assert!(root
                .path()
                .join(if committed {
                    "engine/new"
                } else {
                    "engine/old"
                })
                .is_file());
            assert!(!stage.exists());
        }
    }
    #[test]
    fn remove_transaction_restores_package_until_record_commits() {
        let root = tempfile::tempdir().unwrap();
        let service = Extensions::new(root.path().into()).unwrap();
        let stage = root
            .path()
            .join(".staging")
            .join(format!("stage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(stage.join("previous")).unwrap();
        fs::write(stage.join("previous/old"), b"old").unwrap();
        storage::write(
            &stage.join("transaction.json"),
            &json!({"id":"engine","kind":"remove"}),
        )
        .unwrap();
        storage::write(
            &root.path().join("installed.json"),
            &json!([{"id":"engine"}]),
        )
        .unwrap();
        service.recover_stage(&stage).unwrap();
        assert!(root.path().join("engine/old").is_file());
    }
}
