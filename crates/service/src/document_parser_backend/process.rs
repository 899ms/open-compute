//! Isolated parser child lifecycle, resource fencing, and bounded protocol I/O.

use open_compute_core::{ErrorCode, Redactor};
use open_compute_document_parser::MAX_OUTPUT_FRAME_BYTES;
use open_compute_runtime::{HostProcessSpec, VerifiedLaunchImage, run_host_process};
use sha2::{Digest as _, Sha256};
use std::ffi::OsString;
use std::fs::DirBuilder;
#[cfg(test)]
use std::fs::File;
use std::os::unix::fs::DirBuilderExt as _;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::time::Duration;
use uuid::Uuid;

pub(super) async fn run_parser_child(
    executable: &VerifiedLaunchImage,
    frame: Vec<u8>,
    deadline: Duration,
    max_stderr: usize,
    max_address_space_bytes: u64,
    max_cpu_seconds: u64,
) -> Result<Vec<u8>, ErrorCode> {
    let working_dir = ParserWorkingDirectory::create()?;
    match run_parser_image(
        executable,
        frame,
        deadline,
        max_stderr,
        max_address_space_bytes,
        max_cpu_seconds,
        working_dir.path(),
    )
    .await
    {
        Ok(output) => Ok(output),
        Err(failure) => {
            failure.report();
            Err(failure.error_code())
        }
    }
}

struct ParserWorkingDirectory {
    path: PathBuf,
}

impl ParserWorkingDirectory {
    fn create() -> Result<Self, ErrorCode> {
        let path =
            std::env::temp_dir().join(format!("open-compute-document-parser-{}", Uuid::now_v7()));
        let mut builder = DirBuilder::new();
        builder.mode(0o700);
        builder
            .create(&path)
            .map_err(|_| ErrorCode::DocumentUnavailable)?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ParserWorkingDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ParserFailureKind {
    #[cfg(test)]
    Spawn,
    InputIo,
    OutputIo,
    TimedOut,
    ProcessExited,
    StdoutLimit,
    StderrLimit,
}

impl ParserFailureKind {
    pub(super) const fn as_str(self) -> &'static str {
        match self {
            #[cfg(test)]
            Self::Spawn => "spawn",
            Self::InputIo => "input_io",
            Self::OutputIo => "output_io",
            Self::TimedOut => "timeout",
            Self::ProcessExited => "process_exit",
            Self::StdoutLimit => "stdout_limit",
            Self::StderrLimit => "stderr_limit",
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct ParserChildFailure {
    kind: ParserFailureKind,
    exit_code: Option<i32>,
    signal: Option<i32>,
    stdout_bytes: usize,
    stderr_bytes: usize,
    stderr_sha256: Option<[u8; 32]>,
}

impl ParserChildFailure {
    fn empty(kind: ParserFailureKind) -> Self {
        Self {
            kind,
            exit_code: None,
            signal: None,
            stdout_bytes: 0,
            stderr_bytes: 0,
            stderr_sha256: None,
        }
    }

    fn observed(
        kind: ParserFailureKind,
        status: Option<&ExitStatus>,
        output: &CapturedOutput,
    ) -> Self {
        Self {
            kind,
            exit_code: status.and_then(ExitStatus::code),
            signal: status.and_then(ExitStatusExt::signal),
            stdout_bytes: output.stdout.len(),
            stderr_bytes: output.stderr.len(),
            stderr_sha256: (!output.stderr.is_empty())
                .then(|| Sha256::digest(&output.stderr).into()),
        }
    }

    #[cfg(test)]
    pub(super) const fn kind(&self) -> ParserFailureKind {
        self.kind
    }

    #[cfg(test)]
    pub(super) const fn signal(&self) -> Option<i32> {
        self.signal
    }

    #[cfg(test)]
    pub(super) const fn exit_code(&self) -> Option<i32> {
        self.exit_code
    }

    const fn error_code(&self) -> ErrorCode {
        match self.kind {
            ParserFailureKind::TimedOut => ErrorCode::DocumentTimeout,
            ParserFailureKind::ProcessExited
            | ParserFailureKind::StdoutLimit
            | ParserFailureKind::StderrLimit => ErrorCode::DocumentProcessFailed,
            ParserFailureKind::InputIo | ParserFailureKind::OutputIo => {
                ErrorCode::DocumentUnavailable
            }
            #[cfg(test)]
            ParserFailureKind::Spawn => ErrorCode::DocumentUnavailable,
        }
    }

    fn report(&self) {
        let stderr_sha256 = self.stderr_sha256.map(hex::encode).unwrap_or_default();
        tracing::warn!(
            failure = self.kind.as_str(),
            exit_code = ?self.exit_code,
            signal = ?self.signal,
            stdout_bytes = self.stdout_bytes,
            stderr_bytes = self.stderr_bytes,
            stderr_sha256,
            "isolated document parser child failed"
        );
    }
}

#[derive(Debug)]
struct CapturedOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

async fn run_parser_image(
    executable: &VerifiedLaunchImage,
    frame: Vec<u8>,
    deadline: Duration,
    max_stderr: usize,
    max_address_space_bytes: u64,
    max_cpu_seconds: u64,
    working_dir: &Path,
) -> Result<Vec<u8>, ParserChildFailure> {
    let output = run_host_process(
        executable,
        HostProcessSpec {
            args: vec![
                OsString::from("__document-parser-v1"),
                OsString::from(max_address_space_bytes.to_string()),
                OsString::from(max_cpu_seconds.to_string()),
            ],
            environment: vec![
                (
                    OsString::from("XBERG_CACHE_DIR"),
                    working_dir.join("xberg-cache").into_os_string(),
                ),
                (
                    OsString::from("LLVM_PROFILE_FILE"),
                    OsString::from("/dev/null"),
                ),
            ],
            working_directory: working_dir.to_owned(),
            stdin: frame,
            deadline,
            max_stdout: MAX_OUTPUT_FRAME_BYTES,
            max_stderr,
            redactor: Redactor::new(),
        },
    )
    .await
    .map_err(|_| ParserChildFailure::empty(ParserFailureKind::OutputIo))?;
    let captured = CapturedOutput {
        stdout: output.stdout,
        stderr: output.stderr,
    };
    let failure = if output.timed_out {
        Some(ParserFailureKind::TimedOut)
    } else if output.stdout_overflow {
        Some(ParserFailureKind::StdoutLimit)
    } else if output.stderr_overflow {
        Some(ParserFailureKind::StderrLimit)
    } else if output.stdin_error {
        Some(ParserFailureKind::InputIo)
    } else if output.status.is_none_or(|status| !status.success()) {
        Some(ParserFailureKind::ProcessExited)
    } else {
        None
    };
    if let Some(kind) = failure {
        return Err(ParserChildFailure::observed(
            kind,
            output.status.as_ref(),
            &captured,
        ));
    }
    Ok(captured.stdout)
}

#[cfg(test)]
pub(super) async fn run_parser_child_inner(
    executable: &Path,
    frame: Vec<u8>,
    deadline: Duration,
    max_stderr: usize,
    max_address_space_bytes: u64,
    max_cpu_seconds: u64,
    working_dir: &Path,
) -> Result<Vec<u8>, ParserChildFailure> {
    let file =
        File::open(executable).map_err(|_| ParserChildFailure::empty(ParserFailureKind::Spawn))?;
    run_parser_image(
        &VerifiedLaunchImage::from_verified_file(file),
        frame,
        deadline,
        max_stderr,
        max_address_space_bytes,
        max_cpu_seconds,
        working_dir,
    )
    .await
}

#[cfg(test)]
pub(super) async fn run_parser_child_path(
    executable: &Path,
    frame: Vec<u8>,
    deadline: Duration,
    max_stderr: usize,
    max_address_space_bytes: u64,
    max_cpu_seconds: u64,
) -> Result<Vec<u8>, ErrorCode> {
    let working = ParserWorkingDirectory::create()?;
    run_parser_child_inner(
        executable,
        frame,
        deadline,
        max_stderr,
        max_address_space_bytes,
        max_cpu_seconds,
        working.path(),
    )
    .await
    .map_err(|failure| failure.error_code())
}
