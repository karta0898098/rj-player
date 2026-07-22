//! `GET /api/doctor` — the self-check report (dsd.md §13.3). Thin adapter over
//! `core::doctor`; the first-run wizard and settings page consume this shape.

use axum::extract::State;
use axum::Json;

use crate::core::doctor::{self, DoctorReport};
use crate::state::SharedState;

pub async fn get_doctor(State(state): State<SharedState>) -> Json<DoctorReport> {
    Json(doctor::run(&state.config).await)
}
