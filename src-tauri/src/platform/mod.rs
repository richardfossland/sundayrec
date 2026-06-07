//! Platform-specific process hygiene.
//!
//! The church PC's Windows Audio service was crashing because force-quit / hung
//! SundayRec instances left ffmpeg sidecars running, each still holding the audio
//! device. `kill_on_drop(true)` on our spawns covers a *clean* shutdown, but NOT a
//! hard kill (Task Manager) — there the parent dies without running any `Drop`, so
//! the child is orphaned and keeps the device until it's killed by hand.
//!
//! [`guard_child_processes`] closes that hole on Windows by putting THIS process
//! into a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: child processes
//! inherit the job, and when the SundayRec process dies for ANY reason the OS
//! tears the whole job down — every ffmpeg child included. Off Windows it is a
//! no-op (macOS/Linux clean up process groups differently and aren't affected).

/// Put the current process in a kill-on-close Job Object so no ffmpeg child can
/// outlive SundayRec. Call ONCE, as early as possible at startup. Best-effort: any
/// failure is logged and ignored (we simply fall back to `kill_on_drop`).
pub fn guard_child_processes() {
    #[cfg(windows)]
    imp::guard_child_processes();
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    pub fn guard_child_processes() {
        // SAFETY: a self-contained sequence of Win32 calls with checked returns.
        // We intentionally LEAK the job handle: the job must outlive this call and
        // stay open for the whole process lifetime so it kills children at exit.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                tracing::warn!("orphan-guard: CreateJobObject failed — relying on kill_on_drop");
                return;
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(info) as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            // windows-sys returns a raw `BOOL` (i32); 0 = failure.
            if ok == 0 {
                tracing::warn!("orphan-guard: SetInformationJobObject failed");
                CloseHandle(job);
                return;
            }

            // Assign OURSELVES to the job; spawned children inherit membership.
            if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
                // Most likely cause: already in a job that forbids breakaway (rare on
                // Win10/11, which allow nested jobs). Fall back to kill_on_drop.
                tracing::warn!("orphan-guard: AssignProcessToJobObject failed — relying on kill_on_drop");
                CloseHandle(job);
                return;
            }
            // Deliberately do NOT `CloseHandle(job)`: the handle is intentionally
            // leaked so the job stays open for the whole process lifetime and
            // KILL_ON_JOB_CLOSE fires when we exit/die. (`job` is a Copy raw handle;
            // letting it go out of scope does nothing — the OS handle stays open.)
            tracing::info!("orphan-guard: process placed in kill-on-close Job Object");
        }
    }
}
