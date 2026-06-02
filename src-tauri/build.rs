fn main() {
    // Expose the build target triple to the crate so tests can locate the
    // fetched ffmpeg sidecar at `binaries/<name>-<triple>` (the suffix
    // scripts/fetch-ffmpeg.mjs uses). Cargo sets `TARGET` for build scripts.
    println!(
        "cargo:rustc-env=SUNDAYREC_TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap_or_default()
    );

    // Link AVFoundation on macOS so the camera/mic authorization query
    // (`media::permissions`) can resolve `AVCaptureDevice` at runtime. Without it
    // the class lookup returns `None` and we degrade to "Unknown" (proceed) — this
    // is what makes the TCC pre-check actually functional. `CARGO_CFG_TARGET_OS`
    // reflects the BUILD TARGET (unlike `cfg!`, which would read the host).
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-lib=framework=AVFoundation");
    }

    tauri_build::build()
}
