//! ASIO compile + enumeration spike (Fase 1).
//!
//! The riskiest unknown for Windows ASIO support is whether cpal's `asio`
//! feature even BUILDS and LINKS against the Steinberg SDK on our toolchain —
//! before we write any recorder logic on top. This standalone example proves it
//! end to end: open the ASIO host, enumerate devices, and print each device's
//! channel counts + supported sample rates.
//!
//! Run on a Windows machine with an ASIO driver installed (ASIO4ALL is enough
//! for a smoke test) and the build env from `docs/BUILD_ASIO.md`:
//!
//! ```text
//! cargo run --example asio_spike --features asio
//! ```
//!
//! On macOS/Linux (or without `--features asio`) this prints a one-line notice
//! and exits 0 — the ASIO path is Windows-only by design, so the example must
//! still compile everywhere the workspace does.

#[cfg(all(target_os = "windows", feature = "asio"))]
#[allow(deprecated)] // cpal 0.17 deprecates `Device::name`; still the human device name we match against — same pattern as audio/asio.rs::imp.
fn main() {
    use cpal::traits::{DeviceTrait, HostTrait};

    // The Asio host id only exists when cpal is built with the `asio` feature.
    let host = match cpal::host_from_id(cpal::HostId::Asio) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("Could not open ASIO host: {e}");
            eprintln!("Is an ASIO driver installed? (ASIO4ALL works for testing.)");
            std::process::exit(1);
        }
    };

    println!("ASIO host opened: {}", host.id().name());

    let devices = match host.devices() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Could not enumerate ASIO devices: {e}");
            std::process::exit(1);
        }
    };

    let mut count = 0usize;
    for device in devices {
        count += 1;
        let name = device.name().unwrap_or_else(|_| "<unnamed>".to_string());
        println!("\n── Device: {name}");

        match device.supported_input_configs() {
            Ok(configs) => {
                let configs: Vec<_> = configs.collect();
                if configs.is_empty() {
                    println!("   inputs: (none reported)");
                }
                for cfg in &configs {
                    println!(
                        "   input  : {} ch, {}–{} Hz, {:?}",
                        cfg.channels(),
                        cfg.min_sample_rate(),
                        cfg.max_sample_rate(),
                        cfg.sample_format(),
                    );
                }
            }
            Err(e) => println!("   inputs: error reading configs: {e}"),
        }

        match device.supported_output_configs() {
            Ok(configs) => {
                for cfg in configs {
                    println!(
                        "   output : {} ch, {}–{} Hz, {:?}",
                        cfg.channels(),
                        cfg.min_sample_rate(),
                        cfg.max_sample_rate(),
                        cfg.sample_format(),
                    );
                }
            }
            Err(e) => println!("   outputs: error reading configs: {e}"),
        }
    }

    if count == 0 {
        eprintln!("\nNo ASIO devices found. Install an ASIO driver (ASIO4ALL) and retry.");
        std::process::exit(1);
    }
    println!("\nEnumerated {count} ASIO device(s). Spike OK.");
}

#[cfg(not(all(target_os = "windows", feature = "asio")))]
fn main() {
    println!(
        "asio_spike is a no-op here: the ASIO path is Windows-only and requires \
         `--features asio`. Build it on Windows with `cargo run --example \
         asio_spike --features asio` (see docs/BUILD_ASIO.md)."
    );
}
