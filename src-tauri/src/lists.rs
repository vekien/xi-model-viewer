// Asset-list updates — pulling `mv/lists/*.json` from xi-tools at runtime.
//
// The lists ship baked into this binary (Vite copies ui/public into the bundle),
// so until this existed a newly-found animation or gear row could only reach a
// user through a whole new .exe. But this repo does not author them: xi-tools
// does, through `xi mv update`, which writes `mv/lists/manifest.json` at the end
// of every run. That manifest is the publish step, and this module is the only
// thing here that reads it.
//
// The comparison is content-addressed — every file's sha256 against the copy the
// app actually holds — so there is no version to bump on either side and nothing
// to get out of step. A list reverted in xi-tools goes back to matching on its
// own, and a download that gets corrupted is simply re-fetched next boot.
//
//   what we hold = <user data>/lists/<name>, hashed, when it is there
//                  else the baked manifest's entry for <name>
//
// Reading the manifest from `raw.githubusercontent.com` costs no API quota (it
// is not rate-limited the way api.github.com is) and raises no CORS problem,
// because the request happens here and not in the page.
//
// Each file lands under a `.part` name, is checked against the manifest's sha256
// and size, and only then renamed into place — a failed or interrupted download
// leaves the previous copy alone rather than half-replacing it.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::github;

/// Where the lists are published. xi-tools generates them, so they are read from
/// its branch, not this repo's — and from a branch rather than a release,
/// because the point is that a list lands with a push.
const BRANCH: &str = "main";
const LISTS_PATH: &str = "mv/lists";
/// The check is one ~1 KB request on the boot path, and boot must not wait on a
/// hung proxy or a captive portal. Ten seconds, then give up silently — the
/// baked lists are already loaded and the next launch will try again.
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
/// The files themselves are a different bet: this only runs once the check has
/// already answered, so the network is known to work, and 12 MB on a slow line
/// deserves more than ten seconds.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// Far above any real list — a guard against a redirect to something else,
/// not an expectation.
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

fn raw_url(name: &str) -> String {
    format!(
        "https://raw.githubusercontent.com/{}/{}/{BRANCH}/{LISTS_PATH}/{name}",
        github::OWNER,
        github::TOOLS_REPO
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListFile {
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    #[serde(default)]
    pub generated: Option<String>,
    pub files: BTreeMap<String, ListFile>,
}

/// What one boot sync did, for the notice the frontend shows.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListsSync {
    /// Lists actually replaced. Empty means there was nothing to do.
    pub updated: Vec<String>,
    pub bytes: u64,
    /// Where the downloads live, so the frontend can read them.
    pub dir: String,
    pub error: Option<String>,
}

/// `<user data>/lists`, the only place downloads are written.
pub fn lists_dir(user_data: &Path) -> PathBuf {
    user_data.join("lists")
}

/// The manifest the running build shipped with, describing its baked lists.
///
/// Compiled in rather than read from the bundle: the frontend assets live inside
/// the executable and this module has no asset resolver. It is a plain copy of
/// xi-tools' manifest, taken when the lists were last synced into this repo.
fn baked_manifest() -> Manifest {
    const BAKED: &str = include_str!("../../ui/public/lists/manifest.json");
    serde_json::from_str(BAKED).unwrap_or(Manifest {
        generated: None,
        files: BTreeMap::new(),
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_file(path: &Path) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        match f.read(&mut buf).ok()? {
            0 => break,
            n => h.update(&buf[..n]),
        }
    }
    Some(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn fetch_manifest(client: &reqwest::blocking::Client) -> Result<Manifest, String> {
    let resp = client
        .get(raw_url("manifest.json"))
        // Per-request, so the same client can still spend two minutes on the
        // files once this has told us there is something to fetch.
        .timeout(CHECK_TIMEOUT)
        // raw.githubusercontent caches aggressively; a stale manifest would
        // silently pin everyone to an old list set.
        .header("Cache-Control", "no-cache")
        .send()
        .map_err(|e| format!("list manifest: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("list manifest: HTTP {}", resp.status()));
    }
    resp.json().map_err(|e| format!("bad list manifest: {e}"))
}

/// The sha256 of the copy of `name` the app would read right now.
///
/// A downloaded file is hashed rather than trusted from a record: that makes a
/// truncated or hand-edited override heal itself on the next boot, and it means
/// there is no second manifest to keep in step with the files beside it.
fn local_sha(dir: &Path, baked: &Manifest, name: &str) -> Option<String> {
    let downloaded = dir.join(name);
    if downloaded.is_file() {
        if let Some(h) = sha256_file(&downloaded) {
            return Some(h);
        }
    }
    baked.files.get(name).map(|f| f.sha256.clone())
}

fn download_verified(
    client: &reqwest::blocking::Client,
    name: &str,
    want: &ListFile,
) -> Result<Vec<u8>, String> {
    if want.bytes > MAX_FILE_BYTES {
        return Err(format!("{name}: manifest claims {} bytes", want.bytes));
    }
    let resp = client
        .get(raw_url(name))
        .header("Cache-Control", "no-cache")
        .send()
        .map_err(|e| format!("{name}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{name}: HTTP {}", resp.status()));
    }
    // Bounded read: a body that disagrees with the manifest is a bad mirror or a
    // redirect to something else, and must not be allowed to fill the disk.
    let mut body = Vec::with_capacity(want.bytes as usize);
    resp.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|e| format!("{name}: {e}"))?;
    if body.len() as u64 != want.bytes {
        return Err(format!(
            "{name}: got {} bytes, manifest says {}",
            body.len(),
            want.bytes
        ));
    }
    let got = sha256_hex(&body);
    if got != want.sha256 {
        return Err(format!("{name}: sha256 {got} does not match the manifest"));
    }
    Ok(body)
}

/// Fetch xi-tools' manifest and replace every list whose contents have moved.
///
/// One call does the whole job — there is no separate check, because the check
/// *is* the manifest fetch. Failures are reported, never raised: being offline
/// or behind a proxy has to leave the app running on its baked lists exactly as
/// it did before.
/// One row of the Settings › DAT Lists table.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEntry {
    pub name: String,
    pub bytes: u64,
    /// `"downloaded"` when a copy in the user folder is what gets read,
    /// `"baked"` when the build's own copy is.
    pub source: String,
}

/// Which lists are in effect and where each one comes from. Disk only.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListsStatus {
    /// When xi-tools generated the manifest this build was baked with.
    pub generated: Option<String>,
    pub dir: String,
    pub files: Vec<ListEntry>,
    /// How many rows are being read from the download folder.
    pub downloaded: usize,
    pub bytes: u64,
}

/// What the app would read right now, per list — no network.
///
/// Settings has to render instantly and must not spend a request just to be
/// opened, the same rule `tools_status` follows. The Update button is what goes
/// to the network.
pub fn status(user_data: &Path) -> ListsStatus {
    let baked = baked_manifest();
    let dir = lists_dir(user_data);

    // Union of the two sides: a list added upstream since this build was cut
    // exists only in the download folder, and should still be shown.
    let mut names: BTreeMap<String, ()> = baked.files.keys().map(|n| (n.clone(), ())).collect();
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            // manifest.json is not a list, and a crashed run can leave `.part`.
            if name.ends_with(".json") && name != "manifest.json" {
                names.insert(name, ());
            }
        }
    }

    let mut out = ListsStatus { generated: baked.generated.clone(), dir: dir.to_string_lossy().into_owned(), ..Default::default() };
    for name in names.into_keys() {
        let downloaded = dir.join(&name);
        let (bytes, source) = match fs::metadata(&downloaded) {
            Ok(m) if m.is_file() => (m.len(), "downloaded"),
            _ => (baked.files.get(&name).map(|f| f.bytes).unwrap_or(0), "baked"),
        };
        out.bytes += bytes;
        if source == "downloaded" {
            out.downloaded += 1;
        }
        out.files.push(ListEntry { name, bytes, source: source.into() });
    }
    out
}

pub fn sync(user_data: &Path) -> ListsSync {
    let dir = lists_dir(user_data);
    let mut out = ListsSync { dir: dir.to_string_lossy().into_owned(), ..Default::default() };

    let client = match github::client(DOWNLOAD_TIMEOUT, true) {
        Ok(c) => c,
        Err(e) => {
            out.error = Some(e);
            return out;
        }
    };
    let remote = match fetch_manifest(&client) {
        Ok(m) => m,
        Err(e) => {
            out.error = Some(e);
            return out;
        }
    };

    let baked = baked_manifest();
    let stale: Vec<&String> = remote
        .files
        .iter()
        .filter(|(name, want)| local_sha(&dir, &baked, name).as_deref() != Some(&want.sha256))
        .map(|(name, _)| name)
        .collect();
    if stale.is_empty() {
        return out;
    }

    if let Err(e) = fs::create_dir_all(&dir) {
        out.error = Some(format!("{}: {e}", dir.display()));
        return out;
    }

    let mut failed = Vec::new();
    for name in stale {
        // A name from the manifest is used as a path: keep it to a bare file
        // name so a crafted or mistyped entry cannot write outside `dir`.
        if Path::new(name).file_name().map(|f| f != name.as_str()).unwrap_or(true) {
            failed.push(format!("{name}: not a plain file name"));
            continue;
        }
        match download_verified(&client, name, &remote.files[name]) {
            Ok(body) => {
                let part = dir.join(format!("{name}.part"));
                let dest = dir.join(name);
                if let Err(e) = fs::write(&part, &body).and_then(|_| fs::rename(&part, &dest)) {
                    let _ = fs::remove_file(&part);
                    failed.push(format!("{name}: {e}"));
                } else {
                    out.bytes += body.len() as u64;
                    out.updated.push(name.clone());
                }
            }
            Err(e) => failed.push(e),
        }
    }
    if !failed.is_empty() {
        out.error = Some(failed.join("; "));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(files: &[(&str, &str, u64)]) -> Manifest {
        Manifest {
            generated: None,
            files: files
                .iter()
                .map(|(n, s, b)| (n.to_string(), ListFile { sha256: s.to_string(), bytes: *b }))
                .collect(),
        }
    }

    #[test]
    fn the_baked_manifest_parses() {
        // Guards the include_str! against a manifest whose shape drifts. A build
        // that cannot read its own list hashes would treat every file as stale
        // and re-download all 12 MB on each boot.
        let m = baked_manifest();
        assert!(m.files.contains_key("characters.json"));
        let c = &m.files["characters.json"];
        assert_eq!(c.sha256.len(), 64);
        assert!(c.bytes > 0);
    }

    #[test]
    fn a_baked_list_that_matches_the_remote_is_not_fetched() {
        let dir = std::env::temp_dir().join("xi-lists-test-none");
        let _ = fs::remove_dir_all(&dir);
        let baked = manifest(&[("a.json", "aa", 10)]);
        assert_eq!(local_sha(&dir, &baked, "a.json").as_deref(), Some("aa"));
    }

    #[test]
    fn a_list_in_neither_place_has_no_local_hash_so_it_is_fetched() {
        let dir = std::env::temp_dir().join("xi-lists-test-missing");
        let _ = fs::remove_dir_all(&dir);
        let baked = manifest(&[("a.json", "aa", 10)]);
        assert_eq!(local_sha(&dir, &baked, "new.json"), None);
    }

    #[test]
    fn a_downloaded_list_is_hashed_and_wins_over_the_baked_entry() {
        let dir = std::env::temp_dir().join("xi-lists-test-override");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.json"), b"abc").unwrap();
        // Baked says "aa"; the file on disk is what actually gets read, so its
        // real hash is what the remote must be compared against.
        let baked = manifest(&[("a.json", "aa", 10)]);
        assert_eq!(
            local_sha(&dir, &baked, "a.json").as_deref(),
            Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sha256_matches_the_manifest_format() {
        // Lowercase hex, no separators — what xi-tools' write_manifest emits.
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn raw_urls_point_at_the_lists_in_xi_tools() {
        assert_eq!(
            raw_url("characters.json"),
            "https://raw.githubusercontent.com/vekien/xi-tools/main/mv/lists/characters.json"
        );
    }
}
