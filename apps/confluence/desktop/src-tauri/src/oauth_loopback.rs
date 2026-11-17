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

pub const DONE_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>rsL Confluence Terminal</title></head><body><p>You can close this tab and return to rsL Confluence Terminal.</p></body></html>";

/// `GET <path>?<query> HTTP/1.1` -> (path, query). Only `/callback`, only GET, and a line of at most 8 KB.
pub fn parse_request_target(line: &str) -> Option<(String, String)> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.len() > MAX_LINE {
        return None;
    }
    let mut parts = line.split(' ');
    let (method, target, version) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || method != "GET" || !version.starts_with("HTTP/") {
        return None;
    }
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target, ""),
    };
    if path != "/callback" {
        return None;
    }
    Some((path.to_string(), query.to_string()))
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
}

/// First request line, read with a hard cap. None when the line is too long, not UTF-8 or never arrives.
fn read_request_line(stream: &mut TcpStream) -> Option<String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buf.contains(&b'\n') {
        if buf.len() > MAX_LINE + 2 {
            return None;
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    let end = buf.iter().position(|b| *b == b'\n').unwrap_or(buf.len());
    String::from_utf8(buf[..end].to_vec()).ok()
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
                let target = read_request_line(&mut stream).and_then(|line| parse_request_target(&line));
                match target {
                    None => respond(&mut stream, "404 Not Found", "Not found"),
                    Some((_, query)) if relay_fragment && query.is_empty() => respond(&mut stream, "200 OK", RELAY_PAGE),
                    Some((path, query)) => {
                        respond(&mut stream, "200 OK", DONE_PAGE);
                        return Ok(format!("{path}?{query}"));
                    }
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
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
    }
}
