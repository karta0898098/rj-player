mod config;
mod core;
mod http;
mod state;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::core::downloader::YtDlp;
use crate::core::pipeline::{job_channel, run_worker, EventHub, RpcClient};
use crate::core::store::FsStore;
use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();

    let config = Config::load();
    config.ensure_dirs()?;
    tracing::info!(
        data_dir = %config.data_dir.display(),
        port = config.port,
        yt_dlp_path = %config.yt_dlp_path,
        whisper_model = %config.whisper_model,
        whisper_temperature = config.whisper_temperature,
        llm_provider = ?config.llm_provider,
        "config loaded"
    );

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
    // when the user never exported them before `cargo run`.
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

    let app = http::router::build_router(state.clone());

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), config.port);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(rpc))
        .await?;

    Ok(())
}

/// Waits for Ctrl-C, then asks the AI worker subprocess (if one was ever
/// spawned) to exit gracefully before the server itself stops — the worker
/// process is otherwise independent of the backend's lifecycle (dsd.md §7),
/// but there's no reason to leave it running once nothing can talk to it.
async fn shutdown_signal(rpc: Arc<core::pipeline::RpcClient>) {
    if tokio::signal::ctrl_c().await.is_err() {
        tracing::warn!("failed to install Ctrl-C handler; skipping graceful AI worker shutdown");
        return;
    }
    tracing::info!("shutdown signal received, stopping AI worker");
    rpc.shutdown().await;
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,rj_player_backend=debug,tower_http=info"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .init();
}
