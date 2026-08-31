// One place for "ask github.com what the latest release is".
//
// This algorithm had three copies — app_latest_release (main.rs),
// fetch_latest_release_html_fallback (tools.rs), and the dev server's Python —
// each rebuilding the same client and re-parsing the same redirect. Two of them
// were in this crate and still didn't share, under different constant names.
//
// The HTML route exists because api.github.com is rate-limited to 60/hr
// unauthenticated, which real users hit. `releases/latest` 302s to the tag page,
// so the Location header alone gives the tag with no quota spent.

use std::time::Duration;

pub const OWNER: &str = "vekien";
/// This app. Also the UA's contact URL, whichever repo is being queried.
pub const APP_REPO: &str = "xi-model-viewer";
/// The xi CLI, installed and updated by tools.rs.
pub const TOOLS_REPO: &str = "xi-tools";

/// GitHub asks for a descriptive UA; bare short names sometimes get 403s.
fn user_agent() -> String {
    format!(
        "{APP_REPO}/{} (+https://github.com/{OWNER}/{APP_REPO})",
        env!("CARGO_PKG_VERSION")
    )
}

/// HTTP client with the shared UA.
///
/// `follow_redirects` is the whole reason there are two flavours: resolving a
/// tag needs the 302 *unfollowed* so the Location header survives, while
/// downloading an asset needs it followed.
pub fn client(timeout: Duration, follow_redirects: bool) -> Result<reqwest::blocking::Client, String> {
    let mut b = reqwest::blocking::Client::builder()
        .user_agent(user_agent())
        .timeout(timeout);
    if !follow_redirects {
        b = b.redirect(reqwest::redirect::Policy::none());
    }
    b.build().map_err(|e| e.to_string())
}

/// Tag of the newest release, from the `releases/latest` redirect.
///
/// Requires a client built with `follow_redirects = false`.
pub fn latest_tag(
    client: &reqwest::blocking::Client,
    owner: &str,
    repo: &str,
) -> Result<String, String> {
    let latest = format!("https://github.com/{owner}/{repo}/releases/latest");
    let resp = client
        .get(&latest)
        .send()
        .map_err(|e| format!("releases/latest: {e}"))?;
    let loc = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("no redirect from releases/latest (HTTP {})", resp.status()))?;

    // .../releases/tag/v1.5.12
    loc.rsplit('/')
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("could not parse tag from {loc}"))
}

/// Strip a leading `v` from a tag: `v1.2.3` → `1.2.3`.
pub fn version_of(tag: &str) -> String {
    tag.trim_start_matches(['v', 'V']).to_string()
}

/// Canonical download URL for a named asset on a tag.
pub fn asset_url(owner: &str, repo: &str, tag: &str, name: &str) -> String {
    format!("https://github.com/{owner}/{repo}/releases/download/{tag}/{name}")
}

/// Public tag page, for "view the release" links.
pub fn tag_url(owner: &str, repo: &str, tag: &str) -> String {
    format!("https://github.com/{owner}/{repo}/releases/tag/{tag}")
}

/// Real asset URL + filename, scraped from the release's asset fragment.
///
/// Best-effort: callers fall back to a constructed name. `suffix` is matched
/// case-insensitively against the href (e.g. ".exe", ".zip").
pub fn find_asset(
    client: &reqwest::blocking::Client,
    owner: &str,
    repo: &str,
    tag: &str,
    suffix: &str,
) -> Option<(String, String)> {
    let url = format!("https://github.com/{owner}/{repo}/releases/expanded_assets/{tag}");
    let resp = client.get(&url).send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let html = resp.text().ok()?;
    let want = suffix.to_ascii_lowercase();
    let href = html
        .split("href=\"")
        .skip(1)
        .filter_map(|s| s.split('"').next())
        .find(|h| h.to_ascii_lowercase().ends_with(&want))?;

    let full = if href.starts_with("http") {
        href.to_string()
    } else {
        format!("https://github.com{href}")
    };
    let name = full.rsplit('/').next().filter(|s| !s.is_empty())?.to_string();
    Some((full, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_strips_the_tag_prefix() {
        assert_eq!(version_of("v1.5.12"), "1.5.12");
        assert_eq!(version_of("V1.5.12"), "1.5.12");
        assert_eq!(version_of("1.5.12"), "1.5.12");
    }

    #[test]
    fn urls_match_what_github_publishes() {
        assert_eq!(
            asset_url(OWNER, TOOLS_REPO, "v1.5.12", "xi-tools-v1.5.12.zip"),
            "https://github.com/vekien/xi-tools/releases/download/v1.5.12/xi-tools-v1.5.12.zip"
        );
        assert_eq!(
            tag_url(OWNER, APP_REPO, "v1.0.8"),
            "https://github.com/vekien/xi-model-viewer/releases/tag/v1.0.8"
        );
    }

    /// The scrape in find_asset, exercised without a network round trip.
    fn pick(html: &str, suffix: &str) -> Option<String> {
        let want = suffix.to_ascii_lowercase();
        html.split("href=\"")
            .skip(1)
            .filter_map(|s| s.split('"').next())
            .find(|h| h.to_ascii_lowercase().ends_with(&want))
            .map(str::to_string)
    }

    #[test]
    fn asset_scrape_picks_the_matching_extension() {
        let html = r#"<a href="/vekien/xi-model-viewer/releases/download/v1.0.8/notes.txt">n</a>
                      <a href="/vekien/xi-model-viewer/releases/download/v1.0.8/XiModelViewer.exe">x</a>"#;
        assert_eq!(
            pick(html, ".exe").as_deref(),
            Some("/vekien/xi-model-viewer/releases/download/v1.0.8/XiModelViewer.exe")
        );
        // No match must stay None so the caller keeps its constructed name.
        assert!(pick(html, ".dmg").is_none());
        // Leading markup before the first href= is not a candidate.
        assert!(pick("<html>whatever.exe</html>", ".exe").is_none());
    }
}
