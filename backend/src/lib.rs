//! Library crate for the rj-player backend.
//!
//! The whole service is assembled here so the same `core/` business logic +
//! `http/` adapter can be driven two ways (dsd.md §13) from the *same* code —
//! this is what keeps the split frontend/backend deployment and the bundled
//! desktop app from diverging:
//!
//! - [`serve`] — the standalone [`main`](../main.rs) binary (web/dev, launched
//!   by `./dev.sh`): binds `127.0.0.1:<config.port>` and serves until Ctrl-C.
//! - [`serve_embedded`] — the Tauri desktop shell (dsd.md §13, B6.2): the shell
//!   binds its own `127.0.0.1:<random>` listener (so it knows the port up front
//!   for the WebView URL), hands it here, and owns the app lifecycle.
//!
//! Both go through [`build_app`], which assembles state, spawns the worker, and
//! builds the router (API + media + static `dist`). Neither path changes the
//! frontend: it always talks same-origin `/api` and `/media` to whichever
//! listener is serving it.

pub mod config;
mod core;
mod http;
mod state;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::Router;

pub use config::Config;

use crate::core::downloader::YtDlp;
use crate::core::pipeline::{job_channel, run_worker, EventHub, RpcClient};
use crate::core::store::FsStore;
use crate::state::AppState;

/// Handle to the running server's AI worker subprocess, used to shut it down
/// gracefully when the host (standalone binary or Tauri shell) exits. Wraps the
/// internal `RpcClient` so callers never depend on `core/` types — the public
/// API stays honest.
#[derive(Clone)]
pub struct WorkerHandle(Arc<RpcClient>);

impl WorkerHandle {
    /// Ask the AI worker subprocess (if one was ever spawned) to exit. No-op if
    /// the worker was never started (dsd.md §7).
    pub async fn shutdown(&self) {
        self.0.shutdown().await;
    }
}

/// Assemble the application: build shared state, spawn the single background
/// job worker, re-enqueue anything left `Queued` from a previous run, and build
/// the axum [`Router`] (API + media + static `dist` serving). Returns the
/// router and a [`WorkerHandle`] for graceful shutdown; the caller binds a
/// listener and serves the router itself.
pub async fn build_app(config: &Config) -> anyhow::Result<(Router, WorkerHandle)> {
    // Log the *resolved* config once, on whichever path assembled the app
    // (standalone bin or embedded Tauri shell) — so "what settings / which LLM
    // key is this actually running with?" is answerable from the log. Key
    // *values* are never logged; only whether each provider's key is present.
    tracing::info!(
        port = config.port,
        data_dir = %config.data_dir.display(),
        dist_dir = %config.dist_dir.display(),
        yt_dlp_path = %config.yt_dlp_path,
        ffmpeg_path = %config.ffmpeg_path,
        ai_python = %config.ai_python,
        ai_worker = %config.ai_worker,
        uv_path = ?config.uv_path,
        whisper_model = %config.whisper_model,
        whisper_temperature = config.whisper_temperature,
        llm_provider = ?config.llm_provider,
        gemini_key = config.gemini_api_key.as_deref().is_some_and(|k| !k.is_empty()),
        openai_key = config.openai_api_key.as_deref().is_some_and(|k| !k.is_empty()),
        anthropic_key = config.anthropic_api_key.as_deref().is_some_and(|k| !k.is_empty()),
        "resolved config",
    );

    let store = Arc::new(FsStore::new(config.data_dir.clone()));
    let event_hub = Arc::new(EventHub::new());
    let ytdlp = Arc::new(YtDlp::new(
        config.yt_dlp_path.clone(),
        config.ffmpeg_path.clone(),
        config.yt_dlp_format.clone(),
    ));
    // The AI worker (dsd.md §2, §3.3) is spawned lazily on first use by
    // `RpcClient` itself — nothing here starts a Python process yet. `with_env`
    // hands the worker the resolved `[llm]` settings (env, config.toml, or
    // neither) so `ai/pipeline/translate.py` sees them even when the user never
    // exported them before launch.
    let rpc = Arc::new(
        RpcClient::new(config.ai_python.clone(), config.ai_worker.clone())
            .with_env(config.llm_env_vars()),
    );
    let (job_tx, job_rx) = job_channel();

    // Single-worker job queue: exactly one background task consumes jobs
    // serially (dsd.md §8 — pipeline/download concurrency is intentionally
    // single-worker on this local, single-user tool).
    tokio::spawn(run_worker(
        job_rx,
        store.clone(),
        event_hub.clone(),
        ytdlp.clone(),
        rpc.clone(),
        config.whisper_model.clone(),
        config.whisper_temperature,
    ));

    let state = Arc::new(AppState {
        store,
        job_tx,
        event_hub,
        ytdlp: ytdlp.clone(),
        config: Arc::new(config.clone()),
        doctor_hub: Arc::new(crate::core::doctor::DoctorHub::new()),
    });

    requeue_leftover_jobs(&state).await;

    let app = crate::http::router::build_router(state, &config.dist_dir);
    Ok((app, WorkerHandle(rpc)))
}

/// Bind `127.0.0.1:<config.port>` and serve until Ctrl-C, shutting the AI
/// worker down gracefully on the way out. Entry point for the standalone
/// binary (`main.rs`).
pub async fn serve(config: Config) -> anyhow::Result<()> {
    config.ensure_dirs()?;
    let (app, worker) = build_app(&config).await?;

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), config.port);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(worker))
        .await?;

    Ok(())
}

/// Serve the assembled app on an already-bound loopback listener, as a
/// background task, returning the [`WorkerHandle`] for graceful shutdown. The
/// Tauri shell (dsd.md §13, B6.2) uses this: it binds `127.0.0.1:0` itself (so
/// the OS-assigned port is known before the WebView is created), passes the
/// std listener here, and drives the app lifecycle. The serve task runs until
/// the process exits or the runtime is torn down.
pub async fn serve_embedded(
    std_listener: std::net::TcpListener,
    config: &Config,
) -> anyhow::Result<WorkerHandle> {
    config.ensure_dirs()?;
    std_listener.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(std_listener)?;
    let addr = listener.local_addr()?;
    let (app, worker) = build_app(config).await?;
    tracing::info!(%addr, "embedded server listening");

    tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, app).await {
            tracing::error!(%err, "embedded axum server exited with error");
        }
    });

    Ok(worker)
}

/// Re-enqueue anything left `Queued` from a previous run (queue persistence):
/// the in-memory job channel is lost on shutdown, so videos accepted by
/// `POST /api/videos` but never picked up by the worker would otherwise sit
/// stuck at `status: queued` forever. On startup we scan `meta.json` (already
/// FIFO by `created_at`) and re-send a `Job::Download` for each —
/// `process_download_job` re-reads the originally-chosen
/// `queued_options`/`is_music_video` off disk, so they resume exactly as first
/// requested. Items caught mid-pipeline by the shutdown (a non-terminal,
/// non-`Queued` status) are intentionally left as-is. Best-effort: a scan
/// failure just logs and skips.
async fn requeue_leftover_jobs(state: &Arc<AppState>) {
    match state.store.list_meta().await {
        Ok(all) => {
            let mut requeued = 0usize;
            for meta in all
                .into_iter()
                .filter(|m| m.status == crate::core::domain::VideoStatus::Queued)
            {
                if state
                    .job_tx
                    .send(crate::core::pipeline::Job::Download {
                        video_id: meta.video_id.clone(),
                        url: meta.source_url,
                        auto_pipeline: true,
                    })
                    .await
                    .is_ok()
                {
                    requeued += 1;
                }
            }
            if requeued > 0 {
                tracing::info!(requeued, "re-enqueued queued videos left over from a previous run");
            }
        }
        Err(err) => {
            tracing::warn!(%err, "could not scan for queued videos to re-enqueue on startup");
        }
    }
}

/// Waits for Ctrl-C, then asks the AI worker subprocess (if one was ever
/// spawned) to exit gracefully before the server itself stops — the worker
/// process is otherwise independent of the backend's lifecycle (dsd.md §7),
/// but there's no reason to leave it running once nothing can talk to it.
async fn shutdown_signal(worker: WorkerHandle) {
    if tokio::signal::ctrl_c().await.is_err() {
        tracing::warn!("failed to install Ctrl-C handler; skipping graceful AI worker shutdown");
        return;
    }
    tracing::info!("shutdown signal received, stopping AI worker");
    worker.shutdown().await;
}
