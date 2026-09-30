//! OAuth 2.0 with PKCE (RFC 7636) for Lichess. Alternative to pasting a
//! personal access token: the user clicks "Sign in with Lichess", a
//! browser tab opens Lichess's approve-app screen, and the resulting
//! access token lands in the same OS-keychain slot the PAT flow uses.
//!
//! PKCE + a loopback redirect are what make this OK for a desktop app:
//! no client secret, no pre-registration with Lichess (any `client_id`
//! is accepted -- see <https://lichess.org/api#tag/OAuth>). The flow:
//!
//! 1. Generate a random `code_verifier` (32 bytes -> 43-char base64url).
//! 2. Derive `code_challenge = base64url(sha256(verifier))`.
//! 3. Bind a `TcpListener` on `127.0.0.1:0`; the kernel picks a free
//!    port. `redirect_uri = http://127.0.0.1:{port}/callback`.
//! 4. Open Lichess's authorize URL in the browser via
//!    `tauri-plugin-opener` with `challenge`, `state`, `redirect_uri`,
//!    and the requested `scope`s.
//! 5. Wait for the loopback callback with a 5-minute total timeout.
//! 6. Verify the returned `state` matches (CSRF guard).
//! 7. POST `code + code_verifier + client_id + redirect_uri` to
//!    `https://lichess.org/api/token` -> `access_token`.
//!
//! The command that ties this together lives in `lichess.rs`
//! (`lichess_oauth_login`); this module owns only the pure PKCE
//! primitives + the loopback + the token exchange.

use std::time::Duration;

use base64::Engine as _;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Static client identifier. Lichess doesn't require pre-registration,
/// so this is just a stable string that shows up on the authorize
/// screen so the user knows which app is asking. Do not use a URL --
/// Lichess shows the raw string verbatim.
pub const CLIENT_ID: &str = "com.jediknights.chessboard";

/// Endpoint the browser is sent to for the user to approve the request.
const AUTHORIZE_URL: &str = "https://lichess.org/oauth";

/// Endpoint the client POSTs the code + verifier to for the access token.
const TOKEN_URL: &str = "https://lichess.org/api/token";

/// How long we wait for the browser callback before giving up. Users
/// might get distracted, open the wrong tab, need to log in first,
/// etc. Five minutes is generous without being infinite.
pub const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

/// Fields parsed from the OAuth callback query. Only what's needed to
/// exchange for a token -- ignores anything else Lichess might append.
#[derive(Debug, PartialEq, Eq)]
pub struct CallbackParams {
    pub code: String,
    pub state: String,
}

/// PKCE code_verifier: 32 random bytes → 43-char base64url. Well within
/// RFC 7636's 43-128 char bound and inside the base64url character set
/// so no URL encoding is needed when submitted.
pub fn generate_verifier() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("os randomness unavailable");
    base64_url_encode(&bytes)
}

/// CSRF state token. Cryptographic randomness because a predictable
/// state defeats the whole point of the check. 16 bytes = 22-char
/// base64url, enough entropy that a collision or guess isn't practical.
pub fn generate_state() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("os randomness unavailable");
    base64_url_encode(&bytes)
}

/// PKCE code_challenge = base64url(sha256(verifier)).
///
/// Deliberately hashes the verifier's ASCII bytes, not the raw random
/// bytes that produced it -- RFC 7636 §4.2 defines the challenge over
/// the verifier *string*.
pub fn challenge_from_verifier(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let digest = hasher.finalize();
    base64_url_encode(&digest)
}

fn base64_url_encode(data: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

/// Builds the Lichess authorize URL. Uses `reqwest::Url` (re-exported
/// by the reqwest we already depend on) so query encoding is delegated
/// to a battle-tested implementation instead of hand-rolled percent
/// encoding.
pub fn build_authorize_url(
    challenge: &str,
    state: &str,
    redirect_uri: &str,
    scopes: &[&str],
) -> Result<String, String> {
    let scope_str = scopes.join(" ");
    let url = reqwest::Url::parse_with_params(
        AUTHORIZE_URL,
        &[
            ("response_type", "code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", redirect_uri),
            ("code_challenge_method", "S256"),
            ("code_challenge", challenge),
            ("scope", scope_str.as_str()),
            ("state", state),
        ],
    )
    .map_err(|e| format!("failed to build authorize URL: {e}"))?;
    Ok(url.to_string())
}

/// Parses the HTTP request line the browser sends to `127.0.0.1:{port}`
/// and extracts `code`/`state` from the query string.
///
/// Deliberately narrow: reads only the first line (`GET /callback?...
/// HTTP/1.1`), doesn't look at headers. That's all Lichess ever sends
/// on this callback, and doing less means less parser surface to get
/// wrong at a trust boundary.
///
/// Surfaces Lichess's own `error` param (the user hit Deny on the
/// authorize screen) as an `Err` rather than pretending success --
/// same fail-closed pattern as everywhere else in this codebase.
pub fn parse_callback_request_line(line: &str) -> Result<CallbackParams, String> {
    let mut parts = line.split_whitespace();
    let _method = parts.next().ok_or_else(|| "empty request line".to_string())?;
    let path = parts.next().ok_or_else(|| "malformed request line".to_string())?;
    let (_path, query) = path
        .split_once('?')
        .ok_or_else(|| "callback URL has no query string".to_string())?;

    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    let mut error: Option<String> = None;
    for pair in query.split('&') {
        // A trailing '&' or a bare param like `?debug` produces an
        // empty or key-only pair; skip rather than error out, since
        // Lichess never sends those but a proxy might inject one.
        let (k, v) = match pair.split_once('=') {
            Some(p) => p,
            None => continue,
        };
        let decoded = url_decode(v);
        match k {
            "code" => code = Some(decoded),
            "state" => state = Some(decoded),
            "error" => error = Some(decoded),
            _ => {}
        }
    }

    if let Some(e) = error {
        return Err(format!("lichess OAuth error: {e}"));
    }

    Ok(CallbackParams {
        code: code.ok_or_else(|| "callback missing `code`".to_string())?,
        state: state.ok_or_else(|| "callback missing `state`".to_string())?,
    })
}

/// URL-decode a query-parameter value. Handles `%XX` percent-escapes
/// and `+` -> space (application/x-www-form-urlencoded convention).
/// Deliberately small: no full URI parsing, since the callback shape
/// is fixed (`code=` and `state=` are alphanumeric + a handful of
/// safe chars anyway).
fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = &s[i + 1..i + 3];
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                    i += 3;
                } else {
                    // Not a valid hex pair -- pass the '%' through.
                    // Same policy as browsers when they encounter one.
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The success HTML the browser tab shows after a good callback.
/// Kept small and self-contained so the tab never depends on a
/// live network for its own resources.
const SUCCESS_HTML: &str = "<!DOCTYPE html><html><head><title>chess-board</title>\
<meta name=\"color-scheme\" content=\"light dark\"><style>\
body{font-family:system-ui,sans-serif;padding:2em;line-height:1.5;text-align:center}\
h1{margin:0 0 0.5em}p{color:#666}</style></head><body>\
<h1>Signed in to Lichess</h1>\
<p>You can close this window and return to chess-board.</p>\
</body></html>";

fn success_response() -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        SUCCESS_HTML.len(),
        SUCCESS_HTML,
    )
}

/// Accept exactly one connection on `listener`, parse the request line,
/// verify `state`, and write the success HTML back. Returns the
/// extracted params. Caller wraps this in `tokio::time::timeout`.
///
/// The buffer is deliberately capped (4 KiB): a legitimate Lichess
/// callback is comfortably under 1 KiB, and a huge inbound request on
/// a local loopback port is almost certainly a probe -- fail fast
/// rather than allocate unboundedly.
pub async fn accept_callback(
    listener: &TcpListener,
    expected_state: &str,
) -> Result<CallbackParams, String> {
    const MAX_REQUEST_BYTES: usize = 4096;

    let (mut stream, _peer) = listener
        .accept()
        .await
        .map_err(|e| format!("loopback accept failed: {e}"))?;

    let mut buf = vec![0u8; MAX_REQUEST_BYTES];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("loopback read failed: {e}"))?;
    if n == 0 {
        return Err("loopback callback: empty request".to_string());
    }

    // We only need the first line of the request. Splitting on the
    // request-line terminator (`\r\n`) is more correct than `lines()`
    // when the buffer already contains headers.
    let request = std::str::from_utf8(&buf[..n])
        .map_err(|_| "loopback callback: invalid UTF-8 in request".to_string())?;
    let first_line = request
        .split("\r\n")
        .next()
        .ok_or_else(|| "loopback callback: no request line".to_string())?;

    let params = parse_callback_request_line(first_line)?;
    if params.state != expected_state {
        // Fail closed on CSRF: don't write the success HTML, don't
        // hand back the code -- close the connection with a bare 400.
        let bad = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(bad.as_bytes()).await;
        let _ = stream.shutdown().await;
        return Err("OAuth state mismatch -- refusing the callback".to_string());
    }

    let _ = stream.write_all(success_response().as_bytes()).await;
    let _ = stream.shutdown().await;
    Ok(params)
}

/// POSTs the code + verifier to `/api/token` and returns the resulting
/// `access_token`. Kept in this module rather than reusing
/// `post_with_retry` in `lichess.rs` because the token endpoint isn't
/// authenticated (no bearer header) and shouldn't share the outbound
/// mutex -- it runs exactly once per login and blocking other requests
/// during it would be gratuitous.
pub async fn exchange_code_for_token(
    client: &reqwest::Client,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<String, String> {
    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", CLIENT_ID),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .map_err(|e| format!("token exchange failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "lichess rejected token exchange: {status} {body}"
        ));
    }

    // Read the body as text and deserialize with serde_json to avoid
    // pulling in reqwest's `json` feature just for one endpoint.
    let body = response
        .text()
        .await
        .map_err(|e| format!("failed to read token response: {e}"))?;
    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("failed to parse token response: {e}"))?;

    json.get("access_token")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| "token response has no `access_token`".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifier_is_43_chars_and_url_safe() {
        // 32 bytes -> 43 base64url chars, no padding. RFC 7636 §4.1
        // requires 43-128 chars from the URL-safe alphabet.
        for _ in 0..100 {
            let v = generate_verifier();
            assert_eq!(v.len(), 43);
            for c in v.chars() {
                assert!(
                    c.is_ascii_alphanumeric() || c == '-' || c == '_',
                    "verifier contains non-base64url char: {c}"
                );
            }
        }
    }

    #[test]
    fn state_is_at_least_22_chars_and_url_safe() {
        // 16 bytes -> 22 base64url chars. Any less would risk practical
        // guessability for a live CSRF window.
        for _ in 0..100 {
            let s = generate_state();
            assert_eq!(s.len(), 22);
            for c in s.chars() {
                assert!(c.is_ascii_alphanumeric() || c == '-' || c == '_');
            }
        }
    }

    #[test]
    fn generate_verifier_returns_distinct_values() {
        // Not a strong statistical test -- just catches the "we
        // accidentally returned a constant" regression class.
        let a = generate_verifier();
        let b = generate_verifier();
        assert_ne!(a, b);
    }

    #[test]
    fn challenge_matches_the_rfc_7636_appendix_b_test_vector() {
        // RFC 7636 Appendix B: verifier =
        //   "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        // challenge should be
        //   "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        assert_eq!(
            challenge_from_verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn build_authorize_url_percent_encodes_the_redirect() {
        let url = build_authorize_url(
            "CHAL",
            "STATE",
            "http://127.0.0.1:12345/callback",
            &["board:play"],
        )
        .unwrap();
        // The colon in redirect_uri and the colon in the scope must be
        // URL-encoded (%3A). reqwest::Url handles this via
        // parse_with_params; the test guards against a future rewrite
        // to hand-rolled formatting that skipped the encoding.
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2Fcallback"));
        assert!(url.contains("scope=board%3Aplay"));
        assert!(url.contains("code_challenge=CHAL"));
        assert!(url.contains("state=STATE"));
        assert!(url.contains("code_challenge_method=S256"));
    }

    #[test]
    fn build_authorize_url_joins_multiple_scopes_with_a_space() {
        let url =
            build_authorize_url("C", "S", "http://127.0.0.1:1/cb", &["bot:play", "challenge:write"])
                .unwrap();
        // Space is encoded as +. Both scopes and the separator round-trip.
        assert!(url.contains("scope=bot%3Aplay+challenge%3Awrite"));
    }

    #[test]
    fn parse_callback_extracts_code_and_state() {
        let result =
            parse_callback_request_line("GET /callback?code=abc&state=xyz HTTP/1.1").unwrap();
        assert_eq!(result.code, "abc");
        assert_eq!(result.state, "xyz");
    }

    #[test]
    fn parse_callback_handles_percent_encoded_values() {
        let result = parse_callback_request_line(
            "GET /callback?code=a%2Bb&state=%3F%3F HTTP/1.1",
        )
        .unwrap();
        assert_eq!(result.code, "a+b");
        assert_eq!(result.state, "??");
    }

    #[test]
    fn parse_callback_ignores_extra_params() {
        // Lichess may append fields we don't know about; skipping them
        // is friendlier than failing.
        let result = parse_callback_request_line(
            "GET /callback?code=abc&extra=ignored&state=xyz HTTP/1.1",
        )
        .unwrap();
        assert_eq!(result.code, "abc");
        assert_eq!(result.state, "xyz");
    }

    #[test]
    fn parse_callback_returns_error_when_user_hits_deny() {
        let err = parse_callback_request_line(
            "GET /callback?error=access_denied&state=xyz HTTP/1.1",
        )
        .unwrap_err();
        assert!(err.contains("access_denied"));
    }

    #[test]
    fn parse_callback_returns_error_when_code_or_state_missing() {
        assert!(parse_callback_request_line("GET /callback?code=abc HTTP/1.1").is_err());
        assert!(parse_callback_request_line("GET /callback?state=xyz HTTP/1.1").is_err());
        assert!(parse_callback_request_line("GET /callback HTTP/1.1").is_err());
        assert!(parse_callback_request_line("GET / HTTP/1.1").is_err());
    }

    #[test]
    fn parse_callback_returns_error_on_a_malformed_request_line() {
        assert!(parse_callback_request_line("").is_err());
        assert!(parse_callback_request_line("GARBAGE").is_err());
    }
}
