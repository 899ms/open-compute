//! Bounded durable workerd incident evidence.

use open_compute_core::{ErrorCode, PlatformError, StartupId};
use open_compute_runtime::{ProcessDiagnostics, supervisor::SanitizedExit};
use open_compute_storage::{atomic_write, ensure_dir_secure};
use serde::Serialize;
use sha2::{Digest as _, Sha256};
use std::path::{Path, PathBuf};

const MAX_TAIL_BYTES: usize = 16 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LastExit<'a> {
    schema_version: u32,
    timestamp_ms: i64,
    startup_id: StartupId,
    restart_reason: &'a str,
    exit_code: Option<i32>,
    signal: Option<i32>,
    reader_failed: bool,
    stdout_tail: &'a str,
    stderr_tail: &'a str,
    content_sha256: String,
    deployment_attribution: &'static str,
}

pub(crate) fn path(data_root: &Path) -> PathBuf {
    data_root.join("diagnostics/workerd/last-exit.json")
}

pub(crate) fn record(
    data_root: &Path,
    timestamp_ms: i64,
    startup_id: StartupId,
    exit: &SanitizedExit,
    diagnostics: &ProcessDiagnostics,
    attribution: &'static str,
) -> Result<(), PlatformError> {
    ensure_dir_secure(&data_root.join("diagnostics"))?;
    let directory = data_root.join("diagnostics/workerd");
    ensure_dir_secure(&directory)?;
    let stdout_tail = tail(&diagnostics.stdout_tail);
    let stderr_tail = tail(&diagnostics.stderr_tail);
    let mut digest = Sha256::new();
    digest.update(stdout_tail.as_bytes());
    digest.update([0]);
    digest.update(stderr_tail.as_bytes());
    let body = serde_json::to_vec_pretty(&LastExit {
        schema_version: 1,
        timestamp_ms,
        startup_id,
        restart_reason: &exit.code_name,
        exit_code: diagnostics.exit_code.or(exit.code),
        signal: diagnostics.signal.or(exit.signal),
        reader_failed: diagnostics.reader_failed,
        stdout_tail,
        stderr_tail,
        content_sha256: hex::encode(digest.finalize()),
        deployment_attribution: attribution,
    })
    .map_err(|_| invalid())?;
    atomic_write(&path(data_root), &body).map_err(|_| invalid())
}

fn tail(value: &str) -> &str {
    if value.len() <= MAX_TAIL_BYTES {
        return value;
    }
    let mut start = value.len() - MAX_TAIL_BYTES;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

fn invalid() -> PlatformError {
    PlatformError::new(
        ErrorCode::PathInvalid,
        "workerd incident diagnostics could not be persisted",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_exit_is_bounded_and_replaces_prior_evidence() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("diagnostics")).unwrap();
        let root = root.path().canonicalize().unwrap();
        let startup_id = StartupId::generate();
        let exit = SanitizedExit {
            code: Some(1),
            signal: None,
            retryable: true,
            code_name: "unexpected_exit".to_owned(),
        };
        record(
            &root,
            1,
            startup_id,
            &exit,
            &ProcessDiagnostics {
                stderr_tail: "x".repeat(MAX_TAIL_BYTES + 20),
                ..ProcessDiagnostics::default()
            },
            "unattributed",
        )
        .unwrap();
        let bytes = std::fs::read(path(&root)).unwrap();
        assert!(bytes.len() < MAX_TAIL_BYTES + 1_024);
        assert!(
            std::str::from_utf8(&bytes)
                .unwrap()
                .contains("unexpected_exit")
        );
    }
}
