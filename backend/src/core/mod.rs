//! Business logic layer, free of axum/HTTP types (Tauri migration seam,
//! dsd.md §10). `http/` only translates HTTP requests into calls against
//! these modules.

pub mod doctor;
pub mod domain;
pub mod downloader;
pub mod pipeline;
pub mod process;
pub mod store;
