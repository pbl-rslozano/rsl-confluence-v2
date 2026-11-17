//! Desktop OAuth loopback listener (WP28 Task 6). std only, so `rustc --edition 2021 --test` builds it alone.
//!
//! Binds 127.0.0.1 only (never 0.0.0.0), serves only `/callback`, and drops the listener on every exit path
//! because `wait` owns it. Request lines are capped at 8 KB. No request data is ever written into a page.

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub const PORT: u16 = 48787;
const MAX_LINE: usize = 8 * 1024;

/// pCloud's token flow returns the token in the URL fragment, which a server never sees. This fixed page
/// moves the fragment into the query. Its only script is the one line below.
pub const RELAY_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>rsL Confluence Terminal</title></head><body><p>rsL Confluence Terminal: finishing sign-in...</p><script>location.replace('/callback?' + location.hash.slice(1))</script></body></html>";

/// Its one script scrubs the token-bearing query from the browser's current history entry.
pub const DONE_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>rsL Confluence Terminal</title></head><body><p>You can close this tab and return to rsL Confluence Terminal.</p><script>history.replaceState(null,'','/callback')</script></body></html>";

/// `GET <path>?<query> HTTP/1.1` -> (path, query). Only `/callback`, only GET, and a line of at most 8 KB.
#[allow(dead_code)] // the public form of `parse_target`; exercised by the tests
pub fn parse_request_target(line: &str) -> Option<(String, String)> {
    parse_target(line).map(|(p, q, _)| (p, q))
}

/// Like `parse_request_target`, plus whether the target contained a `?` (an empty query still counts).
fn parse_target(line: &str) -> Option<(String, String, bool)> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.len() > MAX_LINE {
        return None;
    }
    let mut parts = line.split(' ');
    let (method, target, version) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || method != "GET" || !version.starts_with("HTTP/") {
        return None;
    }
    let (path, query, has_query) = match target.split_once('?') {
        Some((p, q)) => (p, q, true),
        None => (target, "", false),
    };
    if path != "/callback" {
        return None;
    }
    Some((path.to_string(), query.to_string(), has_query))
}

pub fn bind() -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", PORT)).map_err(|e| {
        if e.kind() == ErrorKind::AddrInUse {
            "port-busy".to_string()
        } else {
            "bind-failed".to_string()
        }
    })
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Write);
}

const CONN_DEADLINE: Duration = Duration::from_secs(5);
const MAX_HEAD: usize = 16 * 1024;

enum Head {
    /// The first request line; the headers were read to the blank line and discarded.
    Line(String),
    Bad,
    Stop(&'static str),
}

/// Read the request line, then discard the headers up to the blank line (so closing does not reset the
/// connection). Capped at 16 KB in total, within the per-connection and the overall deadline, checking
/// `cancelled` between reads.
fn read_head(stream: &mut TcpStream, overall: Instant, cancelled: &AtomicBool) -> Head {
    let conn = Instant::now() + CONN_DEADLINE;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Head::Stop("cancelled");
        }
        let now = Instant::now();
        if now >= overall {
            return Head::Stop("timeout");
        }
        if now >= conn {
            return Head::Bad;
        }
        if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.windows(2).any(|w| w == b"\n\n") {
            break;
        }
        if buf.len() >= MAX_HEAD {
            return Head::Bad;
        }
        let slice = (conn.min(overall) - now).min(Duration::from_millis(100));
        let _ = stream.set_read_timeout(Some(slice.max(Duration::from_millis(1))));
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted) => {}
            Err(_) => return Head::Bad,
        }
    }
    let end = buf.iter().position(|b| *b == b'\n').unwrap_or(buf.len());
    match String::from_utf8(buf[..end].to_vec()) {
        Ok(l) => Head::Line(l),
        Err(_) => Head::Bad,
    }
}

/// Wait for the redirect. Owns the listener, so it is closed on every return path.
pub fn wait(l: TcpListener, timeout: Duration, relay_fragment: bool, cancelled: &AtomicBool) -> Result<String, String> {
    l.set_nonblocking(true).map_err(|_| "io".to_string())?;
    let deadline = Instant::now() + timeout;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err("cancelled".to_string());
        }
        if Instant::now() >= deadline {
            return Err("timeout".to_string());
        }
        match l.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let line = match read_head(&mut stream, deadline, cancelled) {
                    Head::Line(l) => l,
                    Head::Bad => {
                        respond(&mut stream, "404 Not Found", "Not found");
                        continue;
                    }
                    Head::Stop(why) => return Err(why.to_string()),
                };
                match parse_target(&line) {
                    None => respond(&mut stream, "404 Not Found", "Not found"),
                    // Only a bare /callback (no `?`) gets the relay page; any `?`, even empty, is final.
                    Some((_, _, false)) if relay_fragment => respond(&mut stream, "200 OK", RELAY_PAGE),
                    Some((path, query, _)) => {
                        respond(&mut stream, "200 OK", DONE_PAGE);
                        return Ok(format!("{path}?{query}"));
                    }
                }
            }
            // A reset or aborted connection (a local process can cause one on Windows) must not end the sign-in.
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::ConnectionReset | ErrorKind::ConnectionAborted | ErrorKind::Interrupted) => {
                std::thread::sleep(Duration::from_millis(100))
            }
            Err(_) => return Err("io".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::sync::atomic::AtomicBool;
    use std::thread;
    use std::time::Duration;

    fn get(path: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", PORT)).unwrap();
        write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    }

    #[test]
    fn done_page_scrubs_history_and_echoes_nothing() {
        assert!(DONE_PAGE.contains("<script>history.replaceState(null,'','/callback')</script>"));
        assert_eq!(DONE_PAGE.matches("<script").count(), 1);
        assert!(DONE_PAGE.contains("You can close this tab and return to rsL Confluence Terminal."));
        assert!(!DONE_PAGE.contains('?') && !DONE_PAGE.contains("access_token") && !DONE_PAGE.contains("state"));
    }

    #[test]
    fn parses_only_callback() {
        assert_eq!(parse_request_target("GET /callback?code=a&state=b HTTP/1.1"), Some(("/callback".into(), "code=a&state=b".into())));
        assert_eq!(parse_request_target("GET /callback HTTP/1.1"), Some(("/callback".into(), String::new())));
        assert_eq!(parse_request_target("GET /favicon.ico HTTP/1.1"), None);
        assert_eq!(parse_request_target("POST /callback?a=b HTTP/1.1"), None);
        let long = format!("GET /callback?{} HTTP/1.1", "a".repeat(9 * 1024));
        assert_eq!(parse_request_target(&long), None);
    }

    // The tests share port 48787, so they run in one sequence.
    #[test]
    fn listener_lifecycle() {
        // busy
        let held = bind().unwrap();
        assert_eq!(bind().err().as_deref(), Some("port-busy"));
        drop(held);

        // timeout, then the port is free again
        let l = bind().unwrap();
        let c = AtomicBool::new(false);
        assert_eq!(wait(l, Duration::from_millis(300), false, &c), Err("timeout".to_string()));
        drop(bind().unwrap());

        // cancelled
        let l = bind().unwrap();
        let c = AtomicBool::new(true);
        assert_eq!(wait(l, Duration::from_secs(5), false, &c), Err("cancelled".to_string()));
        drop(bind().unwrap());

        // other paths 404; relay page, then the query; the query is not echoed
        let l = bind().unwrap();
        let t = thread::spawn(move || {
            let c = AtomicBool::new(false);
            wait(l, Duration::from_secs(5), true, &c)
        });
        assert!(get("/other").starts_with("HTTP/1.1 404"));
        let relay = get("/callback");
        assert!(relay.contains("location.hash"));
        assert!(relay.contains("Cache-Control: no-store"));
        assert!(relay.contains("Referrer-Policy: no-referrer"));
        let done = get("/callback?access_token=t&state=s");
        assert!(done.contains("You can close this tab"));
        assert!(!done.contains("access_token"));
        assert_eq!(t.join().unwrap(), Ok("/callback?access_token=t&state=s".to_string()));
        drop(bind().unwrap());

        // an empty query is final, even with relay on (no relay loop)
        let l = bind().unwrap();
        let t = thread::spawn(move || wait(l, Duration::from_secs(5), true, &AtomicBool::new(false)));
        assert!(get("/callback?").contains("You can close this tab"));
        assert_eq!(t.join().unwrap(), Ok("/callback?".to_string()));

        // long headers (over 1 KB) still receive the full page
        let l = bind().unwrap();
        let t = thread::spawn(move || wait(l, Duration::from_secs(5), false, &AtomicBool::new(false)));
        let mut s = TcpStream::connect(("127.0.0.1", PORT)).unwrap();
        write!(s, "GET /callback?code=a&state=b HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Pad: {}\r\n\r\n", "p".repeat(6000)).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        assert!(out.starts_with("HTTP/1.1 200") && out.contains("You can close this tab"));
        assert_eq!(t.join().unwrap(), Ok("/callback?code=a&state=b".to_string()));

        // a byte-at-a-time client cannot hold the listener past the timeout
        let l = bind().unwrap();
        let start = std::time::Instant::now();
        let t = thread::spawn(move || wait(l, Duration::from_secs(1), false, &AtomicBool::new(false)));
        let slow = thread::spawn(|| {
            let mut s = TcpStream::connect(("127.0.0.1", PORT)).unwrap();
            for _ in 0..40 {
                if s.write_all(b"G").is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        });
        assert_eq!(t.join().unwrap(), Err("timeout".to_string()));
        assert!(start.elapsed() < Duration::from_millis(1600), "took {:?}", start.elapsed());
        slow.join().unwrap();
        drop(bind().unwrap());
    }
}
