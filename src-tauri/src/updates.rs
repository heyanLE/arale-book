//! Public GitHub release checks. No credentials or library data leave the application.
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

const REPO: &str = "heyanLE/arale-book";
const CHANNEL: &str = env!("ARALE_BUILD_CHANNEL");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    version: String,
    channel: String,
    commit: Option<String>,
    built_at: Option<String>,
    platform: String,
    arch: String,
}

pub fn build_info(app: &tauri::AppHandle) -> BuildInfo {
    let optional = |s: &str| (!s.is_empty()).then(|| s.to_owned());
    BuildInfo {
        version: app.package_info().version.to_string(),
        channel: CHANNEL.into(),
        commit: optional(env!("ARALE_BUILD_COMMIT")),
        built_at: optional(env!("ARALE_BUILD_TIME")),
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
    }
}

fn date_version(version: &str) -> Option<(u32, u32, u32)> {
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|s| s.is_empty() || s.starts_with('0') || !s.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let (y, m, d) = (
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    );
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => return None,
    };
    (y >= 2000 && y <= 9999 && d >= 1 && d <= days).then_some((y, m, d))
}

fn nightly_version(release: &Value) -> Option<&str> {
    if release["draft"] != false || release["prerelease"] != true {
        return None;
    }
    let version = release["tag_name"].as_str()?.strip_prefix("nightly-")?;
    date_version(version)?;
    let assets = release["assets"].as_array()?;
    // A release is usable only after both supported installers are present.
    for suffix in ["windows-x64-setup.exe", "macos-arm64.dmg"] {
        let expected = format!("ARaLeBook_{version}_{suffix}");
        if !assets
            .iter()
            .any(|asset| asset["name"] == expected && asset["size"].as_u64().is_some_and(|n| n > 0))
        {
            return None;
        }
    }
    Some(version)
}

fn select_update(info: &BuildInfo, releases: &[Value]) -> Value {
    let result = |status, version: Option<&str>| json!({"status":status,"version":version,"tag":version.map(|v| format!("nightly-{v}"))});
    if info.channel != "nightly" {
        return result("disabled", None);
    }
    if !((info.platform == "windows" && info.arch == "x86_64")
        || (info.platform == "macos" && info.arch == "aarch64"))
    {
        return result("unsupported", None);
    }
    let latest = releases
        .iter()
        .filter_map(nightly_version)
        .max_by_key(|v| date_version(v));
    match latest {
        None => result("unpublished", None),
        Some(v) if date_version(v) > date_version(&info.version) => result("available", Some(v)),
        Some(v) => result("latest", Some(v)),
    }
}

pub async fn check(info: &BuildInfo) -> Result<Value> {
    let preliminary = select_update(info, &[]);
    if preliminary["status"] != "unpublished" {
        return Ok(preliminary);
    }
    if date_version(&info.version).is_none() {
        bail!("当前 Nightly 版本格式无效");
    }
    let client = reqwest::Client::builder()
        .user_agent(format!("ARaLeBook/{}", info.version))
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .build()?;
    let mut releases = Vec::new();
    // New nightly releases are near the start. Bound requests and response size.
    for page in 1..=3 {
        let mut response = client
            .get(format!(
                "https://api.github.com/repos/{REPO}/releases?per_page=100&page={page}"
            ))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await
            .context("无法连接 GitHub，请检查网络后重试")?;
        match response.status().as_u16() {
            403 | 429 => bail!("GitHub 请求受到限流，请稍后重试"),
            404 => bail!("GitHub 发布仓库不可访问，请检查网络或仓库是否公开"),
            _ => {
                response
                    .error_for_status_ref()
                    .context("GitHub 更新检查失败")?;
            }
        }
        let has_next = response
            .headers()
            .get("link")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("rel=\"next\""));
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                bail!("GitHub 发布列表过大");
            }
            bytes.extend_from_slice(&chunk);
        }
        let batch: Vec<Value> =
            serde_json::from_slice(&bytes).context("GitHub 返回了无效的发布列表")?;
        let done = !has_next;
        releases.extend(batch);
        if done {
            return Ok(select_update(info, &releases));
        }
    }
    // Never report “up to date” if the bounded scan might have missed releases.
    bail!("发布列表过长，无法完整检查；请打开发布页面查看")
}

pub fn open_release(tag: Option<&str>) -> Result<()> {
    let url = match tag {
        None => format!("https://github.com/{REPO}/releases"),
        Some(tag)
            if tag
                .strip_prefix("nightly-")
                .and_then(date_version)
                .is_some() =>
        {
            format!("https://github.com/{REPO}/releases/tag/{tag}")
        }
        _ => bail!("发布标签无效"),
    };
    #[cfg(windows)]
    {
        use std::{os::windows::ffi::OsStrExt, ptr};
        use windows_sys::Win32::System::Com::{
            CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
        };
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        let name: Vec<u16> = std::ffi::OsStr::new(&url)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let initialized = unsafe { CoInitializeEx(ptr::null(), COINIT_APARTMENTTHREADED as u32) };
        if initialized < 0 {
            bail!("无法初始化浏览器打开操作：{initialized:#x}");
        }
        let status = unsafe {
            let result = ShellExecuteW(
                ptr::null_mut(),
                operation.as_ptr(),
                name.as_ptr(),
                ptr::null(),
                ptr::null(),
                1,
            ) as isize;
            CoUninitialize();
            result
        };
        if status <= 32 {
            bail!("无法打开浏览器：系统错误 {status}");
        }
    }
    #[cfg(not(windows))]
    {
        let program = if cfg!(target_os = "macos") {
            "/usr/bin/open"
        } else {
            "xdg-open"
        };
        if !std::process::Command::new(program)
            .arg(url)
            .status()?
            .success()
        {
            bail!("无法打开浏览器");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn info() -> BuildInfo {
        BuildInfo {
            version: "2026.10.5".into(),
            channel: "nightly".into(),
            commit: None,
            built_at: None,
            platform: "windows".into(),
            arch: "x86_64".into(),
        }
    }
    fn release(v: &str) -> Value {
        json!({"tag_name":format!("nightly-{v}"),"draft":false,"prerelease":true,"assets":[{"name":format!("ARaLeBook_{v}_windows-x64-setup.exe"),"size":10},{"name":format!("ARaLeBook_{v}_macos-arm64.dmg"),"size":10}]})
    }
    #[test]
    fn compares_numeric_dates_and_ignores_incomplete_or_other_channels() {
        let mut draft = release("2027.1.1");
        draft["draft"] = json!(true);
        let mut stable = release("2028.1.1");
        stable["prerelease"] = json!(false);
        let mut broken = release("2029.1.1");
        broken["assets"] = json!([]);
        let result = select_update(
            &info(),
            &[
                draft,
                stable,
                broken,
                release("2026.9.30"),
                release("2026.10.6"),
            ],
        );
        assert_eq!(result["version"], "2026.10.6");
        assert_eq!(result["status"], "available");
        assert_eq!(
            select_update(&info(), &[release("2026.10.5")])["status"],
            "latest"
        );
        assert_eq!(select_update(&info(), &[])["status"], "unpublished");
    }
    #[test]
    fn dev_and_unsupported_platforms_do_not_check() {
        let mut i = info();
        i.channel = "dev".into();
        assert_eq!(select_update(&i, &[])["status"], "disabled");
        i.channel = "nightly".into();
        i.platform = "macos".into();
        assert_eq!(select_update(&i, &[])["status"], "unsupported");
        i.arch = "aarch64".into();
        assert_eq!(
            select_update(&i, &[release("2026.10.6")])["status"],
            "available"
        );
    }
    #[test]
    fn validates_dates_and_rejects_urls_as_tags() {
        for bad in [
            "2026.02.5",
            "2026.2.29",
            "2026.10.5/evil",
            "2026.10.5+foo",
            "1.0.0",
        ] {
            assert!(date_version(bad).is_none());
        }
        assert!(date_version("2028.2.29").is_some());
        assert!(open_release(Some("https://evil.invalid")).is_err());
    }
}
