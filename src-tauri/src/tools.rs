// xi-tools download / update — port of xi-zone-editor's GitHub install path.
// Managed install lives under %LOCALAPPDATA%\XiModelViewer\xi-tools.

use serde::Serialize;
use std::fs::{self, File};
use std::io::{copy, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::github::{self, OWNER as GH_OWNER, TOOLS_REPO as GH_REPO};

fn env_path(name: &str) -> Option<PathBuf> {
    let v = std::env::var(name).ok()?;
    let v = v.trim();
    (!v.is_empty()).then(|| PathBuf::from(v))
}

/// Must agree with main.rs user_data_dir_path: XI_DATA_DIR names the *parent*,
/// and `XiModelViewer` is appended. Reading the var bare here meant a set
/// XI_DATA_DIR put notes.json and the xi-tools install in two different trees.
fn app_data_dir() -> PathBuf {
    env_path("XI_DATA_DIR")
        .map(|p| p.join("XiModelViewer"))
        .or_else(|| {
            std::env::var("LOCALAPPDATA")
                .ok()
                .map(|p| PathBuf::from(p).join("XiModelViewer"))
        })
        .or_else(|| env_path("HOME").map(|h| h.join(".cache").join("XiModelViewer")))
        .unwrap_or_else(|| std::env::temp_dir().join("XiModelViewer"))
}

fn tools_override_path() -> PathBuf {
    app_data_dir().join("xi-tools-path.txt")
}

/// Active xi-tools root: local override wins, else downloaded install.
pub fn xi_tools_dir() -> PathBuf {
    if let Ok(s) = fs::read_to_string(tools_override_path()) {
        let p = PathBuf::from(s.trim());
        if p.is_dir() && p.join("src").join("xi").is_dir() {
            return p;
        }
    }
    if let Some(p) = env_path("XI_TOOLS_DIR") {
        if p.is_dir() && p.join("src").join("xi").is_dir() {
            return p;
        }
    }
    app_data_dir().join("xi-tools")
}

pub fn install_complete(dir: &Path) -> bool {
    dir.join("src").join("xi").is_dir()
}

fn validate_tools_dir(dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Err(format!("Not a folder: {}", dir.display()));
    }
    if !dir.join("src").join("xi").is_dir() {
        // Let Path render the separator: this string is shown verbatim in the
        // Settings dialog, and a literal "\" is wrong on macOS/Linux.
        return Err(format!(
            "That folder doesn't look like an xi-tools checkout.\nExpected: {}",
            dir.join("src").join("xi").display()
        ));
    }
    Ok(())
}

fn version_path() -> PathBuf {
    xi_tools_dir().join("version.txt")
}

fn read_local_version() -> String {
    fs::read_to_string(version_path())
        .map(|s| s.trim().trim_start_matches('v').to_string())
        .unwrap_or_else(|_| "0.0.0".into())
}

fn normalize_version(v: &str) -> String {
    v.trim().trim_start_matches('v').to_string()
}

fn is_newer(remote: &str, local: &str) -> bool {
    let r = normalize_version(remote);
    let l = normalize_version(local);
    let parse = |s: &str| -> Option<(u64, u64, u64)> {
        let mut it = s.split(|c| c == '.' || c == '-' || c == '_');
        let a = it.next()?.parse().ok()?;
        let b = it.next().unwrap_or("0").parse().ok()?;
        let c = it.next().unwrap_or("0").parse().ok()?;
        Some((a, b, c))
    };
    match (parse(&r), parse(&l)) {
        (Some(rv), Some(lv)) => rv > lv,
        _ => !r.eq_ignore_ascii_case(&l),
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolsStatus {
    pub installed: bool,
    pub local_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub tools_dir: String,
    pub using_local_override: bool,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolsProgress {
    stage: String,
    label: String,
    loaded: u64,
    total: Option<u64>,
    pct: f64,
    unit: String,
    detail: Option<String>,
}

fn emit_progress(
    app: &AppHandle,
    stage: &str,
    label: &str,
    loaded: u64,
    total: Option<u64>,
    unit: &str,
    detail: Option<String>,
) {
    let pct = match total {
        Some(t) if t > 0 => (loaded as f64 / t as f64) * 100.0,
        _ => 0.0,
    };
    let _ = app.emit(
        "tools-progress",
        ToolsProgress {
            stage: stage.into(),
            label: label.into(),
            loaded,
            total,
            pct: pct.clamp(0.0, 100.0),
            unit: unit.into(),
            detail,
        },
    );
}

fn emit_log(app: &AppHandle, line: impl AsRef<str>) {
    let s = line.as_ref().trim_end();
    if s.is_empty() {
        return;
    }
    let _ = app.emit("tools-log", s.to_string());
}

fn gh_client() -> reqwest::blocking::Client {
    // Long timeout: this client also pulls the release zip, not just metadata.
    github::client(Duration::from_secs(120), true).expect("http client")
}

/// Prefer the JSON API; on 403 rate-limit (common for unauthenticated 60/hr),
/// fall back to the public releases/latest redirect + known zip asset name so
/// Install/Update still works without a token.
fn fetch_latest_release() -> Result<serde_json::Value, String> {
    match fetch_latest_release_api() {
        Ok(v) => Ok(v),
        Err(api_err) => fetch_latest_release_html_fallback()
            .map_err(|fb| format!("{api_err} (HTML fallback also failed: {fb})")),
    }
}

fn fetch_latest_release_api() -> Result<serde_json::Value, String> {
    let url = format!("https://api.github.com/repos/{GH_OWNER}/{GH_REPO}/releases/latest");
    let mut req = gh_client()
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Ok(tok) = std::env::var("GITHUB_TOKEN") {
        if !tok.trim().is_empty() {
            req = req.bearer_auth(tok.trim());
        }
    }
    let resp = req.send().map_err(|e| format!("GitHub request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let remaining = resp
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("?")
            .to_string();
        let reset = resp
            .headers()
            .get("x-ratelimit-reset")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<i64>().ok());
        let reset_hint = reset
            .map(|ts| {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                let mins = ((ts - now).max(0) + 59) / 60;
                format!("; try again in ~{mins} min, or set GITHUB_TOKEN")
            })
            .unwrap_or_else(String::new);
        let body = resp.text().unwrap_or_default();
        let short: String = body.chars().take(160).collect();
        return Err(if short.is_empty() {
            format!("GitHub HTTP {status} (rate remaining {remaining}{reset_hint})")
        } else {
            format!("GitHub HTTP {status} (rate remaining {remaining}{reset_hint}): {short}")
        });
    }
    resp.json().map_err(|e| format!("bad GitHub JSON: {e}"))
}

/// No API quota: follow /releases/latest → tag page, build the zip asset URL
/// (`xi-tools-vX.Y.Z.zip` as published on the repo).
fn fetch_latest_release_html_fallback() -> Result<serde_json::Value, String> {
    // Redirects unfollowed: the tag only exists in the Location header.
    let client = github::client(Duration::from_secs(60), false)?;
    let tag = github::latest_tag(&client, GH_OWNER, GH_REPO)?;

    let name = format!("xi-tools-{tag}.zip");
    let url = github::asset_url(GH_OWNER, GH_REPO, &tag, &name);

    // Same shape pick_zip_asset expects from the API payload.
    Ok(serde_json::json!({
        "tag_name": tag,
        "assets": [{
            "name": name,
            "browser_download_url": url,
        }]
    }))
}

pub fn tools_status_local() -> ToolsStatus {
    let dir = xi_tools_dir();
    let local = read_local_version();
    let installed = install_complete(&dir);
    let using_override = tools_override_path().is_file()
        || env_path("XI_TOOLS_DIR").map(|p| p == dir).unwrap_or(false);
    ToolsStatus {
        installed,
        local_version: local,
        latest_version: None,
        update_available: false,
        tools_dir: dir.display().to_string(),
        using_local_override: using_override,
        error: None,
    }
}

/// Disk-only. Does **not** call GitHub — Settings / boot status must not burn
/// the unauthenticated API quota. Use `tools_check_updates` when the user (or
/// a deliberate boot update pass) asks for a release check.
#[tauri::command]
pub fn tools_status() -> ToolsStatus {
    tools_status_local()
}

/// One network round-trip to compare the managed install against GitHub latest.
#[tauri::command]
pub async fn tools_check_updates() -> ToolsStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let mut st = tools_status_local();
        if st.using_local_override {
            return st;
        }
        match fetch_latest_release() {
            Ok(rel) => {
                if let Some(tag) = rel.get("tag_name").and_then(|v| v.as_str()) {
                    st.latest_version = Some(normalize_version(tag));
                    st.update_available = is_newer(tag, &st.local_version) || !st.installed;
                }
            }
            Err(e) => st.error = Some(e),
        }
        st
    })
    .await
    .unwrap_or_else(|e| {
        let mut st = tools_status_local();
        st.error = Some(format!("update check failed: {e}"));
        st
    })
}

#[tauri::command]
pub fn tools_set_local_path(path: String) -> Result<ToolsStatus, String> {
    let dir = PathBuf::from(path.trim());
    validate_tools_dir(&dir)?;
    fs::create_dir_all(app_data_dir()).map_err(|e| e.to_string())?;
    fs::write(tools_override_path(), dir.display().to_string()).map_err(|e| e.to_string())?;
    Ok(tools_status_local())
}

#[tauri::command]
pub fn tools_clear_local_path() -> Result<ToolsStatus, String> {
    let _ = fs::remove_file(tools_override_path());
    Ok(tools_status_local())
}

#[tauri::command]
pub fn pick_tools_folder(initial: Option<String>) -> Option<String> {
    let mut dialog = rfd::FileDialog::new().set_title("Select local xi-tools folder");
    if let Some(p) = initial {
        if Path::new(&p).is_dir() {
            dialog = dialog.set_directory(p);
        }
    } else if let Some(home) = env_path("USERPROFILE").or_else(|| env_path("HOME")) {
        dialog = dialog.set_directory(home);
    }
    dialog
        .pick_folder()
        .map(|p| p.to_string_lossy().into_owned())
}

fn pick_zip_asset(rel: &serde_json::Value) -> Result<(String, String), String> {
    let assets = rel
        .get("assets")
        .and_then(|a| a.as_array())
        .ok_or("release has no assets")?;
    let mut best: Option<&serde_json::Value> = None;
    for a in assets {
        let name = a.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if !name.ends_with(".zip") {
            continue;
        }
        if name.eq_ignore_ascii_case("python.zip") {
            continue;
        }
        if name.starts_with("xi-tools") {
            best = Some(a);
            break;
        }
        if best.is_none() {
            best = Some(a);
        }
    }
    let a = best.ok_or("no zip asset on release")?;
    let name = a
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or("asset name missing")?
        .to_string();
    let url = a
        .get("browser_download_url")
        .and_then(|n| n.as_str())
        .ok_or("asset url missing")?
        .to_string();
    Ok((name, url))
}

fn extract_zip_progress(
    zip_path: &Path,
    dest: &Path,
    app: Option<&AppHandle>,
    stage: &str,
    label: &str,
) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let total = archive.len() as u64;
    if let Some(app) = app {
        emit_progress(app, stage, label, 0, Some(total.max(1)), "files", None);
    }
    let mut last = Instant::now() - Duration::from_millis(200);
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let outpath = match file.enclosed_name() {
            Some(p) => dest.join(p),
            None => continue,
        };
        if file.name().ends_with('/') {
            fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = outpath.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut outfile = File::create(&outpath).map_err(|e| e.to_string())?;
            copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
        }
        let done = (i as u64) + 1;
        if let Some(app) = app {
            if last.elapsed() >= Duration::from_millis(80) || done == total {
                emit_progress(app, stage, label, done, Some(total.max(1)), "files", None);
                last = Instant::now();
            }
        }
    }
    if let Some(app) = app {
        emit_progress(app, stage, label, total.max(1), Some(total.max(1)), "files", None);
    }
    Ok(())
}

fn download_file_progress(
    url: &str,
    dest: &Path,
    app: Option<&AppHandle>,
    stage: &str,
    label: &str,
) -> Result<(), String> {
    let mut req = gh_client().get(url);
    if let Ok(tok) = std::env::var("GITHUB_TOKEN") {
        if !tok.trim().is_empty() {
            req = req.bearer_auth(tok.trim());
        }
    }
    let mut resp = req
        .send()
        .map_err(|e| format!("download failed ({url}): {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download HTTP {} ({url})", resp.status()));
    }
    let total = resp.content_length();
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if let Some(app) = app {
        emit_progress(app, stage, label, 0, total, "bytes", None);
    }
    let mut f = File::create(dest).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 64 * 1024];
    let mut loaded: u64 = 0;
    let mut last = Instant::now() - Duration::from_millis(200);
    loop {
        let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        loaded += n as u64;
        if let Some(app) = app {
            let finished = total.map(|t| loaded >= t).unwrap_or(false);
            if last.elapsed() >= Duration::from_millis(100) || finished {
                emit_progress(app, stage, label, loaded, total, "bytes", None);
                last = Instant::now();
            }
        }
    }
    if let Some(app) = app {
        let t = total.or(Some(loaded));
        emit_progress(app, stage, label, loaded, t, "bytes", None);
    }
    Ok(())
}

fn tools_install_or_update_sync(app: &AppHandle) -> Result<ToolsStatus, String> {
    emit_progress(app, "release", "Fetching latest release…", 0, None, "none", None);
    emit_log(app, "Fetching latest release from github.com/vekien/xi-tools …");
    let rel = fetch_latest_release()?;
    let tag = rel
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or("release tag missing")?
        .to_string();
    let (_name, url) = pick_zip_asset(&rel)?;

    // Always install into the managed AppData folder (not a local override path).
    let dir = app_data_dir().join("xi-tools");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    for wipe in ["src", "docs", "misc", "schema"] {
        let p = dir.join(wipe);
        if p.exists() {
            let _ = fs::remove_dir_all(&p);
        }
    }

    let tmp = app_data_dir().join("download.zip");
    emit_log(app, format!("Downloading xi-tools {tag} …"));
    download_file_progress(
        &url,
        &tmp,
        Some(app),
        "download-tools",
        "Downloading xi-tools…",
    )?;
    emit_log(app, "Download complete. Extracting…");

    extract_zip_progress(
        &tmp,
        &dir,
        Some(app),
        "extract-tools",
        "Extracting xi-tools…",
    )?;
    let _ = fs::remove_file(&tmp);
    emit_log(app, format!("Installed xi-tools v{}", normalize_version(&tag)));

    if let Some(assets) = rel.get("assets").and_then(|a| a.as_array()) {
        if let Some(py) = assets.iter().find(|a| {
            a.get("name")
                .and_then(|n| n.as_str())
                .map(|n| n.eq_ignore_ascii_case("python.zip"))
                .unwrap_or(false)
        }) {
            if let Some(purl) = py.get("browser_download_url").and_then(|u| u.as_str()) {
                let pytmp = app_data_dir().join("python.zip");
                if download_file_progress(
                    purl,
                    &pytmp,
                    Some(app),
                    "download-python-bundle",
                    "Downloading bundled Python…",
                )
                .is_ok()
                {
                    let _ = extract_zip_progress(
                        &pytmp,
                        &dir,
                        Some(app),
                        "extract-python-bundle",
                        "Extracting bundled Python…",
                    );
                }
                let _ = fs::remove_file(&pytmp);
            }
        }
    }

    emit_progress(app, "finalize", "Finalising install…", 1, Some(1), "none", None);
    fs::write(dir.join("version.txt"), normalize_version(&tag)).map_err(|e| e.to_string())?;

    let env = dir.join(".env");
    if !env.exists() {
        let sample = dir.join(".env.sample");
        if sample.exists() {
            let _ = fs::copy(sample, &env);
        } else {
            let _ = File::create(&env).and_then(|mut f| writeln!(f, "# xi-tools env"));
        }
    }

    let mut st = tools_status_local();
    // After install, if still on override, tools_dir points at override; report managed path too.
    st.tools_dir = dir.display().to_string();
    st.latest_version = Some(normalize_version(&tag));
    st.local_version = normalize_version(&tag);
    st.installed = install_complete(&dir);
    st.update_available = false;
    Ok(st)
}

#[tauri::command]
pub async fn tools_install_or_update(app: AppHandle) -> Result<ToolsStatus, String> {
    tauri::async_runtime::spawn_blocking(move || tools_install_or_update_sync(&app))
        .await
        .map_err(|e| format!("install task failed: {e}"))?
}
