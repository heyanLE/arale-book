//! Native lifetime/queue/process ownership; line normalization and blocks stay in shared TS.
use crate::{
    extensions::{self, Extensions},
    storage, State,
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::Manager;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::oneshot,
};

#[derive(Clone)]
struct Item {
    book_id: String,
    title: String,
    provider: String,
    total: usize,
    enqueued_at: u64,
}
struct Active {
    item: Item,
    cancel: Arc<AtomicBool>,
}
struct Pending {
    token: String,
    book: Value,
    source: String,
    raw: Vec<Option<String>>,
    old: Value,
    cancelled: bool,
    sender: oneshot::Sender<Value>,
}
struct Queue {
    waiting: VecDeque<Item>,
    active: Option<Active>,
    results: HashMap<String, Value>,
    pending: Option<Pending>,
}
pub struct Ocr {
    queue: Mutex<Queue>,
    probe: tokio::sync::OnceCell<Value>,
    tool: Option<PathBuf>,
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    extensions::text(value, key)
}
fn emit(app: &tauri::AppHandle, channel: &str, value: Value) {
    extensions::emit(app, channel, value)
}
fn result(id: &str, provider: &str, error: Option<&str>) -> Value {
    json!({"bookId":id,"provider":provider,"ok":error.is_none(),"pages":0,"blocks":0,"error":error})
}
fn entry(item: &Item) -> Value {
    json!({"bookId":item.book_id,"title":item.title,"provider":item.provider,"total":item.total,"enqueuedAt":item.enqueued_at})
}

impl Ocr {
    pub fn new(root: &Path, _app: &tauri::AppHandle) -> Result<Self> {
        #[cfg(windows)]
        let tool = {
            let dir = root.join("tools");
            fs::create_dir_all(&dir)?;
            let file = dir.join("arale-winrt-ocr.ps1");
            // Preserve the BOM required by Windows PowerShell 5.1.
            let source = include_bytes!("../../native/arale-winrt-ocr.ps1");
            let mut bytes = Vec::new();
            if !source.starts_with(&[0xef, 0xbb, 0xbf]) {
                bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
            }
            bytes.extend_from_slice(source);
            if fs::read(&file).ok().as_deref() != Some(bytes.as_slice()) {
                let mut temporary = tempfile::NamedTempFile::new_in(&dir)?;
                std::io::Write::write_all(&mut temporary, &bytes)?;
                temporary.as_file().sync_all()?;
                temporary.persist(&file).map_err(|e| e.error)?;
            }
            Some(file)
        };
        #[cfg(not(windows))]
        let tool = {
            #[cfg(target_os = "macos")]
            {
                let file = _app.path().resource_dir()?.join("tools/arale-vision-ocr");
                #[cfg(debug_assertions)]
                let file = if file.is_file() {
                    file
                } else {
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../native/arale-vision-ocr/arale-vision-ocr")
                };
                file.is_file().then_some(file)
            }
            #[cfg(not(target_os = "macos"))]
            {
                None
            }
        };
        Ok(Self {
            queue: Mutex::new(Queue {
                waiting: VecDeque::new(),
                active: None,
                results: HashMap::new(),
                pending: None,
            }),
            probe: tokio::sync::OnceCell::new(),
            tool,
        })
    }
    fn selected(app: &tauri::AppHandle) -> Result<String> {
        let state = app.state::<State>();
        let backend = state.lock().unwrap();
        let settings = storage::read(&backend.root.join("settings.json"), json!({}))?;
        Ok(settings["ocrProvider"].as_str().unwrap_or("system").into())
    }
    pub async fn capability(&self, app: &tauri::AppHandle) -> Result<Value> {
        let system=self.probe.get_or_init(||async {
            let mut value=json!({"id":"system","label":if cfg!(windows){"系统 OCR（Windows.Media.Ocr）"}else{"系统 OCR（macOS Vision）"},"available":false,"ready":false,"reason":"没有找到系统 OCR 组件","requirement":"随应用分发，无需安装","downloadSizeMb":0,"extension":null});
            if let Some(tool)=&self.tool {let (program,args)=command_for(tool,&["--probe".into()]);
                match tokio::time::timeout(Duration::from_secs(30),run_process(&program,&args,tool.parent(),None,&AtomicBool::new(false),|_|Ok(()))).await {
                    Ok(Ok(output))=>{let ready=output.probe.as_ref().is_some_and(|v|v["ok"]==true);value["available"]=json!(ready);value["ready"]=json!(ready);value["reason"]=if ready{Value::Null}else{json!(output.probe.as_ref().map(|v|text(v,"error")).filter(|s|!s.is_empty()).unwrap_or("系统 OCR 自检失败，请检查 OCR 语言包"))};},
                    other=>{value["reason"]=json!(format!("系统 OCR 自检失败：{other:?}"));}
                }
            }value
        }).await.clone();
        let extensions = app.state::<Extensions>();
        let mut providers = vec![system];
        providers.extend(extensions.statuses()?);
        let selected = Self::selected(app)?;
        let current = providers
            .iter()
            .find(|v| text(v, "id") == selected)
            .unwrap_or(&providers[0]);
        Ok(
            json!({"available":providers.iter().any(|v|v["available"]==true),"reason":current["reason"],"selected":selected,"providers":providers,"extensionsDir":extensions.root().to_string_lossy()}),
        )
    }
    pub fn select(&self, app: &tauri::AppHandle, provider: &str) -> Result<()> {
        let allowed = provider == "system"
            || app
                .state::<Extensions>()
                .statuses()?
                .iter()
                .any(|v| text(v, "id") == provider);
        if !allowed {
            bail!("未知 OCR 引擎");
        }
        let state = app.state::<State>();
        let backend = state.lock().unwrap();
        let file = backend.root.join("settings.json");
        let mut stored = storage::read(&file, json!({}))?;
        stored["ocrProvider"] = json!(provider);
        storage::write(&file, &stored)
    }
    pub fn queue_state(&self) -> Value {
        let queue = self.queue.lock().unwrap();
        json!({"active":queue.active.as_ref().map(|v|entry(&v.item)),"pending":queue.waiting.iter().map(entry).collect::<Vec<_>>()})
    }
    pub fn status(&self, id: &str) -> Value {
        let queue = self.queue.lock().unwrap();
        if let Some(active) = &queue.active {
            if active.item.book_id == id {
                return result(id, &active.item.provider, Some("正在识别中…"));
            }
        }
        if let Some((index, item)) = queue
            .waiting
            .iter()
            .enumerate()
            .find(|(_, v)| v.book_id == id)
        {
            let mut value = result(id, &item.provider, Some("排队中…"));
            value["queued"] = json!(true);
            value["queuePosition"] = json!(index + 1);
            return value;
        }
        queue.results.get(id).cloned().unwrap_or(Value::Null)
    }
    pub fn start(&self, app: &tauri::AppHandle, id: &str, options: &Value) -> Result<Value> {
        storage::valid_id(id)?;
        let mut provider = options["provider"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or(Self::selected(app)?);
        if provider != "system"
            && !app
                .state::<Extensions>()
                .statuses()?
                .iter()
                .any(|v| text(v, "id") == provider)
        {
            provider = "system".into();
        }
        let state = app.state::<State>();
        let backend = state.lock().unwrap();
        if app.state::<crate::study::Study>().busy(id) {
            bail!("书籍正在制卡，请稍后 OCR");
        }
        let book = backend.book(id)?;
        let pages = book["pages"]
            .as_array()
            .context("这本书没有页图，不需要 OCR")?;
        if pages.is_empty() {
            bail!("这本书没有页图，不需要 OCR");
        }
        let mut queue = self.queue.lock().unwrap();
        if let Some(active) = &queue.active {
            if active.item.book_id == id {
                return Ok(result(id, &active.item.provider, Some("已在识别中…")));
            }
        }
        if let Some((index, item)) = queue
            .waiting
            .iter()
            .enumerate()
            .find(|(_, v)| v.book_id == id)
        {
            let mut value = result(id, &item.provider, Some("已在队列中"));
            value["queued"] = json!(true);
            value["queuePosition"] = json!(index + 1);
            return Ok(value);
        }
        if options["force"] != true {
            let raw = storage::read(&backend.dir(id)?.join("content/manga.json"), json!({}))?;
            let blocks = count_blocks(&raw);
            if blocks > 0 {
                let mut value = result(id, &provider, None);
                value["blocks"] = json!(blocks);
                value["skipped"] = json!(true);
                queue.results.insert(id.into(), value.clone());
                return Ok(value);
            }
        }
        let position = queue.waiting.len() + 1;
        queue.waiting.push_back(Item {
            book_id: id.into(),
            title: text(book, "title").into(),
            provider: provider.clone(),
            total: pages.len(),
            enqueued_at: storage::now(),
        });
        drop(queue);
        drop(backend);
        emit(app, "ocr:queue", self.queue_state());
        self.pump(app);
        let mut value = result(id, &provider, None);
        value["queued"] = json!(true);
        value["queuePosition"] = json!(position);
        Ok(value)
    }
    pub fn cancel(&self, app: &tauri::AppHandle, id: &str) -> Value {
        let mut queue = self.queue.lock().unwrap();
        if let Some(active) = &queue.active {
            if active.item.book_id == id {
                active.cancel.store(true, Ordering::SeqCst);
                if let Some(pending) = queue.pending.as_mut() {
                    pending.cancelled = true;
                }
                return Value::Null;
            }
        }
        if let Some(index) = queue.waiting.iter().position(|v| v.book_id == id) {
            let item = queue.waiting.remove(index).unwrap();
            let value = result(id, &item.provider, Some("已取消（还没开始识别）"));
            queue.results.insert(id.into(), value.clone());
            drop(queue);
            emit(app, "ocr:done", value);
            emit(app, "ocr:queue", self.queue_state());
        }
        Value::Null
    }
    fn pump(&self, app: &tauri::AppHandle) {
        let mut queue = self.queue.lock().unwrap();
        if queue.active.is_some() {
            return;
        }
        let Some(item) = queue.waiting.pop_front() else {
            return;
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let token = uuid::Uuid::new_v4().to_string();
        queue.active = Some(Active {
            item: item.clone(),
            cancel: cancel.clone(),
        });
        drop(queue);
        emit(app, "ocr:queue", self.queue_state());
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<Ocr>();
            let output = state.run_job(&app, &item, &token, cancel).await;
            let value = output
                .unwrap_or_else(|e| result(&item.book_id, &item.provider, Some(&format!("{e:#}"))));
            {
                let mut queue = state.queue.lock().unwrap();
                queue.active = None;
                queue.pending = None;
                queue.results.insert(item.book_id.clone(), value.clone());
            }
            emit(&app, "ocr:done", value);
            emit(&app, "ocr:queue", state.queue_state());
            state.pump(&app);
        });
    }
    async fn run_job(
        &self,
        app: &tauri::AppHandle,
        item: &Item,
        token: &str,
        cancel: Arc<AtomicBool>,
    ) -> Result<Value> {
        let (book, content, old, source) = {
            let state = app.state::<State>();
            let backend = state.lock().unwrap();
            let book = backend.book(&item.book_id)?.clone();
            let content = backend.dir(&item.book_id)?.join("content");
            let old = storage::read(&content.join("manga.json"), json!({}))?;
            let source = fingerprint(&book, &old);
            (book, content, old, source)
        };
        let pages = book["pages"].as_array().context("书籍页图列表无效")?;
        let mut inputs = Vec::new();
        for page in pages {
            let path = storage::inside(&content, text(page, "url"))?;
            inputs.push(json!({"rel":page["url"],"absPath":process_path(&path),"width":page["width"],"height":page["height"]}));
        }
        let mut raw = vec![None; pages.len()];
        let mut reported = HashSet::new();
        let progress = |stage: &str, done: usize, index: usize, message: &str| {
            emit(
                app,
                "ocr:progress",
                json!({"bookId":item.book_id,"provider":item.provider,"done":done,"total":pages.len(),"pageIndex":index,"stage":stage,"message":message}),
            )
        };
        progress("loading-model", 0, 0, "");
        let mut on_line = |line: &str| -> Result<()> {
            let Ok(event) = serde_json::from_str::<Value>(line) else {
                return Ok(());
            };
            if event["kind"] == "meta" && item.provider == "system" {
                let languages = event["languages"].as_array().cloned().unwrap_or_default();
                if !languages.iter().any(|v| v == "ja-JP") {
                    progress(
                        "loading-model",
                        reported.len(),
                        0,
                        "系统 OCR 未提供日语模型，使用系统可用语言",
                    );
                }
            }
            if event["kind"] != "page" {
                return Ok(());
            }
            let file = text(&event, "file");
            let index = inputs
                .iter()
                .position(|p| text(p, "rel") == file || text(p, "absPath") == file)
                .or_else(|| {
                    inputs.iter().position(|p| {
                        Path::new(file).file_name() == Path::new(text(p, "rel")).file_name()
                    })
                });
            if let Some(index) = index {
                raw[index] = Some(line.into());
                reported.insert(index);
                progress("recognizing", reported.len(), index, "");
            }
            Ok(())
        };
        if item.provider == "system" {
            let capability = self.capability(app).await?;
            if !capability["providers"][0]["available"]
                .as_bool()
                .unwrap_or(false)
            {
                bail!("系统 OCR 不可用：{}", capability["providers"][0]["reason"]);
            }
            let tool = self.tool.as_ref().context("系统 OCR 组件不存在")?;
            for batch in inputs.chunks(40) {
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
                let mut args = if cfg!(windows) {
                    vec!["--".into()]
                } else {
                    vec!["--lang".into(), "ja-JP,en-US".into(), "--".into()]
                };
                args.extend(batch.iter().map(|v| text(v, "absPath").to_owned()));
                let (program, args) = command_for(tool, &args);
                let outcome =
                    run_process(&program, &args, tool.parent(), None, &cancel, &mut on_line)
                        .await?;
                if !cancel.load(Ordering::SeqCst) {
                    check_process(&outcome)?;
                }
            }
        } else {
            let extensions = app.state::<Extensions>();
            let runner = extensions.claim(app, &item.provider)?;
            let spec = tempfile::Builder::new().prefix("arale-ocr-").tempdir()?;
            let file = spec.path().join("pages.json");
            storage::write(&file, &json!({"pages":inputs}))?;
            let program =
                storage::inside(&runner.dir, text(&runner.manifest["runner"], "program"))?;
            let args: Vec<_> = runner.manifest["runner"]["args"]
                .as_array()
                .context("runner args 无效")?
                .iter()
                .map(|v| {
                    v.as_str()
                        .unwrap_or("")
                        .replace("{pagesFile}", &file.to_string_lossy())
                })
                .collect();
            let (program, args) = command_for(&program, &args);
            let mut environment = HashMap::from([
                ("PYTHONUNBUFFERED".into(), "1".into()),
                ("PYTHONIOENCODING".into(), "utf-8".into()),
                ("HF_HUB_OFFLINE".into(), "1".into()),
                ("TRANSFORMERS_OFFLINE".into(), "1".into()),
            ]);
            for (key, value) in runner.manifest["runner"]["env"]
                .as_object()
                .into_iter()
                .flatten()
            {
                if let Some(value) = value.as_str() {
                    environment.insert(key.clone(), value.into());
                }
            }
            let output = run_process(
                &program,
                &args,
                Some(&runner.dir),
                Some(&environment),
                &cancel,
                &mut on_line,
            )
            .await?;
            if !cancel.load(Ordering::SeqCst) {
                check_process(&output)?;
            }
        }
        drop(on_line);
        progress("writing", reported.len(), 0, "");
        #[cfg(debug_assertions)]
        if std::env::var("ARALE_TAURI_SMOKE").as_deref() == Ok("1") {
            let state = app.state::<State>();
            let backend = state.lock().unwrap();
            storage::write(
                &backend.root.join(format!("ocr-raw-{}.json", item.book_id)),
                &json!({"book":book,"raw":raw,"old":old,"provider":item.provider}),
            )?;
        }
        let (sender, receiver) = oneshot::channel();
        {
            let mut queue = self.queue.lock().unwrap();
            queue.pending = Some(Pending {
                token: token.into(),
                book,
                source,
                raw,
                old,
                cancelled: cancel.load(Ordering::SeqCst),
                sender,
            });
        }
        emit(app, "ocr:convert", json!({"token":token}));
        tokio::time::timeout(Duration::from_secs(120), receiver)
            .await
            .context("OCR 结果转换超时，界面 Worker 未回应")?
            .context("OCR 结果转换中断")
    }
    pub fn pending(&self) -> Value {
        let queue = self.queue.lock().unwrap();
        queue.pending.as_ref().map(|p|json!({"token":p.token,"book":p.book,"raw":p.raw,"old":p.old,"cancelled":p.cancelled,"provider":queue.active.as_ref().map(|a|&a.item.provider)})).unwrap_or(Value::Null)
    }
    pub fn commit(&self, app: &tauri::AppHandle, token: &str, payload: &Value) -> Result<Value> {
        // Acquire book storage before queue state, matching start; no async IO under either lock.
        let state = app.state::<State>();
        let backend = state.lock().unwrap();
        let mut queue = self.queue.lock().unwrap();
        let Some(pending) = queue.pending.as_ref() else {
            return Ok(Value::Null);
        };
        if pending.token != token {
            return Ok(Value::Null);
        }
        let id = text(&pending.book, "id");
        let provider = queue
            .active
            .as_ref()
            .map(|v| v.item.provider.clone())
            .context("OCR 活动任务已结束")?;
        let outcome = (|| -> Result<Value> {
            if let Some(error) = payload["error"].as_str() {
                bail!("识别完成但转换文字层失败：{error}");
            }
            let book = backend.book(id)?;
            let content = backend.dir(id)?.join("content");
            let existing = storage::read(&content.join("manga.json"), json!({}))?;
            if fingerprint(book, &existing) != pending.source {
                bail!("OCR 期间页图列表、阅读方向或文字层已变化，保留原文件");
            }
            let layer = &payload["layer"];
            validate_layer(book, layer)?;
            storage::write(&content.join("manga.json"), layer)?;
            #[cfg(debug_assertions)]
            if std::env::var("ARALE_TAURI_SMOKE").as_deref() == Ok("1") {
                storage::write(
                    &backend.root.join(format!("ocr-result-{token}.json")),
                    &json!({"book":pending.book,"raw":pending.raw,"old":pending.old,"provider":provider,"layer":layer}),
                )?;
            }
            let mut value = result(id, &provider, None);
            value["pages"] = if pending.cancelled {
                payload["freshPages"].clone()
            } else {
                json!(book["pages"].as_array().unwrap().len())
            };
            value["blocks"] = if pending.cancelled {
                payload["freshBlocks"].clone()
            } else {
                json!(count_blocks(layer))
            };
            if pending.cancelled {
                value["ok"] = json!(false);
                value["error"] = json!("已取消（已识别的页已保存）");
            }
            Ok(value)
        })();
        let value = outcome.unwrap_or_else(|e| result(id, &provider, Some(&format!("{e:#}"))));
        let pending = queue.pending.take().unwrap();
        let _ = pending.sender.send(value.clone());
        drop(queue);
        drop(backend);
        emit(app, "library:changed", json!({"reason":"ocr"}));
        Ok(value)
    }
    pub fn is_running(&self, id: &str) -> bool {
        let queue = self.queue.lock().unwrap();
        queue.active.as_ref().is_some_and(|v| v.item.book_id == id)
            || queue.waiting.iter().any(|v| v.book_id == id)
    }
}
fn fingerprint(book: &Value, old: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            json!([book["pages"], book["direction"], old])
                .to_string()
                .as_bytes()
        )
    )
}
fn count_blocks(raw: &Value) -> usize {
    raw["pages"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| v["blocks"].as_array().map_or(0, Vec::len))
        .sum()
}
fn validate_layer(book: &Value, raw: &Value) -> Result<()> {
    let pages = book["pages"].as_array().context("页图列表无效")?;
    let output = raw["pages"].as_array().context("文字层页列表无效")?;
    if pages.len() != output.len() {
        bail!("OCR 文字层页数不匹配");
    }
    for (page, value) in pages.iter().zip(output) {
        if page["url"] != value["url"]
            || page["width"] != value["width"]
            || page["height"] != value["height"]
        {
            bail!("OCR 文字层页身份不匹配");
        }
        for block in value["blocks"].as_array().context("OCR blocks 无效")? {
            if !block["box"].as_array().is_some_and(|b| {
                b.len() == 4 && b.iter().all(|n| n.as_f64().is_some_and(f64::is_finite))
            }) || !block["lines"]
                .as_array()
                .is_some_and(|v| v.iter().all(Value::is_string))
            {
                bail!("OCR 文字块坐标或文本无效");
            }
        }
    }
    Ok(())
}
fn command_for(program: &Path, args: &[String]) -> (PathBuf, Vec<String>) {
    if cfg!(windows)
        && program
            .extension()
            .is_some_and(|v| v.eq_ignore_ascii_case("ps1"))
    {
        let exe = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:/Windows"))
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = vec![
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-File".into(),
            program.to_string_lossy().into_owned(),
        ];
        command.extend_from_slice(args);
        (exe, command)
    } else {
        (program.into(), args.to_vec())
    }
}
fn process_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    // canonicalize verifies containment but produces Win32 verbatim paths; WinRT rejects them.
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.into();
        }
    }
    value.into_owned()
}
#[derive(Debug)]
struct ProcessResult {
    code: Option<i32>,
    pages: usize,
    fatal: Option<String>,
    probe: Option<Value>,
    stderr: String,
}
fn check_process(value: &ProcessResult) -> Result<()> {
    if let Some(fatal) = &value.fatal {
        bail!("{fatal}：{}", value.stderr);
    }
    if value.pages == 0 {
        bail!(
            "OCR 运行进程没有产出结果（退出码 {:?}）：{}",
            value.code,
            value.stderr
        );
    }
    Ok(())
}
async fn bounded_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Option<String>> {
    let mut bytes = Vec::new();
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
            };
        }
        let size = chunk
            .iter()
            .position(|b| *b == b'\n')
            .map(|n| n + 1)
            .unwrap_or(chunk.len());
        if bytes.len() + size > 16 * 1024 * 1024 {
            bail!("OCR NDJSON 单行超过 16 MiB");
        }
        let complete = chunk[size - 1] == b'\n';
        bytes.extend_from_slice(&chunk[..size]);
        reader.consume(size);
        if complete {
            return Ok(Some(String::from_utf8_lossy(&bytes).into_owned()));
        }
    }
}
async fn run_process<F: FnMut(&str) -> Result<()>>(
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    env: Option<&HashMap<String, String>>,
    cancel: &AtomicBool,
    mut line: F,
) -> Result<ProcessResult> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    if let Some(env) = env {
        command.envs(env);
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let mut child = command.spawn().context("无法启动 OCR 进程")?;
    let tree = ProcessTree::attach(&child)?;
    let stdout = child.stdout.take().context("OCR stdout 不可用")?;
    let stderr = child.stderr.take().context("OCR stderr 不可用")?;
    let stderr_task = tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut tail = VecDeque::new();
        while let Ok(Some(line)) = bounded_line(&mut reader).await {
            tail.push_back(line);
            while tail.len() > 40 {
                tail.pop_front();
            }
        }
        tail.into_iter().collect::<Vec<_>>().join("")
    });
    let mut reader = BufReader::new(stdout);
    let mut pages = 0;
    let mut fatal = None;
    let mut probe = None;
    let (cancelled, read_result) = {
        let read = async {
            while let Some(raw) = bounded_line(&mut reader).await? {
                if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                    match text(&value, "kind") {
                        "page" => {
                            if value["file"].is_string() {
                                pages += 1;
                            }
                        }
                        "fatal" => {
                            fatal = Some(value["error"].as_str().unwrap_or("OCR 引擎报错").into())
                        }
                        "probe" => probe = Some(value),
                        _ => {}
                    }
                }
                line(&raw)?;
            }
            Ok::<(), anyhow::Error>(())
        };
        tokio::pin!(read);
        let mut cancelled = false;
        let result = loop {
            tokio::select! {value=&mut read=>break value,_=tokio::time::sleep(Duration::from_millis(100))=>{if cancel.load(Ordering::SeqCst){cancelled=true;break Ok(());}}}
        };
        (cancelled, result)
    };
    let code = if cancelled || read_result.is_err() {
        drop(tree);
        let _ = child.kill().await;
        child.wait().await?.code()
    } else {
        let code = loop {
            tokio::select! {status=child.wait()=>break status?.code(),_=tokio::time::sleep(Duration::from_millis(100))=>{if cancel.load(Ordering::SeqCst){let _=child.kill().await;break child.wait().await?.code();}}}
        };
        drop(tree);
        code
    };
    let mut stderr_task = stderr_task;
    let stderr = match tokio::time::timeout(Duration::from_secs(3), &mut stderr_task).await {
        Ok(Ok(value)) => value,
        _ => {
            stderr_task.abort();
            String::new()
        }
    };
    read_result?;
    Ok(ProcessResult {
        code,
        pages,
        fatal,
        probe,
        stderr,
    })
}
#[cfg(windows)]
struct ProcessTree(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl ProcessTree {
    fn attach(child: &tokio::process::Child) -> Result<Self> {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::{JobObjects::*, Threading::*},
        };
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
            {
                CloseHandle(job);
                return Err(std::io::Error::last_os_error().into());
            }
            let process = OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE,
                0,
                child.id().context("进程 ID 不可用")?,
            );
            if process.is_null() {
                CloseHandle(job);
                return Err(std::io::Error::last_os_error().into());
            }
            let assigned = AssignProcessToJobObject(job, process);
            CloseHandle(process);
            if assigned == 0 {
                CloseHandle(job);
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(Self(job))
        }
    }
}
#[cfg(windows)]
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
unsafe impl Sync for ProcessTree {}
#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn ndjson_handles_small_buffers_utf8_and_unterminated_tail() {
        let source =
            "{\"kind\":\"page\",\"file\":\"猫.png\"}\r\n{\"kind\":\"fatal\",\"error\":\"末尾\"}";
        let mut reader = BufReader::with_capacity(2, source.as_bytes());
        assert_eq!(
            bounded_line(&mut reader).await.unwrap().unwrap(),
            source.split_inclusive('\n').next().unwrap()
        );
        assert!(bounded_line(&mut reader)
            .await
            .unwrap()
            .unwrap()
            .contains("末尾"));
        assert!(bounded_line(&mut reader).await.unwrap().is_none());
        assert!(check_process(&ProcessResult {
            code: Some(0),
            pages: 1,
            fatal: Some("fatal".into()),
            probe: None,
            stderr: String::new()
        })
        .is_err());
    }
    #[test]
    fn layer_identity_and_source_conflict() {
        #[cfg(windows)]
        {
            assert_eq!(
                process_path(Path::new(r"\\?\C:\book\猫.png")),
                r"C:\book\猫.png"
            );
            assert_eq!(
                process_path(Path::new(r"\\?\UNC\server\book\猫.png")),
                r"\\server\book\猫.png"
            );
        }
        let book = json!({"pages":[{"url":"a.png","width":10,"height":20}],"direction":"rtl"});
        let layer = json!({"pages":[{"url":"a.png","width":10,"height":20,"blocks":[{"box":[1,2,3,4],"lines":["猫"]}]}]});
        validate_layer(&book, &layer).unwrap();
        let mut changed = layer.clone();
        changed["pages"][0]["url"] = json!("other.png");
        assert!(validate_layer(&book, &changed).is_err());
        assert_ne!(fingerprint(&book, &layer), fingerprint(&book, &changed));
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn cancellation_kills_owned_runner_and_descendant() {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("runner.ps1");
        let marker = root.path().join("child.txt");
        fs::write(&script,br#"param($Marker)
$child = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30'
[IO.File]::WriteAllText($Marker, [string]$child.Id)
Write-Output '{"kind":"page","file":"fixture.png","ok":true,"lines":[]}'
Start-Sleep -Seconds 30
"#).unwrap();
        let (program, args) = command_for(&script, &[marker.to_string_lossy().into_owned()]);
        let cancel = AtomicBool::new(false);
        let output = tokio::time::timeout(
            Duration::from_secs(15),
            run_process(&program, &args, None, None, &cancel, |line| {
                if line.contains("fixture.png") {
                    cancel.store(true, Ordering::SeqCst);
                }
                Ok(())
            }),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(output.pages, 1);
        let pid = fs::read_to_string(marker).unwrap().parse::<u32>().unwrap();
        use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::*};
        unsafe {
            let child = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if !child.is_null() {
                let mut code = 0;
                assert_ne!(GetExitCodeProcess(child, &mut code), 0);
                CloseHandle(child);
                assert_ne!(code, 259, "owned child still alive");
            }
        }
    }
}
#[cfg(unix)]
struct ProcessTree(i32);
#[cfg(unix)]
impl ProcessTree {
    fn attach(child: &tokio::process::Child) -> Result<Self> {
        Ok(Self(child.id().context("进程 ID 不可用")? as i32))
    }
}
#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-self.0, libc::SIGTERM);
        }
    }
}
