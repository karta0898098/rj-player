//! Standalone binary entry point (web/dev, launched by `./dev.sh`).
//!
//! All assembly lives in the library crate ([`rj_player_backend`]) so the
//! same server can also be embedded in a Tauri shell (dsd.md §13). This
//! binary just wires up logging, loads [`Config`], and hands off to
//! [`rj_player_backend::serve`].

use tracing_subscriber::EnvFilter;

use rj_player_backend::{serve, Config};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();

    let config = Config::load();
    tracing::info!(
        data_dir = %config.data_dir.display(),
        dist_dir = %config.dist_dir.display(),
        port = config.port,
        yt_dlp_path = %config.yt_dlp_path,
        whisper_model = %config.whisper_model,
        whisper_temperature = config.whisper_temperature,
        llm_provider = ?config.llm_provider,
        "config loaded"
    );

    serve(config).await
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,rj_player_backend=debug,tower_http=info"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .init();
}
