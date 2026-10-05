mod annotations;
mod cards;
mod dictionaries;
mod epub;
mod extensions;
mod importer;
mod ocr;
mod segments;
mod services;
pub mod storage;
mod study;
mod system;
#[cfg(test)]
mod tests;
mod updates;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{fs, sync::Mutex};
use storage::Backend;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

type State = Mutex<Backend>;
struct OpenFiles {
    ready: bool,
    paths: Vec<String>,
}
const PENDING: &str = "Tauri 迁移预览：此后台服务尚未迁移，请暂用 Electron 版本";

fn string(args: &[Value], index: usize) -> Result<&str> {
    args.get(index)
        .and_then(Value::as_str)
        .context("缺少文本参数")
}
fn event(app: &tauri::AppHandle, channel: &str, payload: Value) {
    let _ = app.emit_to(
        "main",
        "arale:event",
        json!({"channel":channel,"payload":payload}),
    );
}

#[tauri::command]
async fn arale_invoke(
    app: tauri::AppHandle,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    if channel == "app:checkUpdate" {
        return updates::check(&updates::build_info(&app))
            .await
            .map_err(|e| format!("{e:#}"));
    }
    if channel == "ocr:capability" {
        return app
            .state::<ocr::Ocr>()
            .capability(&app)
            .await
            .map_err(|e| format!("{e:#}"));
    }
    if channel == "extensions:refresh" || channel == "extensions:install" {
        let service = app.state::<extensions::Extensions>();
        let outcome = if channel == "extensions:refresh" {
            service.refresh(&app).await
        } else {
            service
                .install(&app, args.first().and_then(Value::as_str).unwrap_or(""))
                .await
        };
        return Ok(outcome.unwrap_or_else(|e| json!({"ok":false,"error":format!("{e:#}")})));
    }
    if channel == "service:http" {
        let input = args.first().cloned().unwrap_or(Value::Null);
        let study_owner = input["studyOwner"].as_str();
        let study_scoped = study_owner.is_some();
        let request_id = input["id"].as_str().unwrap_or("").to_owned();
        if let Some(owner) = study_owner {
            app.state::<study::Study>()
                .begin_http(owner, &request_id)
                .map_err(|e| format!("{e:#}"))?;
        }
        let result = app
            .state::<services::Services>()
            .http(input)
            .await
            .map_err(|error| format!("{error:#}"));
        if study_scoped {
            app.state::<study::Study>().finish_http(&request_id);
        }
        return result;
    }
    if channel == "service:cancel" {
        return app
            .state::<services::Services>()
            .cancel(args.first().and_then(Value::as_str).unwrap_or(""))
            .map_err(|error| format!("{error:#}"));
    }
    tauri::async_runtime::spawn_blocking(move || dispatch(&app, &channel, &args))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("{error:#}"))
}

fn dispatch(app: &tauri::AppHandle, channel: &str, args: &[Value]) -> Result<Value> {
    if channel == "app:buildInfo" {
        return Ok(serde_json::to_value(updates::build_info(app))?);
    }
    if channel == "app:openRelease" {
        updates::open_release(args.first().and_then(Value::as_str))?;
        return Ok(Value::Null);
    }
    if channel.starts_with("study:") {
        return app.state::<study::Study>().dispatch(app, channel, args);
    }
    if channel.starts_with("ocr:") {
        let service = app.state::<ocr::Ocr>();
        return match channel {
            "ocr:status" => Ok(service.status(string(args, 0)?)),
            "ocr:queue" => Ok(service.queue_state()),
            "ocr:start" => {
                service.start(app, string(args, 0)?, args.get(1).unwrap_or(&Value::Null))
            }
            "ocr:cancel" => Ok(service.cancel(app, string(args, 0)?)),
            "ocr:selectProvider" => {
                service.select(app, string(args, 0)?)?;
                Ok(Value::Null)
            }
            "ocr:pending" => Ok(service.pending()),
            "ocr:commit" => {
                service.commit(app, string(args, 0)?, args.get(1).context("缺少文字层")?)
            }
            _ => bail!("未知 OCR 调用"),
        };
    }
    if channel.starts_with("extensions:") {
        let service = app.state::<extensions::Extensions>();
        if channel == "extensions:list" {
            return service.list();
        }
        let outcome = match channel {
            "extensions:cancel" => Ok(service.cancel(string(args, 0)?)),
            "extensions:remove" => service.remove(string(args, 0)?),
            "extensions:repositoryAdd" => {
                service.repository(string(args, 0)?, string(args, 1)?, false)
            }
            "extensions:repositoryRemove" => service.repository("", string(args, 0)?, true),
            _ => bail!("未知扩展调用"),
        };
        if outcome.is_ok() && channel != "extensions:cancel" {
            event(app, "extensions:changed", json!({}));
        }
        return Ok(outcome.unwrap_or_else(|e| json!({"ok":false,"error":format!("{e:#}")})));
    }
    if channel.starts_with("service:") {
        let service = app.state::<services::Services>();
        return match channel {
            "service:load" => service.load(string(args, 0)?),
            "service:save" => service.save(
                string(args, 0)?,
                args.get(1).context("缺少设置")?,
                args.get(2).unwrap_or(&Value::Null),
                string(args, 3)?,
            ),
            "service:secret" => service.secret(
                string(args, 0)?,
                string(args, 1)?,
                args.get(2).unwrap_or(&Value::Null),
                string(args, 3)?,
            ),
            "service:capabilities" => {
                service.capabilities(string(args, 0)?, args.get(1).unwrap_or(&Value::Null))
            }
            _ => bail!("未知服务调用"),
        };
    }
    let state = app.state::<State>();
    if channel == "library:reveal" {
        let target = {
            let backend = state
                .lock()
                .map_err(|_| anyhow::anyhow!("后台存储锁不可用"))?;
            system::reveal_target(&backend, string(args, 0)?)?
        };
        system::reveal(&target)?;
        return Ok(Value::Null);
    }
    if channel == "dict:select" {
        let chosen = app
            .dialog()
            .file()
            .set_title("导入词典（Yomitan / Yomichan 格式 .zip）")
            .add_filter("Yomitan 词典包", &["zip"])
            .blocking_pick_files();
        return chosen
            .map(|files| {
                files
                    .into_iter()
                    .map(|p| p.into_path().map(|p| json!(p.to_string_lossy())))
                    .collect::<Result<Vec<_>, _>>()
                    .map(Value::Array)
            })
            .transpose()
            .map(|v| v.unwrap_or(Value::Null))
            .map_err(Into::into);
    }
    // Native dialogs run before taking the storage lock, so readers/protocol requests remain available.
    let selected = if channel == "library:importDialog" || channel == "library:select" {
        let dialog = app
            .dialog()
            .file()
            .set_title("导入 EPUB / 漫画 / 图片（Tauri 迁移预览）");
        let chosen = if args.first().is_some_and(|v| v == "directory") {
            dialog.blocking_pick_folder().map(|p| vec![p])
        } else {
            dialog
                .add_filter(
                    "书籍和图片",
                    &[
                        "cbz", "zip", "cbr", "rar", "cb7", "7z", "cbt", "tar", "png", "jpg",
                        "jpeg", "webp", "gif", "bmp", "mokuro", "json", "epub",
                    ],
                )
                .blocking_pick_files()
        };
        Some(
            chosen
                .unwrap_or_default()
                .into_iter()
                .map(|p| p.into_path().map(|p| json!(p.to_string_lossy())))
                .collect::<Result<Vec<_>, _>>()?,
        )
    } else {
        None
    };
    let mut backend = state
        .lock()
        .map_err(|_| anyhow::anyhow!("后台存储锁不可用"))?;
    let first = args.first().unwrap_or(&Value::Null);
    if ["segment:commit", "segment:clear", "library:updateMeta"].contains(&channel)
        && app.state::<study::Study>().busy(string(args, 0)?)
    {
        bail!("书籍正在制卡，请稍后修改原文或分词");
    }
    match channel {
        "library:info" => Ok(
            json!({"dir":backend.root.join("library").to_string_lossy(),"bookCount":backend.books.len(),
            "comicCount":backend.books.iter().filter(|b| b["format"] == "comic").count(),"epubCount":backend.books.iter().filter(|b| b["format"] == "epub").count()}),
        ),
        "library:list" => Ok(backend.list(first)),
        "library:select" => Ok(json!(selected.unwrap_or_default())),
        "library:import" | "library:importDialog" => {
            let paths =
                importer::paths(&selected.map(Value::Array).unwrap_or_else(|| first.clone()))?;
            let mut results = vec![];
            for path in paths {
                let result = match importer::import(&mut backend, &path) {
                    Ok(book) => {
                        json!({"ok":true,"source":path.to_string_lossy(),"bookId":book["id"],"format":book["format"],"error":null})
                    }
                    Err(error) => {
                        json!({"ok":false,"source":path.to_string_lossy(),"bookId":null,"format":null,"error":format!("{error:#}")})
                    }
                };
                results.push(result);
            }
            event(app, "library:changed", json!({"reason":"import"}));
            Ok(json!(results))
        }
        "library:open" => {
            let id = string(args, 0)?;
            let book = backend.book(id)?;
            if book["format"] != "comic" && book["format"] != "epub" {
                bail!("不支持此书籍格式");
            }
            let book = backend.update(id, &json!({"lastOpenedAt":storage::now()}))?;
            let positions = storage::read(&backend.root.join("positions.json"), json!({}))?;
            Ok(json!({"book":book,"position":positions[id]}))
        }
        "library:savePosition" => {
            let id = first["bookId"].as_str().context("阅读进度缺少书 ID")?;
            backend.book(id)?;
            let mut position = json!({"bookId":id,"updatedAt":storage::now()});
            for key in ["pageIndex", "spineIndex", "charOffset"] {
                if let Some(number) = first[key].as_u64() {
                    position[key] = json!(number);
                }
            }
            if let Some(href) = first["spineHref"].as_str() {
                position["spineHref"] = json!(href);
            }
            let path = backend.root.join("positions.json");
            let mut positions = storage::read(&path, json!({}))?;
            positions
                .as_object_mut()
                .context("阅读进度格式错误，原文件已保留")?
                .insert(id.into(), position);
            storage::write(&path, &positions)?;
            Ok(Value::Null)
        }
        "library:updateMeta" => {
            let result = backend.update(string(args, 0)?, args.get(1).context("缺少修改内容")?)?;
            event(app, "library:changed", json!({"reason":"update"}));
            Ok(result)
        }
        "library:remove" => {
            let ids: Vec<_> = first
                .as_array()
                .context("书 ID 必须为数组")?
                .iter()
                .map(|id| id.as_str().context("书 ID 必须为文本"))
                .collect::<Result<_>>()?;
            for id in &ids {
                backend.book(id)?;
                if app.state::<study::Study>().busy(id) {
                    bail!("书籍正在制卡，请先取消或等待完成");
                }
                if app.state::<ocr::Ocr>().is_running(id) {
                    bail!("书籍正在 OCR 队列中，请先取消或等待识别结束");
                }
            }
            let next: Vec<_> = backend
                .books
                .iter()
                .filter(|b| !ids.contains(&b["id"].as_str().unwrap_or("")))
                .cloned()
                .collect();
            let root = backend.root.join("library").canonicalize()?;
            let targets: Vec<_> = ids
                .iter()
                .map(|id| {
                    let dir = backend.dir(id)?.canonicalize()?;
                    if !dir.starts_with(&root) || dir == root {
                        bail!("拒绝移除越界的书目录");
                    }
                    Ok(dir)
                })
                .collect::<Result<_>>()?;
            backend.persist_books(&next)?;
            backend.books = next;
            let position_file = backend.root.join("positions.json");
            let mut positions = storage::read(&position_file, json!({}))?;
            if let Some(map) = positions.as_object_mut() {
                for id in &ids {
                    map.remove(*id);
                }
                storage::write(&position_file, &positions)?;
            }
            for target in targets {
                fs::remove_dir_all(target)?;
            }
            event(app, "library:changed", json!({"reason":"remove"}));
            Ok(Value::Null)
        }
        "comic:pageText" => page_text(
            &backend,
            string(args, 0)?,
            args.get(1).and_then(Value::as_u64).unwrap_or(0) as usize,
        ),
        "epub:stage" => epub::stage(&backend, std::path::Path::new(string(args, 0)?)),
        "epub:text" => epub::staged_text(&backend, string(args, 0)?, string(args, 1)?),
        "book:chapter" => epub::chapter(
            &backend,
            string(args, 0)?,
            args.get(1).and_then(Value::as_u64).unwrap_or(0) as usize,
        ),
        "epub:discard" => {
            epub::discard(&backend, string(args, 0)?)?;
            Ok(Value::Null)
        }
        "epub:commit" => {
            let book = epub::commit(
                &mut backend,
                string(args, 0)?,
                args.get(1).context("缺少 EPUB 数据")?,
            )?;
            event(app, "library:changed", json!({"reason":"import"}));
            Ok(book)
        }
        "annotations:read" => annotations::read(&backend, string(args, 0)?),
        "annotations:write" => annotations::write(
            &backend,
            string(args, 0)?,
            args.get(1).context("缺少批注内容")?.clone(),
        ),
        "cards:list" => Ok(json!(cards::list(&backend, string(args, 0)?)?)),
        "cards:add" | "cards:update" | "cards:remove" => {
            let id = string(args, 0)?;
            let result = cards::mutate(&backend, id, channel, args)?;
            event(app, "cards:changed", json!({"bookId":id}));
            Ok(result)
        }
        "defaults:read" => {
            let raw = storage::read(&backend.root.join("settings.json"), json!({}))?;
            Ok(json!({"direction":if raw["direction"] == "ltr" {"ltr"} else {"rtl"}}))
        }
        "defaults:write" => {
            let path = backend.root.join("settings.json");
            let mut raw = storage::read(&path, json!({}))?;
            if first["direction"] != "ltr" && first["direction"] != "rtl" {
                bail!("无效的阅读方向");
            }
            raw["direction"] = first["direction"].clone();
            storage::write(&path, &raw)?;
            Ok(json!({"direction":raw["direction"]}))
        }
        "window:setImmersive" => {
            let enabled = first.as_bool().context("全屏参数必须是布尔值")?;
            let system_bars_visible = args.get(1).and_then(Value::as_bool).unwrap_or(false);
            system::set_immersive(app, enabled, system_bars_visible)?;
            Ok(json!(enabled))
        }

        "dict:status" => dictionaries::status(&backend),
        "dict:stage" => dictionaries::stage(&backend, std::path::Path::new(string(args, 0)?)),
        "dict:rawBank" => dictionaries::raw_bank(&backend, string(args, 0)?, string(args, 1)?),
        "dict:commit" => dictionaries::commit(
            &backend,
            string(args, 0)?,
            string(args, 1)?,
            string(args, 2)?,
        ),
        "dict:discard" => {
            dictionaries::discard(&backend, string(args, 0)?)?;
            Ok(Value::Null)
        }
        "dict:data" => dictionaries::data(&backend, string(args, 0)?),
        "dict:remove" => dictionaries::remove(&backend, string(args, 0)?),
        "dict:setEnabled" => dictionaries::enabled(
            &backend,
            string(args, 0)?,
            args.get(1)
                .and_then(Value::as_bool)
                .context("启用参数必须是布尔值")?,
        ),
        "segment:read" => segments::read(&backend, string(args, 0)?),
        "segment:input" => segments::input(&backend, string(args, 0)?),
        "segment:commit" => segments::commit(
            &backend,
            string(args, 0)?,
            string(args, 1)?,
            string(args, 2)?,
        ),
        "segment:clear" => segments::clear(&backend, string(args, 0)?),
        _ => bail!("{PENDING}（{channel}）"),
    }
}

pub fn page_text(backend: &Backend, id: &str, index: usize) -> Result<Value> {
    let book = backend.book(id)?;
    let raw = storage::read(
        &backend.dir(id)?.join("content/manga.json"),
        json!({"pages":[]}),
    )?;
    page_text_from_raw(book, index, &raw)
}
pub fn page_text_from_raw(book: &Value, index: usize, raw: &Value) -> Result<Value> {
    let pages = book["pages"].as_array().context("这本书没有图片")?;
    let page = pages
        .get(index.min(pages.len().saturating_sub(1)))
        .context("这本书没有图片")?;
    let found = raw["pages"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["url"] == page["url"] || p["img_path"] == page["url"]);
    let blocks: Vec<_> = found.into_iter().flat_map(|p| p["blocks"].as_array().into_iter().flatten()).map(|block| {
        let mut result = json!({"box":block["box"],"vertical":block["vertical"].as_bool().unwrap_or(true),
            "fontSize":block["font_size"].as_f64().or_else(|| block["fontSize"].as_f64()).unwrap_or(16.),"lines":block["lines"].as_array().cloned().unwrap_or_default()});
        if block["single_line"] == true || block["singleLine"] == true { result["singleLine"] = json!(true); }
        if let Some(regions) = block["regions"].as_array() { result["regions"] = json!(regions.iter().map(|r| json!({"box":r["box"],"utf16Start":r["utf16_start"].as_u64().or_else(||r["utf16Start"].as_u64()).unwrap_or(0),"utf16End":r["utf16_end"].as_u64().or_else(||r["utf16End"].as_u64()).unwrap_or(0)})).collect::<Vec<_>>()); }
        result
    }).collect();
    Ok(json!({"url":page["url"],"blocks":blocks}))
}

#[tauri::command]
fn arale_notify(app: tauri::AppHandle, channel: String) -> Result<(), String> {
    match channel.as_str() {
        "renderer:ready" => {
            let state = app.state::<Mutex<OpenFiles>>();
            let mut pending = state.lock().map_err(|_| "打开文件队列不可用")?;
            pending.ready = true;
            let paths = std::mem::take(&mut pending.paths);
            if !paths.is_empty() {
                event(&app, "shell:openFiles", json!({"paths":paths}));
            }
        }
        "reader:opened" | "reader:closed" => {}
        _ => return Err("未知通知".into()),
    }
    Ok(())
}

#[cfg(debug_assertions)]
fn smoke_enabled() -> bool {
    std::env::var_os("ARALE_TAURI_SMOKE").is_some()
}

#[cfg(debug_assertions)]
#[tauri::command]
fn arale_smoke_fixture(app: tauri::AppHandle, kind: Option<String>) -> Result<Vec<String>, String> {
    if !smoke_enabled() {
        return Err("测试入口未启用".into());
    }
    if let Some(action) = kind.as_deref().and_then(|s| s.strip_prefix("menu:")) {
        // Exercise the installed native handler, never quit or open modal test windows.
        if ![
            "settings",
            "searchLibrary",
            "nextPage",
            "prevPage",
            "zoomIn",
            "zoomReset",
            "toggleSidebar",
            "fullscreen",
            "undo",
            "redo",
        ]
        .contains(&action)
        {
            return Err("不允许的测试菜单操作".into());
        }
        system::menu_action(&app, action).map_err(|e| e.to_string())?;
        return Ok(vec![]);
    }
    if kind.as_deref() == Some("system") {
        let menu = app.menu().ok_or("未安装菜单")?;
        return menu
            .items()
            .map_err(|e| e.to_string())
            .map(|items| items.iter().map(|i| i.id().0.clone()).collect());
    }
    if kind.as_deref() == Some("system-ready") {
        let backend = app.state::<State>();
        let backend = backend.lock().map_err(|_| "存储锁不可用")?;
        storage::write(
            &backend.root.join("system-ready.json"),
            &json!({"ready":true}),
        )
        .map_err(|e| e.to_string())?;
        return Ok(vec![]);
    }
    if kind.as_deref() == Some("system-state") {
        let window = app.get_webview_window("main").ok_or("没有主窗口")?;
        return (|| -> tauri::Result<Vec<String>> {
            Ok(vec![
                window.is_fullscreen()?.to_string(),
                window.is_menu_visible()?.to_string(),
                window.is_decorated()?.to_string(),
                window.is_maximized()?.to_string(),
                serde_json::to_string(&(window.outer_position()?, window.outer_size()?)).unwrap(),
                serde_json::to_string(
                    &window
                        .current_monitor()?
                        .map(|monitor| (*monitor.position(), *monitor.size())),
                )
                .unwrap(),
                #[cfg(windows)]
                system::shell_test_state(&window).unwrap_or_else(|error| error.to_string()),
                serde_json::to_string(&window.inner_size()?).unwrap(),
            ])
        })()
        .map_err(|e| e.to_string());
    }
    if kind.as_deref() == Some("services") {
        return std::env::var("ARALE_TAURI_TEST_SERVER")
            .map(|url| vec![url])
            .map_err(|e| e.to_string());
    }
    if kind.as_deref() == Some("epubs") {
        return Ok(["吾輩は猫である.epub", "画像小説サンプル.epub"]
            .iter()
            .map(|name| {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../samples")
                    .join(name)
                    .to_string_lossy()
                    .into_owned()
            })
            .collect());
    }
    if kind.as_deref() == Some("dictionaries") {
        return Ok([
            "surasura-giseigo.zip",
            "fukugougo-kigen.zip",
            "aozora-jukugo-freq.zip",
        ]
        .iter()
        .map(|name| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../resources/dictionaries")
                .join(name)
                .to_string_lossy()
                .into_owned()
        })
        .collect());
    }
    Ok(vec![std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../samples/サンプル漫画 v01.cbz")
        .to_string_lossy()
        .into_owned()])
}

#[cfg(debug_assertions)]
#[tauri::command]
fn arale_smoke_finish(
    app: tauri::AppHandle,
    results: Vec<Value>,
    evidence: Value,
) -> Result<(), String> {
    if !smoke_enabled() {
        return Err("测试入口未启用".into());
    }
    let state = app.state::<State>();
    let backend = state.lock().map_err(|_| "存储锁不可用")?;
    let ok = !results.is_empty() && results.iter().all(|r| r["ok"] == true);
    storage::write(
        &backend.root.join("smoke-report.json"),
        &json!({"ok":ok,"results":results,"evidence":evidence,"dictionaryId":dictionaries::list(&backend).map_err(|e| e.to_string())?.into_iter().find(|d| d["title"] == "Smoke 词典").map(|d| d["id"].clone())}),
    )
    .map_err(|e| e.to_string())?;
    app.exit(if ok { 0 } else { 1 });
    Ok(())
}

fn protocol(
    app: &tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let read = || -> Result<(Vec<u8>, String)> {
        let path = percent_encoding::percent_decode_str(request.uri().path())
            .decode_utf8()?
            .trim_start_matches('/')
            .to_owned();
        let (id, relative) = path.split_once('/').context("无效资源地址")?;
        let state = app.state::<State>();
        let backend = state.lock().map_err(|_| anyhow::anyhow!("存储不可用"))?;
        backend.book(id)?;
        let target = storage::inside(&backend.dir(id)?.join("content"), relative)?;
        // This endpoint remains passive images only. EPUB documents use an isolated scheme.
        if !arale_native::pages::is_comic_image(relative)
            && !(backend.book(id)?["format"] == "epub" && relative.to_lowercase().ends_with(".svg"))
        {
            bail!("目前仅允许图片资源");
        }
        let mime = mime_guess::from_path(&target)
            .first_or_octet_stream()
            .to_string();
        Ok((fs::read(target)?, mime))
    };
    match read() {
        Ok((bytes, mime)) => tauri::http::Response::builder()
            .header("Content-Type", mime)
            .header("Access-Control-Allow-Origin", "*")
            .header("X-Content-Type-Options", "nosniff")
            .header("Cache-Control", "no-cache")
            .header(
                "Content-Security-Policy",
                "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'",
            )
            .body(bytes)
            .unwrap(),
        Err(_) => tauri::http::Response::builder()
            .status(403)
            .body(b"Resource unavailable".to_vec())
            .unwrap(),
    }
}

fn book_protocol(
    app: &tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let read = || -> Result<(Vec<u8>, String)> {
        let path = percent_encoding::percent_decode_str(request.uri().path())
            .decode_utf8()?
            .trim_start_matches('/')
            .to_owned();
        let (id, relative) = path.split_once('/').context("无效章节地址")?;
        let state = app.state::<State>();
        let backend = state.lock().map_err(|_| anyhow::anyhow!("存储不可用"))?;
        let result = epub::resource(&backend, id, relative);
        #[cfg(debug_assertions)]
        if smoke_enabled() {
            eprintln!(
                "EPUB request {relative}: {}",
                result.as_ref().map(|v| v.1.as_str()).unwrap_or("error")
            );
        }
        result
    };
    match read() {
        Ok((bytes, mime)) => tauri::http::Response::builder()
            .header("Content-Type", mime)
            .header("Access-Control-Allow-Origin", "*")
            .header("Content-Security-Policy", epub::csp())
            .header("X-Content-Type-Options", "nosniff")
            .header("Referrer-Policy", "no-referrer")
            .header("Cache-Control", "no-cache")
            .body(bytes)
            .unwrap(),
        Err(_error) => {
            #[cfg(debug_assertions)]
            if smoke_enabled() {
                eprintln!("EPUB resource error: {_error:#}");
            }
            tauri::http::Response::builder()
                .status(403)
                .body(b"Book resource unavailable".to_vec())
                .unwrap()
        }
    }
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let paths = system::argument_paths(args, std::path::Path::new(&cwd));
            if !paths.is_empty() {
                if let Some(state) = app.try_state::<Mutex<OpenFiles>>() {
                    if let Ok(mut pending) = state.lock() {
                        if pending.ready {
                            event(app, "shell:openFiles", json!({"paths":paths}));
                        } else {
                            pending.paths.extend(paths);
                        }
                    }
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(|app, event| {
            // Predefined editing items are handled by the platform menu implementation.
            let id = event.id().as_ref();
            if ![
                "import",
                "settings",
                "searchLibrary",
                "toggleSidebar",
                "zoomIn",
                "zoomOut",
                "zoomReset",
                "prevPage",
                "nextPage",
                "toggleDictionary",
                "fullscreen",
                "undo",
                "redo",
                "about",
                "quit",
                "devtools",
            ]
            .contains(&id)
            {
                return;
            }
            if let Err(error) = system::menu_action(app, id) {
                eprintln!("菜单操作失败：{error:#}");
            }
        })
        .setup(|app| {
            let root = if cfg!(debug_assertions) {
                std::env::var_os("ARALE_TAURI_USERDATA")
                    .map(std::path::PathBuf::from)
                    .unwrap_or(app.path().app_data_dir()?)
            } else {
                app.path().app_data_dir()?
            };
            let backend = Backend::load(root)?;
            dictionaries::clean_pending(&backend)?;
            epub::clean_pending(&backend)?;
            app.manage(services::Services::new(backend.root.clone())?);
            app.manage(extensions::Extensions::new(
                backend.root.join("extensions"),
            )?);
            app.manage(ocr::Ocr::new(&backend.root, app.handle())?);
            app.manage(study::Study::new(backend.root.clone())?);
            app.manage(Mutex::new(backend));
            app.manage(system::ImmersiveWindow::default());
            app.manage(Mutex::new(OpenFiles {
                ready: false,
                paths: system::argument_paths(std::env::args(), &std::env::current_dir()?),
            }));
            system::install(app.handle())?;
            Ok(())
        })
        .register_uri_scheme_protocol("arale", |context, request| {
            protocol(context.app_handle(), request)
        })
        .register_uri_scheme_protocol("arale-book", |context, request| {
            book_protocol(context.app_handle(), request)
        })
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                if let Some(state) = webview.app_handle().try_state::<Mutex<OpenFiles>>() {
                    if let Ok(mut pending) = state.lock() {
                        pending.ready = false;
                    }
                }
            }
            #[cfg(debug_assertions)]
            if smoke_enabled() && payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = webview.eval(include_str!("../../scripts/tauri-smoke-ocr.js"));
                let _ = webview.eval(include_str!("../../scripts/tauri-smoke-study.js"));
                let _ = webview.eval(include_str!("../../scripts/tauri-smoke-ui.js"));
            }
        });
    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        arale_invoke,
        arale_notify,
        arale_smoke_fixture,
        arale_smoke_finish
    ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![arale_invoke, arale_notify]);
    builder
        .run(tauri::generate_context!())
        .expect("启动 ARaLeBook Tauri 失败");
}
