use std::sync::Arc;

use crate::core::pipeline::{EventHub, JobSender};
use crate::core::store::FsStore;

/// Shared application state, cheaply cloneable via `Arc` (axum `State`
/// extractor requirement). Wires together the `core/` layer for `http/`
/// handlers. Matches dsd.md §2's `AppState { store, job_tx, event_hub }`.
pub struct AppState {
    pub store: Arc<FsStore>,
    pub job_tx: JobSender,
    pub event_hub: Arc<EventHub>,
}

pub type SharedState = Arc<AppState>;
