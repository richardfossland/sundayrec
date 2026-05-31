//! Overlay compositor — pure ffmpeg `filter_complex` generation for lower-thirds.
//!
//! Ported from the Electron `src/main/overlay.ts` behaviour. Turns a list of
//! overlay configs into the additional `-i` input args + the `filter_complex`
//! fragment that composes them on top of the camera video BEFORE the stream
//! split (see [`crate::streaming::build_output_args`]).
//!
//! Scope for R3: the two lower-third source types that need no extra runtime —
//!   * **image** — a static PNG/JPG on disk (logo / lower-third graphic),
//!   * **text**  — a `drawtext` lower-third (title line ± subtitle).
//!
//! `screen`/`window`/`ndi` sources from the Electron app need a capture device
//! or the NDI runtime; those live behind the seam / `ndi` feature, not here. The
//! pure NDI *input-arg* builder (which IS pure) lives in [`crate::ndi`].
//!
//! Design constraints carried over from the Electron module:
//!   * The compose graph chains overlays: `[base][ov1]overlay→[c1]`,
//!     `[c1][ov2]overlay→[v_composed]`. The caller renames the final label.
//!   * Each image overlay becomes one additional `-i` input (text overlays add
//!     no input — `drawtext` runs on the base stream). The returned
//!     `extra_input_count` is what the audio-map math in `streaming` needs.
//!   * Positions resolve to ffmpeg `overlay=X:Y` expressions against output WxH;
//!     a margin proportional to height keeps corners from looking cramped.
//!
//! Everything is pure: no fs, no spawn. Image-source existence is the seam's
//! concern (it has the real path); here we only shape strings.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

// ── Public config types ───────────────────────────────────────────────────────

/// Placement preset — the 9-grid + fullscreen + free positioning, mirroring the
/// Electron `OverlayPosition`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/OverlayPosition.ts")]
#[serde(rename_all = "snake_case")]
pub enum OverlayPosition {
    Tl,
    Tc,
    Tr,
    Cl,
    C,
    Cr,
    Bl,
    Bc,
    Br,
    Fullscreen,
    /// Free position — `custom_x`/`custom_y` (fractions of output WxH) are used.
    Custom,
}

/// What feeds a lower-third overlay (the R3 subset).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/OverlaySource.ts")]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum OverlaySource {
    /// A static image file. `path` is absolute (the seam validates existence).
    Image { path: String },
    /// A `drawtext` lower-third: a title line and an optional subtitle.
    Text {
        title: String,
        #[serde(default)]
        subtitle: Option<String>,
    },
}

/// One overlay's configuration. Mirrors the non-capture subset of the Electron
/// `OverlayConfig`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/OverlayConfig.ts")]
#[serde(rename_all = "camelCase")]
pub struct OverlayConfig {
    pub id: String,
    pub name: String,
    /// Master on/off — disabled overlays are skipped in the graph.
    pub enabled: bool,
    pub source: OverlaySource,
    pub position: OverlayPosition,
    /// Only used when `position == Custom` — fractions of output WxH (0..1).
    #[serde(default)]
    pub custom_x: Option<f64>,
    #[serde(default)]
    pub custom_y: Option<f64>,
    /// Overlay width as a fraction of output width (0..1); height auto-scales.
    /// Forced to 1.0 for fullscreen. Default 0.3 when out of range.
    pub scale: f64,
    /// Final opacity 0..1 after any keying. Default 1.0.
    pub opacity: f64,
}

// ── Pipeline result ────────────────────────────────────────────────────────────

/// The overlay portion of the ffmpeg pipeline, ready to splice into the launch
/// argv. Mirrors the Electron `OverlayPipeline`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverlayPipeline {
    /// Additional `-i …` argument groups, one per IMAGE overlay (text adds none).
    pub input_args: Vec<String>,
    /// `filter_complex` fragment (no leading `;`). Empty when no overlays.
    pub filter_chain: String,
    /// Final composed-stream label the caller's downstream chain consumes. Equals
    /// `base_label` when nothing is enabled.
    pub output_label: String,
    /// Number of `-i` inputs added (= number of enabled IMAGE overlays). Drives
    /// the Windows audio-map math in [`crate::streaming`].
    pub extra_input_count: u32,
}

/// Options for [`build_overlay_pipeline`].
#[derive(Debug, Clone, Copy)]
pub struct BuildOverlayOpts<'a> {
    /// Output dimensions — positions resolve against these.
    pub output_w: u32,
    pub output_h: u32,
    /// Label of the camera video coming in (usually `"0:v"`).
    pub base_label: &'a str,
    /// Base framerate — static images match cadence with `-framerate`.
    pub framerate: u32,
}

// ── Builder ────────────────────────────────────────────────────────────────────

/// Build the overlay pipeline. Pure — image existence is the seam's job.
///
/// The first `-i` input index for overlays is 1 (the camera is 0). Text overlays
/// consume no input (they `drawtext` on the current label), so the input index
/// only advances for image overlays — exactly the bookkeeping the audio-map math
/// downstream relies on.
pub fn build_overlay_pipeline(
    overlays: &[OverlayConfig],
    opts: BuildOverlayOpts<'_>,
) -> OverlayPipeline {
    let enabled: Vec<&OverlayConfig> = overlays.iter().filter(|o| o.enabled).collect();

    if enabled.is_empty() {
        return OverlayPipeline {
            input_args: Vec::new(),
            filter_chain: String::new(),
            output_label: opts.base_label.to_string(),
            extra_input_count: 0,
        };
    }

    let mut input_args: Vec<String> = Vec::new();
    let mut format_chains: Vec<String> = Vec::new();
    let mut compose_steps: Vec<String> = Vec::new();

    let mut current_label = opts.base_label.to_string();
    // Image inputs start at index 1; text overlays don't add an input.
    let mut input_idx: u32 = 1;
    let mut compose_seq: u32 = 0;

    for ov in &enabled {
        match &ov.source {
            OverlaySource::Image { path } => {
                input_args.extend(image_input_args(path, opts.framerate));
                let (fragment, out_label) = image_overlay_chain(ov, input_idx, opts);
                format_chains.push(fragment);

                let composed = format!("vov{compose_seq}");
                let (x_expr, y_expr) = resolve_position(ov, opts.output_w, opts.output_h);
                compose_steps.push(format!(
                    "[{current_label}][{out_label}]overlay={x_expr}:{y_expr}:eof_action=pass:shortest=0:repeatlast=1[{composed}]"
                ));
                current_label = composed;
                input_idx += 1;
                compose_seq += 1;
            }
            OverlaySource::Text { title, subtitle } => {
                // drawtext runs on the current label and produces the next one;
                // no `-i` input is consumed.
                let composed = format!("vov{compose_seq}");
                let draw = drawtext_chain(
                    ov,
                    title,
                    subtitle.as_deref(),
                    opts,
                    &current_label,
                    &composed,
                );
                compose_steps.push(draw);
                current_label = composed;
                compose_seq += 1;
            }
        }
    }

    let filter_chain = format_chains
        .into_iter()
        .chain(compose_steps)
        .collect::<Vec<_>>()
        .join(";");
    let extra_input_count = input_idx - 1;

    OverlayPipeline {
        input_args,
        filter_chain,
        output_label: current_label,
        extra_input_count,
    }
}

// ── Image overlay ─────────────────────────────────────────────────────────────

/// `-loop 1` keeps producing frames from the still so it stays visible for the
/// whole stream; `-framerate` matches the base cadence.
fn image_input_args(path: &str, framerate: u32) -> Vec<String> {
    vec![
        "-loop".into(),
        "1".into(),
        "-framerate".into(),
        framerate.to_string(),
        "-i".into(),
        path.to_string(),
    ]
}

/// The per-image filter chain: scale → opacity/format → label. Returns the
/// fragment and the produced `[outLabel]`.
fn image_overlay_chain(
    ov: &OverlayConfig,
    input_idx: u32,
    opts: BuildOverlayOpts<'_>,
) -> (String, String) {
    let out_label = format!("ov{input_idx}");
    let mut steps: Vec<String> = Vec::new();
    let mut cursor = format!("{input_idx}:v");

    // Scale: fullscreen → output dims; else → fraction of output width, height
    // auto (`-2` forces even for libx264).
    let scale_frac = if matches!(ov.position, OverlayPosition::Fullscreen) {
        1.0
    } else {
        clamp01(if (0.0..=1.0).contains(&ov.scale) {
            ov.scale
        } else {
            0.3
        })
    };
    let target_w = (opts.output_w as f64 * scale_frac).round() as u32;
    let scale_h = if matches!(ov.position, OverlayPosition::Fullscreen) {
        opts.output_h.to_string()
    } else {
        "-2".to_string()
    };
    steps.push(format!("[{cursor}]scale={target_w}:{scale_h}[{cursor}s]"));
    cursor = format!("{cursor}s");

    // Opacity via format=rgba + colorchannelmixer=aa. Skip the no-op at full
    // opacity, but still force rgba so the overlay filter handles alpha uniformly.
    let op = clamp01(ov.opacity);
    if op < 0.999 {
        steps.push(format!(
            "[{cursor}]format=rgba,colorchannelmixer=aa={}[{cursor}a]",
            fmt_num(op)
        ));
        cursor = format!("{cursor}a");
    } else {
        steps.push(format!("[{cursor}]format=rgba[{cursor}f]"));
        cursor = format!("{cursor}f");
    }

    steps.push(format!("[{cursor}]null[{out_label}]"));
    (steps.join(";"), out_label)
}

// ── Text (drawtext) lower-third ─────────────────────────────────────────────────

/// Build a `drawtext` lower-third chain on `in_label` → `out_label`. The title
/// renders on a banner near the bottom; the optional subtitle sits beneath it.
/// Text is escaped for ffmpeg's filtergraph syntax. Opacity scales the font
/// alpha. Custom positions place the banner's top-left; presets default the
/// banner to the lower third.
fn drawtext_chain(
    ov: &OverlayConfig,
    title: &str,
    subtitle: Option<&str>,
    opts: BuildOverlayOpts<'_>,
    in_label: &str,
    out_label: &str,
) -> String {
    let h = opts.output_h;
    // Font sizes proportional to height: ~4% title, ~2.6% subtitle.
    let title_size = (h as f64 * 0.04).round().max(12.0) as u32;
    let sub_size = (h as f64 * 0.026).round().max(10.0) as u32;
    let alpha = fmt_num(clamp01(ov.opacity));

    // Where the title baseline sits. Presets put it in the lower third
    // (`h*0.78`); custom honours `custom_y`.
    let (title_x, title_y) = drawtext_anchor(ov, opts);

    let title_esc = escape_drawtext(title);
    let mut draw = format!(
        "[{in_label}]drawtext=text='{title_esc}':fontcolor=white@{alpha}:fontsize={title_size}:box=1:boxcolor=black@{box_alpha}:boxborderw=12:x={title_x}:y={title_y}",
        box_alpha = fmt_num(clamp01(ov.opacity) * 0.55),
    );

    if let Some(sub) = subtitle.filter(|s| !s.trim().is_empty()) {
        let sub_esc = escape_drawtext(sub);
        // Place the subtitle one title-height below the title.
        let sub_y = format!("{title_y}+{}", title_size + 14);
        draw.push_str(&format!(
            ",drawtext=text='{sub_esc}':fontcolor=white@{alpha}:fontsize={sub_size}:box=1:boxcolor=black@{box_alpha}:boxborderw=8:x={title_x}:y={sub_y}",
            box_alpha = fmt_num(clamp01(ov.opacity) * 0.45),
        ));
    }

    format!("{draw}[{out_label}]")
}

/// Where a text banner anchors. Returns ffmpeg `x`/`y` expressions. Presets map
/// to a left/centre/right column × top/lower-third/bottom row; custom uses the
/// fractions directly.
fn drawtext_anchor(ov: &OverlayConfig, opts: BuildOverlayOpts<'_>) -> (String, String) {
    let margin = margin_px(opts.output_h);
    if matches!(ov.position, OverlayPosition::Custom) {
        let x = clamp01(ov.custom_x.unwrap_or(0.0));
        let y = clamp01(ov.custom_y.unwrap_or(0.0));
        return (format!("w*{}", fmt_num(x)), format!("h*{}", fmt_num(y)));
    }
    // Horizontal column from the preset.
    let x = match ov.position {
        OverlayPosition::Tl | OverlayPosition::Cl | OverlayPosition::Bl => margin.to_string(),
        OverlayPosition::Tc | OverlayPosition::C | OverlayPosition::Bc | OverlayPosition::Fullscreen => {
            "(w-text_w)/2".to_string()
        }
        OverlayPosition::Tr | OverlayPosition::Cr | OverlayPosition::Br => {
            format!("w-text_w-{margin}")
        }
        OverlayPosition::Custom => margin.to_string(),
    };
    // Vertical row from the preset. The lower-third (`bc`/`bl`/`br`) lands at
    // ~78% height; centres at the middle; tops at the margin.
    let y = match ov.position {
        OverlayPosition::Tl | OverlayPosition::Tc | OverlayPosition::Tr => margin.to_string(),
        OverlayPosition::Cl | OverlayPosition::C | OverlayPosition::Cr | OverlayPosition::Fullscreen => {
            "(h-text_h)/2".to_string()
        }
        OverlayPosition::Bl | OverlayPosition::Bc | OverlayPosition::Br => "h*0.78".to_string(),
        OverlayPosition::Custom => "h*0.78".to_string(),
    };
    (x, y)
}

/// Escape a string for an ffmpeg `drawtext` `text='…'` value. ffmpeg's
/// filtergraph parsing treats `\`, `'`, `:`, `%` specially; we backslash-escape
/// them (and strip newlines, which would break the single-quoted token).
fn escape_drawtext(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            ':' => out.push_str("\\:"),
            '%' => out.push_str("\\%"),
            '\n' | '\r' => out.push(' '),
            _ => out.push(c),
        }
    }
    out
}

// ── Position helpers (image overlays) ────────────────────────────────────────

/// Resolve an IMAGE overlay's `overlay=X:Y` expressions against the output size.
/// Uses ffmpeg's `W/H` (main) and `w/h` (overlay) variables, mirroring the
/// Electron `POSITION_EXPR` table + margin.
fn resolve_position(ov: &OverlayConfig, _output_w: u32, output_h: u32) -> (String, String) {
    let margin = margin_px(output_h);
    if matches!(ov.position, OverlayPosition::Custom) {
        let x = clamp01(ov.custom_x.unwrap_or(0.0));
        let y = clamp01(ov.custom_y.unwrap_or(0.0));
        return (format!("W*{}", fmt_num(x)), format!("H*{}", fmt_num(y)));
    }
    let x = match ov.position {
        OverlayPosition::Tl | OverlayPosition::Cl | OverlayPosition::Bl => margin.to_string(),
        OverlayPosition::Tc | OverlayPosition::C | OverlayPosition::Bc => "(W-w)/2".to_string(),
        OverlayPosition::Tr | OverlayPosition::Cr | OverlayPosition::Br => {
            format!("W-w-{margin}")
        }
        OverlayPosition::Fullscreen => "0".to_string(),
        OverlayPosition::Custom => margin.to_string(),
    };
    let y = match ov.position {
        OverlayPosition::Tl | OverlayPosition::Tc | OverlayPosition::Tr => margin.to_string(),
        OverlayPosition::Cl | OverlayPosition::C | OverlayPosition::Cr => "(H-h)/2".to_string(),
        OverlayPosition::Bl | OverlayPosition::Bc | OverlayPosition::Br => {
            format!("H-h-{margin}")
        }
        OverlayPosition::Fullscreen => "0".to_string(),
        OverlayPosition::Custom => margin.to_string(),
    };
    (x, y)
}

/// Corner margin in pixels — ~3% of output height (≈32px @ 1080p), matching the
/// Electron `marginPx`.
fn margin_px(output_h: u32) -> u32 {
    (output_h as f64 * 0.03).round() as u32
}

fn clamp01(n: f64) -> f64 {
    if !n.is_finite() || n < 0.0 {
        0.0
    } else if n > 1.0 {
        1.0
    } else {
        n
    }
}

/// Format a number for an ffmpeg expression: 4 dp, trailing zeros stripped
/// (`0.1000` → `0.1`). Matches the Electron `fmtNum`.
fn fmt_num(n: f64) -> String {
    if !n.is_finite() {
        return "0".to_string();
    }
    let fixed = format!("{n:.4}");
    let trimmed = fixed.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(id: &str, path: &str, pos: OverlayPosition) -> OverlayConfig {
        OverlayConfig {
            id: id.into(),
            name: id.into(),
            enabled: true,
            source: OverlaySource::Image { path: path.into() },
            position: pos,
            custom_x: None,
            custom_y: None,
            scale: 0.3,
            opacity: 1.0,
        }
    }

    fn text(id: &str, title: &str, subtitle: Option<&str>, pos: OverlayPosition) -> OverlayConfig {
        OverlayConfig {
            id: id.into(),
            name: id.into(),
            enabled: true,
            source: OverlaySource::Text {
                title: title.into(),
                subtitle: subtitle.map(String::from),
            },
            position: pos,
            custom_x: None,
            custom_y: None,
            scale: 0.3,
            opacity: 1.0,
        }
    }

    fn opts() -> BuildOverlayOpts<'static> {
        BuildOverlayOpts {
            output_w: 1280,
            output_h: 720,
            base_label: "0:v",
            framerate: 30,
        }
    }

    // ── empty ──
    #[test]
    fn no_overlays_returns_base_label_untouched() {
        let p = build_overlay_pipeline(&[], opts());
        assert!(p.input_args.is_empty());
        assert_eq!(p.filter_chain, "");
        assert_eq!(p.output_label, "0:v");
        assert_eq!(p.extra_input_count, 0);
    }

    #[test]
    fn disabled_overlays_are_skipped() {
        let mut o = img("logo", "/x/logo.png", OverlayPosition::Br);
        o.enabled = false;
        let p = build_overlay_pipeline(&[o], opts());
        assert_eq!(p.output_label, "0:v");
        assert_eq!(p.extra_input_count, 0);
    }

    // ── single image ──
    #[test]
    fn single_image_builds_input_scale_and_compose() {
        let p = build_overlay_pipeline(&[img("logo", "/x/logo.png", OverlayPosition::Br)], opts());
        assert_eq!(
            p.input_args,
            vec![
                "-loop", "1", "-framerate", "30", "-i", "/x/logo.png"
            ]
        );
        assert_eq!(p.extra_input_count, 1);
        assert_eq!(p.output_label, "vov0");
        // scale to 0.3 × 1280 = 384, height auto (-2).
        assert!(p.filter_chain.contains("[1:v]scale=384:-2[1:vs]"));
        // full opacity → format=rgba (no colorchannelmixer).
        assert!(p.filter_chain.contains("format=rgba[1:vsf]"));
        assert!(!p.filter_chain.contains("colorchannelmixer"));
        // bottom-right compose: W-w-margin (margin = 22 @ 720p), H-h-22.
        assert!(p.filter_chain.contains(
            "[0:v][ov1]overlay=W-w-22:H-h-22:eof_action=pass:shortest=0:repeatlast=1[vov0]"
        ));
    }

    #[test]
    fn image_opacity_adds_colorchannelmixer() {
        let mut o = img("logo", "/x/l.png", OverlayPosition::Tl);
        o.opacity = 0.5;
        let p = build_overlay_pipeline(&[o], opts());
        assert!(p
            .filter_chain
            .contains("format=rgba,colorchannelmixer=aa=0.5[1:vsa]"));
    }

    #[test]
    fn fullscreen_image_scales_to_output_dims_at_origin() {
        let p = build_overlay_pipeline(
            &[img("bg", "/x/bg.png", OverlayPosition::Fullscreen)],
            opts(),
        );
        assert!(p.filter_chain.contains("[1:v]scale=1280:720[1:vs]"));
        assert!(p.filter_chain.contains("overlay=0:0:"));
    }

    #[test]
    fn custom_position_uses_fraction_expressions() {
        let mut o = img("logo", "/x/l.png", OverlayPosition::Custom);
        o.custom_x = Some(0.25);
        o.custom_y = Some(0.8);
        let p = build_overlay_pipeline(&[o], opts());
        assert!(p.filter_chain.contains("overlay=W*0.25:H*0.8:"));
    }

    // ── two image overlays chain ──
    #[test]
    fn two_images_chain_and_advance_input_index() {
        let p = build_overlay_pipeline(
            &[
                img("a", "/x/a.png", OverlayPosition::Tl),
                img("b", "/x/b.png", OverlayPosition::Br),
            ],
            opts(),
        );
        assert_eq!(p.extra_input_count, 2);
        assert_eq!(p.output_label, "vov1");
        // second overlay uses input index 2.
        assert!(p.filter_chain.contains("[2:v]scale="));
        // compose chains base → vov0 → vov1.
        assert!(p.filter_chain.contains("[0:v][ov1]overlay=") );
        assert!(p.filter_chain.contains("[vov0][ov2]overlay="));
    }

    // ── text lower-third ──
    #[test]
    fn text_overlay_adds_no_input_and_uses_drawtext() {
        let p = build_overlay_pipeline(
            &[text("lt", "Pastor Ola", Some("Søndagsgudstjeneste"), OverlayPosition::Bl)],
            opts(),
        );
        // text consumes no -i input.
        assert!(p.input_args.is_empty());
        assert_eq!(p.extra_input_count, 0);
        assert_eq!(p.output_label, "vov0");
        assert!(p.filter_chain.contains("drawtext=text='Pastor Ola'"));
        assert!(p.filter_chain.contains("drawtext=text='Søndagsgudstjeneste'"));
        // bottom-left → x = margin (22), title y = lower third.
        assert!(p.filter_chain.contains(":x=22:y=h*0.78"));
        // box behind text for legibility.
        assert!(p.filter_chain.contains("box=1"));
        assert!(p.filter_chain.contains("[vov0]"));
    }

    #[test]
    fn text_without_subtitle_emits_single_drawtext() {
        let p =
            build_overlay_pipeline(&[text("lt", "Velkommen", None, OverlayPosition::Bc)], opts());
        let count = p.filter_chain.matches("drawtext=").count();
        assert_eq!(count, 1);
        // bottom-centre → x centred on text width.
        assert!(p.filter_chain.contains("x=(w-text_w)/2"));
    }

    #[test]
    fn drawtext_escapes_special_characters() {
        let p = build_overlay_pipeline(
            &[text("lt", "A: 100% \\ 'quote'", None, OverlayPosition::Bl)],
            opts(),
        );
        // colon, percent, backslash, single-quote all escaped.
        assert!(p.filter_chain.contains("A\\: 100\\% \\\\ \\'quote\\'"));
    }

    #[test]
    fn text_opacity_scales_font_and_box_alpha() {
        let mut o = text("lt", "Hi there", None, OverlayPosition::Bl);
        o.opacity = 0.8;
        let p = build_overlay_pipeline(&[o], opts());
        assert!(p.filter_chain.contains("fontcolor=white@0.8"));
        // box alpha = 0.8 × 0.55 = 0.44.
        assert!(p.filter_chain.contains("boxcolor=black@0.44"));
    }

    // ── mixed image + text: input index only advances for image ──
    #[test]
    fn mixed_text_then_image_keeps_image_at_input_one() {
        let p = build_overlay_pipeline(
            &[
                text("lt", "Title", None, OverlayPosition::Bc),
                img("logo", "/x/l.png", OverlayPosition::Tr),
            ],
            opts(),
        );
        assert_eq!(p.extra_input_count, 1);
        // image is the FIRST (only) input → index 1, even though text came first.
        assert!(p.filter_chain.contains("[1:v]scale="));
        // compose seq: text → vov0, then image overlays vov0 → vov1.
        assert_eq!(p.output_label, "vov1");
        assert!(p.filter_chain.contains("[vov0][ov1]overlay="));
    }

    // ── helpers ──
    #[test]
    fn margin_is_three_percent_of_height() {
        assert_eq!(margin_px(1080), 32);
        assert_eq!(margin_px(720), 22);
    }

    #[test]
    fn fmt_num_strips_trailing_zeros() {
        assert_eq!(fmt_num(0.1), "0.1");
        assert_eq!(fmt_num(0.5000), "0.5");
        assert_eq!(fmt_num(1.0), "1");
        assert_eq!(fmt_num(f64::NAN), "0");
    }

    #[test]
    fn clamp01_bounds_and_handles_nan() {
        assert_eq!(clamp01(-1.0), 0.0);
        assert_eq!(clamp01(2.0), 1.0);
        assert_eq!(clamp01(0.4), 0.4);
        assert_eq!(clamp01(f64::NAN), 0.0);
    }
}
