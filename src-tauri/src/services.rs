//! Credentials and HTTP stay native; shared TypeScript implements provider protocols.
use crate::storage;
use anyhow::{bail, Context, Result};
use reqwest::{header::HeaderMap, Client, Url};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf, sync::Mutex, time::Duration};
use tokio::sync::oneshot;

const MARKER: &str = "__arale_native_credential__";
const BING_ID: &str = "tr_bing_default";
pub struct Services {
    pub root: PathBuf,
    settings_lock: Mutex<()>,
    requests: Mutex<HashMap<String, oneshot::Sender<()>>>,
    early_cancels: Mutex<HashMap<String, u64>>,
    llm_slots: tokio::sync::Semaphore,
    client: Client,
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn hash(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}
fn check_kind(kind: &str) -> Result<()> {
    if !matches!(kind, "llm" | "translation") {
        bail!("未知服务类型");
    }
    Ok(())
}
fn credential(kind: &str) -> &str {
    if kind == "llm" {
        "apiKey"
    } else {
        "secret"
    }
}
fn builtin() -> Value {
    json!({"id":BING_ID,"name":"Bing 网页翻译","provider":"bing","baseUrl":"","region":"","appId":"","secret":""})
}

impl Services {
    pub fn new(root: PathBuf) -> Result<Self> {
        // Never redirect a credential-bearing request to another origin. Bing page redirects
        // may select a regional Bing host; its requests have no user credentials.
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                let previous = attempt.previous().last();
                let safe = previous.is_some_and(|url| {
                    url.origin() == attempt.url().origin()
                        || (bing_url(url) && bing_url(attempt.url()))
                });
                if attempt.previous().len() < 5 && safe {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()?;
        Ok(Self {
            root,
            settings_lock: Mutex::new(()),
            requests: Mutex::new(HashMap::new()),
            early_cancels: Mutex::new(HashMap::new()),
            llm_slots: tokio::sync::Semaphore::new(4),
            client,
        })
    }
    fn stored(&self, kind: &str) -> Result<Value> {
        check_kind(kind)?;
        let default = if kind == "llm" {
            json!({"profiles":[],"activeProfileId":null,"prompt":""})
        } else {
            json!({"profiles":[],"activeProfileId":BING_ID,"targetLanguage":"zh-Hans"})
        };
        let mut stored = storage::read(&self.root.join(format!("{kind}.json")), default)?;
        let profiles = stored["profiles"]
            .as_array_mut()
            .context("服务配置格式错误，原文件已保留")?;
        if kind == "translation" {
            profiles.retain(|p| text(p, "id") != BING_ID);
            profiles.insert(0, builtin());
        }
        Ok(stored)
    }
    pub fn load(&self, kind: &str) -> Result<Value> {
        let _guard = self
            .settings_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("服务配置锁不可用"))?;
        let mut settings = self.stored(kind)?;
        let revision = hash(&settings);
        let mut signatures = serde_json::Map::new();
        for profile in settings["profiles"]
            .as_array_mut()
            .context("缺少配置列表")?
        {
            signatures.insert(text(profile, "id").into(), json!(hash(profile)));
            let key = credential(kind);
            profile[key] = json!(if text(profile, key).is_empty() {
                ""
            } else {
                MARKER
            });
        }
        let capabilities = if kind == "llm" {
            storage::read(&self.root.join("llm-output-capabilities.json"), json!({}))?
        } else {
            Value::Null
        };
        Ok(
            json!({"settings":settings,"revision":revision,"signatures":signatures,"capabilities":capabilities}),
        )
    }
    pub fn save(
        &self,
        kind: &str,
        incoming: &Value,
        credentials: &Value,
        revision: &str,
    ) -> Result<Value> {
        let _guard = self
            .settings_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("服务配置锁不可用"))?;
        let stored = self.stored(kind)?;
        if hash(&stored) != revision {
            bail!("服务配置已变化，请重新打开设置后保存");
        }
        let mut next = incoming.clone();
        if next.to_string().len() > 2 * 1024 * 1024 {
            bail!("服务配置过大");
        }
        let profiles = next["profiles"].as_array_mut().context("缺少配置列表")?;
        if profiles.len() > 100 {
            bail!("最多保存 100 个服务配置");
        }
        let mut seen = std::collections::HashSet::new();
        for profile in profiles.iter_mut() {
            let id = text(profile, "id").to_owned();
            if id.is_empty() || id.len() > 200 || !seen.insert(id.clone()) {
                bail!("服务配置 ID 无效或重复");
            }
            let old = stored["profiles"]
                .as_array()
                .and_then(|p| p.iter().find(|p| text(p, "id") == id));
            if let Some(old) = old {
                profile["name"] = old["name"].clone();
                if kind == "translation" {
                    profile["provider"] = old["provider"].clone();
                }
            }
            let key = credential(kind);
            profile[key] = if kind == "llm" && credentials.get(&id).is_some() {
                json!(credentials[&id].as_str().unwrap_or("").trim())
            } else {
                json!(old.map(|p| text(p, key)).unwrap_or(""))
            };
        }
        if kind == "translation" {
            profiles.retain(|p| text(p, "id") != BING_ID);
            profiles.insert(0, builtin());
        }
        storage::write(&self.root.join(format!("{kind}.json")), &next)?;
        if kind == "llm" {
            storage::write(&self.root.join("llm-output-capabilities.json"), &json!({}))?;
        }
        Ok(Value::Null)
    }
    pub fn secret(&self, kind: &str, id: &str, value: &Value, revision: &str) -> Result<Value> {
        let _guard = self
            .settings_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("服务配置锁不可用"))?;
        let mut stored = self.stored(kind)?;
        if hash(&stored) != revision {
            bail!("服务配置已变化，请重新打开设置后保存");
        }
        if kind == "translation" && id == BING_ID {
            return Ok(Value::Null);
        }
        if let Some(profile) = stored["profiles"]
            .as_array_mut()
            .and_then(|p| p.iter_mut().find(|p| text(p, "id") == id))
        {
            profile[credential(kind)] = json!(value.as_str().unwrap_or("").trim());
            storage::write(&self.root.join(format!("{kind}.json")), &stored)?;
        }
        Ok(Value::Null)
    }
    pub fn capabilities(&self, revision: &str, records: &Value) -> Result<Value> {
        let _guard = self
            .settings_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("服务配置锁不可用"))?;
        if hash(&self.stored("llm")?) != revision {
            return Ok(Value::Null);
        }
        let map = records.as_object().context("能力缓存格式错误")?;
        if map.len() > 100
            || map.iter().any(|(key, v)| {
                key.len() != 64
                    || !key.bytes().all(|b| b.is_ascii_hexdigit())
                    || !matches!(
                        text(v, "mode"),
                        "tool" | "plain" | "json_object" | "json_schema"
                    )
                    || !v["checkedAt"].is_number()
            })
        {
            bail!("能力缓存无效");
        }
        storage::write(&self.root.join("llm-output-capabilities.json"), records)?;
        Ok(Value::Null)
    }
    pub fn cancel(&self, id: &str) -> Result<Value> {
        uuid::Uuid::parse_str(id).context("请求 ID 无效")?;
        if let Some(cancel) = self.requests.lock().unwrap().remove(id) {
            let _ = cancel.send(());
        } else {
            let mut early = self.early_cancels.lock().unwrap();
            early.retain(|_, at| storage::now().saturating_sub(*at) < 120_000);
            if early.len() < 1000 {
                early.insert(id.into(), storage::now());
            }
        }
        Ok(Value::Null)
    }
    fn prepare(&self, input: &Value) -> Result<Prepared> {
        let _guard = self
            .settings_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("服务配置锁不可用"))?;
        let kind = text(input, "kind");
        let stored = self.stored(kind)?;
        if hash(&stored) != text(input, "revision") {
            bail!("请求期间服务配置已变化，请重新提交");
        }
        let profile = stored["profiles"]
            .as_array()
            .and_then(|p| p.iter().find(|p| p["id"] == input["profileId"]))
            .context("服务配置不存在")?;
        prepare(input, kind, profile)
    }
    pub async fn http(&self, input: Value) -> Result<Value> {
        let id = text(&input, "id").to_owned();
        uuid::Uuid::parse_str(&id).context("请求 ID 无效")?;
        let prepared = self.prepare(&input)?;
        let (tx, rx) = oneshot::channel();
        {
            // Lock order matches cancel, so an abort racing registration cannot be lost.
            let mut requests = self.requests.lock().unwrap();
            if requests.contains_key(&id) || requests.len() >= 64 {
                bail!("请求重复或在途请求过多");
            }
            let mut early = self.early_cancels.lock().unwrap();
            if early.remove(&id).is_some() {
                return Ok(json!({"aborted":true}));
            }
            requests.insert(id.clone(), tx);
        }
        let timeout = if text(&input, "kind") == "llm" {
            120
        } else {
            30
        };
        #[cfg(debug_assertions)]
        let test_url = if std::env::var("ARALE_TAURI_SMOKE").as_deref() == Ok("1")
            && bing_url(&prepared.url)
        {
            std::env::var("ARALE_TAURI_TEST_SERVER")
                .ok()
                .and_then(|value| Url::parse(&value).ok())
                .filter(|url| url.scheme() == "http" && url.host_str() == Some("127.0.0.1"))
                .map(|mut url| {
                    url.set_path(prepared.url.path());
                    url.set_query(prepared.url.query());
                    url
                })
        } else {
            None
        };
        let request_url = prepared.url.clone();
        #[cfg(debug_assertions)]
        let request_url = test_url.clone().unwrap_or(request_url);
        let task = async {
            // Also enforce the limit natively: a renderer reload creates a new Worker while
            // requests submitted by its predecessor may still be finishing.
            let _permit = if text(&input, "kind") == "llm" {
                Some(
                    self.llm_slots
                        .acquire()
                        .await
                        .context("LLM 请求队列已关闭")?,
                )
            } else {
                None
            };
            self.prepare(&input)?; // Settings may have changed while waiting for a native slot.
            let mut response = self
                .client
                .request(prepared.method, request_url)
                .headers(prepared.headers)
                .body(prepared.body)
                .timeout(Duration::from_secs(timeout))
                .send()
                .await
                .map_err(|e| e.without_url())?;
            let status = response.status().as_u16();
            let mut url = response.url().clone();
            #[cfg(debug_assertions)]
            if test_url.is_some() {
                url = prepared.url.clone();
            }
            if url.query().is_some() {
                let pairs: Vec<_> = url
                    .query_pairs()
                    .filter(|(k, _)| k != "key")
                    .map(|(k, v)| (k.into_owned(), v.into_owned()))
                    .collect();
                url.set_query(None);
                url.query_pairs_mut().extend_pairs(pairs);
            }
            let mut headers = serde_json::Map::new();
            for key in ["content-type", "isgenderdebiasedtranslation"] {
                if let Some(value) = response.headers().get(key).and_then(|v| v.to_str().ok()) {
                    headers.insert(key.into(), json!(value));
                }
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|e| e.without_url())? {
                if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
                    bail!("服务响应超过 8 MiB");
                }
                bytes.extend_from_slice(&chunk);
            }
            // Providers may echo a submitted credential in an error response. Never forward it.
            let mut body = String::from_utf8_lossy(&bytes).into_owned();
            if !prepared.secret.is_empty() {
                body = body.replace(&prepared.secret, "[redacted]");
            }
            Ok(json!({"status":status,"headers":headers,"url":url.to_string(),"body":body}))
        };
        let result =
            tokio::select! { result = task => result, _ = rx => Ok(json!({"aborted":true})) };
        self.requests.lock().unwrap().remove(&id);
        if result
            .as_ref()
            .err()
            .and_then(|error| error.downcast_ref::<reqwest::Error>())
            .is_some_and(|error| error.is_timeout())
        {
            Ok(json!({"aborted":true}))
        } else {
            result
        }
    }
}

struct Prepared {
    url: Url,
    method: reqwest::Method,
    headers: HeaderMap,
    body: String,
    secret: String,
}
fn bing_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|h| {
            h == "bing.com"
                || h.strip_suffix(".bing.com").is_some_and(|s| {
                    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                })
        })
}
fn prepare(input: &Value, kind: &str, profile: &Value) -> Result<Prepared> {
    let mut url = Url::parse(text(input, "url")).context("服务地址无效")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        bail!("服务地址必须为 HTTP(S) 且不能含登录信息");
    }
    let provider = if kind == "llm" {
        "llm"
    } else {
        text(profile, "provider")
    };
    let suffix = match provider {
        "llm" => "/chat/completions",
        "microsoft" | "libretranslate" => "/translate",
        "deepl" => "/v2/translate",
        "google" => "/language/translate/v2",
        "baidu" => "/api/trans/vip/translate",
        "bing" => "",
        _ => {
            bail!("未知翻译提供商");
        }
    };
    let method = text(input, "method");
    if provider == "bing" {
        if !bing_url(&url)
            || !((url.path() == "/translator" && method == "GET")
                || (url.path() == "/ttranslatev3" && method == "POST"))
        {
            bail!("拒绝非 Bing 翻译地址");
        }
    } else {
        let default = match provider {
            "microsoft" => "https://api.cognitive.microsofttranslator.com",
            "deepl" => "https://api-free.deepl.com",
            "google" => "https://translation.googleapis.com",
            "baidu" => "https://fanyi-api.baidu.com",
            "libretranslate" => "http://127.0.0.1:5000",
            _ => "",
        };
        let base = if text(profile, "baseUrl").is_empty() {
            default
        } else {
            text(profile, "baseUrl")
        };
        let expected = Url::parse(&format!("{}{suffix}", base.trim_end_matches('/')))
            .context("配置地址无效")?;
        if url.origin() != expected.origin() || url.path() != expected.path() || method != "POST" {
            bail!("请求地址与服务配置不符，拒绝发送密钥");
        }
    }
    let secret = text(profile, credential(kind)).to_owned();
    let mut headers = HeaderMap::new();
    for key in [
        "content-type",
        "user-agent",
        "referer",
        "ocp-apim-subscription-region",
    ] {
        if let Some(value) = input["headers"][key].as_str() {
            headers.insert(
                reqwest::header::HeaderName::from_bytes(key.as_bytes())?,
                value.parse()?,
            );
        }
    }
    let mut body = text(input, "body").to_owned();
    if body.len() > 8 * 1024 * 1024 {
        bail!("请求正文过大");
    }
    match provider {
        "llm" if !secret.is_empty() => {
            headers.insert("authorization", format!("Bearer {secret}").parse()?);
        }
        "deepl" => {
            headers.insert("authorization", format!("DeepL-Auth-Key {secret}").parse()?);
        }
        "microsoft" => {
            headers.insert("ocp-apim-subscription-key", secret.parse()?);
        }
        "google" => {
            let pairs: Vec<_> = url
                .query_pairs()
                .filter(|(k, _)| k != "key")
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            url.set_query(None);
            url.query_pairs_mut()
                .extend_pairs(pairs)
                .append_pair("key", &secret);
        }
        "libretranslate" => {
            let mut data: Value = serde_json::from_str(&body)?;
            if secret.is_empty() {
                data.as_object_mut()
                    .context("翻译正文必须为对象")?
                    .remove("api_key");
            } else {
                data["api_key"] = json!(secret);
            }
            body = data.to_string();
        }
        "baidu" => {
            let mut params: HashMap<String, String> =
                reqwest::Url::parse(&format!("http://localhost/?{body}"))?
                    .query_pairs()
                    .map(|(k, v)| (k.into_owned(), v.into_owned()))
                    .collect();
            let sign = format!(
                "{:x}",
                md5::compute(format!(
                    "{}{}{}{}",
                    text(profile, "appId"),
                    params.get("q").context("缺少百度原文")?,
                    params.get("salt").context("缺少百度 salt")?,
                    secret
                ))
            );
            params.insert("appid".into(), text(profile, "appId").into());
            params.insert("sign".into(), sign);
            let mut form = Url::parse("http://localhost/")?;
            form.query_pairs_mut().extend_pairs(params);
            body = form.query().unwrap_or("").into();
        }
        _ => {}
    }
    Ok(Prepared {
        url,
        method: method.parse()?,
        headers,
        body,
        secret,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn settings_keep_credentials_native_and_preserve_identity() {
        let root = tempfile::tempdir().unwrap();
        let service = Services::new(root.path().into()).unwrap();
        let initial = service.load("llm").unwrap();
        let settings = json!({"profiles":[{"id":"one","name":"original","baseUrl":"http://localhost:1234/v1","model":"test","temperature":0.3}],"activeProfileId":"one","prompt":"custom {{word}}"});
        service
            .save(
                "llm",
                &settings,
                &json!({"one":"private-key"}),
                text(&initial, "revision"),
            )
            .unwrap();
        let loaded = service.load("llm").unwrap();
        assert!(!loaded.to_string().contains("private-key"));
        assert_eq!(loaded["settings"]["profiles"][0]["apiKey"], MARKER);
        let mut edited = settings.clone();
        edited["profiles"][0]["name"] = json!("renamed");
        service
            .save("llm", &edited, &json!({}), text(&loaded, "revision"))
            .unwrap();
        let disk = service.stored("llm").unwrap();
        assert_eq!(disk["profiles"][0]["name"], "original");
        assert_eq!(disk["profiles"][0]["apiKey"], "private-key");
        assert!(service
            .save("llm", &settings, &json!({}), text(&initial, "revision"))
            .is_err());
        let current = service.load("llm").unwrap();
        service
            .secret("llm", "one", &Value::Null, text(&current, "revision"))
            .unwrap();
        assert_eq!(
            service.load("llm").unwrap()["settings"]["profiles"][0]["apiKey"],
            ""
        );
        assert_eq!(
            service.load("translation").unwrap()["settings"]["profiles"][0]["id"],
            BING_ID
        );
        std::fs::write(root.path().join("llm.json"), "broken").unwrap();
        assert!(service.load("llm").is_err());
        assert_eq!(
            std::fs::read_to_string(root.path().join("llm.json")).unwrap(),
            "broken"
        );
    }

    #[test]
    fn http_only_injects_credentials_for_configured_endpoints() {
        let profile =
            json!({"id":"one","baseUrl":"https://gateway.example/v1","apiKey":"secret-value"});
        let input = json!({"url":"https://gateway.example/v1/chat/completions","method":"POST","headers":{"content-type":"application/json","authorization":"Bearer fake"},"body":"{}"});
        let request = prepare(&input, "llm", &profile).unwrap();
        assert_eq!(request.headers["authorization"], "Bearer secret-value");
        for url in [
            "https://other.example/v1/chat/completions",
            "file:///secret",
            "https://user@gateway.example/v1/chat/completions",
            "https://gateway.example/v1/other",
        ] {
            let mut changed = input.clone();
            changed["url"] = json!(url);
            assert!(prepare(&changed, "llm", &profile).is_err());
        }
        let baidu = json!({"provider":"baidu","baseUrl":"http://localhost:1234","appId":"123","secret":"real-key"});
        let request = prepare(&json!({"url":"http://localhost:1234/api/trans/vip/translate","method":"POST","body":"q=%E7%8C%AB&salt=abc&sign=fake&appid=fake"}),"translation",&baidu).unwrap();
        assert!(request
            .body
            .contains(&format!("sign={:x}", md5::compute("123猫abcreal-key"))));
        assert!(request.body.contains("appid=123"));
        let google =
            json!({"provider":"google","baseUrl":"http://localhost:1234","secret":"real-key"});
        let request = prepare(&json!({"url":"http://localhost:1234/language/translate/v2?key=fake","method":"POST","body":"{}"}),"translation",&google).unwrap();
        assert_eq!(request.url.query(), Some("key=real-key"));
        assert!(!bing_url(
            &Url::parse("https://bing.com.evil.example/translator").unwrap()
        ));
    }

    #[tokio::test]
    async fn http_redacts_echoed_keys_and_cancels_without_holding_storage() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut buffer = [0; 4096];
            let size = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..size]);
            assert!(request.contains("Bearer private-key"));
            let body = "{\"message\":\"private-key\"}";
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        });
        let root = tempfile::tempdir().unwrap();
        let service = Services::new(root.path().into()).unwrap();
        let first = service.load("llm").unwrap();
        service.save("llm",&json!({"profiles":[{"id":"one","name":"test","baseUrl":format!("http://{address}"),"model":"test","temperature":0.3}],"activeProfileId":"one","prompt":"test"}),&json!({"one":"private-key"}),text(&first,"revision")).unwrap();
        let loaded = service.load("llm").unwrap();
        let mut request = json!({"id":uuid::Uuid::new_v4().to_string(),"kind":"llm","profileId":"one","revision":loaded["revision"],"url":format!("http://{address}/chat/completions"),"method":"POST","body":"{}"});
        let response = service.http(request.clone()).await.unwrap();
        assert!(!response.to_string().contains("private-key"));
        assert!(text(&response, "body").contains("[redacted]"));
        server.join().unwrap();
        request["id"] = json!(uuid::Uuid::new_v4().to_string());
        service.cancel(text(&request, "id")).unwrap();
        assert_eq!(service.http(request).await.unwrap()["aborted"], true);
        assert!(service.load("llm").is_ok());

        // The listening socket intentionally never returns an HTTP response.
        let hanging = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = hanging.local_addr().unwrap();
        let current = service.load("llm").unwrap();
        let mut settings = current["settings"].clone();
        settings["profiles"][0]["baseUrl"] = json!(format!("http://{address}"));
        service
            .save("llm", &settings, &json!({}), text(&current, "revision"))
            .unwrap();
        let current = service.load("llm").unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let request = json!({"id":id,"kind":"llm","profileId":"one","revision":current["revision"],"url":format!("http://{address}/chat/completions"),"method":"POST","body":"{}"});
        let (result, _) = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::join!(service.http(request), async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                assert!(service.load("llm").is_ok());
                assert!(service.requests.lock().unwrap().contains_key(&id));
                service.cancel(&id).unwrap();
            })
        })
        .await
        .expect("native cancellation must finish promptly");
        assert_eq!(result.unwrap()["aborted"], true);
        assert!(service.requests.lock().unwrap().is_empty());
    }
}
