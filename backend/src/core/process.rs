//! Cross-platform subprocess spawning tweaks.
//!
//! On Windows, `Command::spawn` gives every console-subsystem child (python,
//! yt-dlp, ffmpeg, uv…) its own console window — so each pipeline stage
//! flashes a black cmd window over the app. `CREATE_NO_WINDOW` suppresses
//! that; the child's stdio still works exactly as piped/nulled by the caller.
//! No-op on other platforms.

/// `CREATE_NO_WINDOW` — <https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags>
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Extension trait: hide the child's console window on Windows.
pub trait HideConsole {
    fn hide_console(&mut self) -> &mut Self;
}

impl HideConsole for tokio::process::Command {
    fn hide_console(&mut self) -> &mut Self {
        #[cfg(windows)]
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }
}
