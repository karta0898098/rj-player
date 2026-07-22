//! Library crate for the rj-player backend.
//!
//! The whole service is assembled here behind [`serve`] so the same `core/`
//! business logic + `http/` adapter can be driven two ways (dsd.md §13):
//!
//! - the standalone [`main`](../main.rs) binary — web/dev, launched by
//!   `./dev.sh`; and
//! - a future Tauri shell (dsd.md §13, B6.2) that embeds the server as a
//!   background task bound to `127.0.0.1:<random port>`.
//!
//! The Tauri seam is [`build_app`]: it returns the ready-to-serve router plus
//! the [`RpcClient`] handle (for graceful AI-worker shutdown), leaving the
//! caller to bind its own listener. The standalone binary goes through
//! [`serve`], which binds `127.0.0.1:<config.port>` and serves until Ctrl-C.

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

/// Assemble the application: build shared state, spawn the single background
/// job worker, re-enqueue anything left `Queued` from a previous run, and
/// build the axum [`Router`] (API + media + static `dist` serving). Returns
/// the router and the [`RpcClient`] handle needed to shut the AI worker down
/// gracefully; the caller binds a listener and serves the router itself.
///
/// This is the seam the Tauri shell (dsd.md §13, B6.2) uses to run the server
/// on its own listener. The standalone binary goes through [`serve`].
pub async fn build_app(config: &Config) -> anyhow::Result<(Router, Arc<RpcClient>)> {
    let store = Arc::new(FsStore::new(config.data_dir.clone()));
    let event_hub = Arc::new(EventHub::new());
    let ytdlp = Arc::new(YtDlp::new(
        config.yt_dlp_path.clone(),
        config.ffmpeg_path.clone(),
        config.yt_dlp_format.clone(),
    ));
    // The AI worker (dsd.md §2, §3.3) is spawned lazily on first use by
    // `RpcClient` itself — nothing here starts a Python process yet.
    // `with_env` hands the worker the resolved `[llm]` settings (env,
    // config.toml, or neither) so `ai/pipeline/translate.py` sees them even
    // when the user never exported them before launch.
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
    });

    requeue_leftover_jobs(&state).await;

    let app = crate::http::router::build_router(state, &config.dist_dir);
    Ok((app, rpc))
}

/// Bind `127.0.0.1:<config.port>` and serve until Ctrl-C, shutting the AI
/// worker down gracefully on the way out. Entry point for the standalone
/// binary (`main.rs`).
pub async fn serve(config: Config) -> anyhow::Result<()> {
    config.ensure_dirs()?;
    let (app, rpc) = build_app(&config).await?;

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), config.port);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(rpc))
        .await?;

    Ok(())
}

/// Re-enqueue anything left `Queued` from a previous run (queue persistence):
/// the in-memory job channel is lost on shutdown, so videos accepted by
/// `POST /api/videos` but never picked up by the worker would otherwise sit
/// stuck at `status: queued` forever. On startup we scan `meta.json` (already
/// FIFO by `created_at`) and re-send a `Job::Download` for each —
/// `process_download_job` re-reads the originally-chosen
/// `queued_options`/`is_music_video` off disk, so they resume exactly as
/// first requested. Items caught mid-pipeline by the shutdown (a non-terminal,
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
async fn shutdown_signal(rpc: Arc<RpcClient>) {
    if tokio::signal::ctrl_c().await.is_err() {
        tracing::warn!("failed to install Ctrl-C handler; skipping graceful AI worker shutdown");
        return;
    }
    tracing::info!("shutdown signal received, stopping AI worker");
    rpc.shutdown().await;
}
