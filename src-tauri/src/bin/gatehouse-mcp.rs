//! `gatehouse-mcp` — stdio ↔ Unix-socket proxy launched by MCP clients
//! (Decisions §4). The Gatehouse app must be running: it owns the socket.
//!
//! Env:
//! - `GATEHOUSE_TOKEN` (required): pairing token issued by Gatehouse Settings.
//! - `GATEHOUSE_SOCKET` (optional): socket path override.
//!
//! The token is sent once on a preamble line; afterwards the process is a
//! transparent byte pipe, so the MCP client speaks plain stdio transport.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::process::exit;

fn default_socket() -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|d| d.join("Gatehouse").join("gatehouse.sock"))
}

fn main() {
    let token = match std::env::var("GATEHOUSE_TOKEN") {
        Ok(t) if !t.is_empty() => t,
        _ => {
            eprintln!("gatehouse-mcp: GATEHOUSE_TOKEN is not set — pair this client in Gatehouse Settings → Agents and export the token.");
            exit(2);
        }
    };
    let path = std::env::var("GATEHOUSE_SOCKET")
        .map(std::path::PathBuf::from)
        .ok()
        .or_else(default_socket)
        .unwrap_or_else(|| {
            eprintln!("gatehouse-mcp: cannot resolve the socket path");
            exit(2);
        });
    let mut stream = match UnixStream::connect(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "gatehouse-mcp: cannot connect to {} ({e}) — is the Gatehouse app running?",
                path.display()
            );
            exit(1);
        }
    };
    let preamble = format!("{}\n", serde_json::json!({ "gatehouse_pairing": token }));
    if stream.write_all(preamble.as_bytes()).is_err() {
        eprintln!("gatehouse-mcp: pairing preamble failed");
        exit(1);
    }

    let mut sock_read = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("gatehouse-mcp: {e}");
            exit(1);
        }
    };
    // Exit as soon as either side closes: a refused pairing (server closes
    // the socket) or a departing MCP client (stdin EOF) must both end the
    // proxy instead of leaving it blocked on the other pipe.
    std::thread::spawn(move || {
        let _ = pipe(&mut std::io::stdin().lock(), &mut stream);
        exit(0);
    });
    let mut stdout = std::io::stdout().lock();
    let _ = pipe(&mut sock_read, &mut stdout);
    exit(0);
}

fn pipe(from: &mut impl Read, to: &mut impl Write) -> std::io::Result<()> {
    let mut buf = [0u8; 8192];
    loop {
        let n = from.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        to.write_all(&buf[..n])?;
        to.flush()?;
    }
}
