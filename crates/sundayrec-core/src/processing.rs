//! Podcast signal processing — channel repair + a configurable vocal chain.
//!
//! Pure, deterministic ffmpeg *filter-string builders*. No I/O: every function
//! takes a config and returns the `-af`/`filter_complex` fragments the editor
//! seam concatenates and hands to ffmpeg (exactly like [`crate::mastering`]).
//! That keeps the whole signal-path testable without touching media.
//!
//! Two concerns live here:
//!
//! 1. **Channel repair** ([`ChannelRepair`]) — fix a recording where the two
//!    channels are wrong: a hard-panned source, two inputs at mismatched gain,
//!    or a dead/noisy channel from a bad cable. [`diagnose_channels`] looks at
//!    the measured per-channel peak/RMS and *recommends* a repair (including the
//!    "one channel is dead → duplicate the good one into stereo" case the user
//!    asked for), and [`channel_repair_filter`] renders it to a `pan=` filter.
//!
//! 2. **Vocal chain** ([`VocalChain`]) — the post-capture cleanup/sweetening
//!    stages a producer reaches for on a spoken-word track, in the canonical
//!    order (HPF → denoise → de-reverb → gate → EQ → compressor → de-esser →
//!    limiter → makeup gain). Each stage is independently toggleable with its
//!    own parameters and sane podcast defaults; disabled stages emit nothing.
//!    [`VocalChain::build_filters`] returns the ordered, non-empty fragments.
//!
//! The final loudness stage is intentionally NOT here — loudness normalisation
//! is [`crate::mastering`]'s two-pass `loudnorm`, appended *after* this chain by
//! the export seam. This module shapes the tone/dynamics; mastering sets the
//! delivery loudness.

// ── helpers ─────────────────────────────────────────────────────────────────

/// dBFS → linear amplitude multiplier (`10^(db/20)`).
fn db_to_linear(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

/// Format a coefficient for a `pan` expression — 3 decimals, trailing zeros
/// trimmed, so `1.0 → "1"`, `0.5 → "0.5"`, `1.4125 → "1.413"`. Keeps the filter
/// strings stable and readable (and the unit tests exact).
fn coef(v: f64) -> String {
    let s = format!("{v:.3}");
    let trimmed = s.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() || trimmed == "-" {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

// ── channel repair ──────────────────────────────────────────────────────────

/// How to repair the channel layout of a recording. Produced by the UI (manual
/// pick) or by [`diagnose_channels`] (auto recommendation), rendered to a `pan`
/// filter by [`channel_repair_filter`].
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum ChannelRepair {
    /// Leave the channels as-is.
    #[default]
    None,
    /// Swap left and right (mis-wired inputs).
    SwapLr,
    /// Use the LEFT channel for both outputs (right is dead/noisy — bad cable).
    DuplicateLeft,
    /// Use the RIGHT channel for both outputs (left is dead/noisy — bad cable).
    DuplicateRight,
    /// Sum both channels to a centred dual-mono (a single source bled across
    /// both, or you simply want mono delivered as stereo).
    MonoMix,
    /// Independent per-channel makeup in dB — the balance fix for a hard-panned
    /// or gain-mismatched stereo pair. `0.0/0.0` is a no-op.
    GainDb { left_db: f64, right_db: f64 },
}

/// Build the `pan` filter for a channel repair, or `None` when nothing to do.
/// All variants emit a stereo output so the downstream chain/encoder sees a
/// consistent layout. `GainDb` clamps each leg to ±24 dB to keep a runaway
/// auto-balance from exploding noise.
pub fn channel_repair_filter(repair: ChannelRepair) -> Option<String> {
    match repair {
        ChannelRepair::None => None,
        ChannelRepair::SwapLr => Some("pan=stereo|c0=c1|c1=c0".to_string()),
        ChannelRepair::DuplicateLeft => Some("pan=stereo|c0=c0|c1=c0".to_string()),
        ChannelRepair::DuplicateRight => Some("pan=stereo|c0=c1|c1=c1".to_string()),
        ChannelRepair::MonoMix => Some("pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1".to_string()),
        ChannelRepair::GainDb { left_db, right_db } => {
            let l = db_to_linear(left_db.clamp(-24.0, 24.0));
            let r = db_to_linear(right_db.clamp(-24.0, 24.0));
            // A no-op (both ~unity) needs no filter.
            if (l - 1.0).abs() < 1e-3 && (r - 1.0).abs() < 1e-3 {
                None
            } else {
                Some(format!("pan=stereo|c0={}*c0|c1={}*c1", coef(l), coef(r)))
            }
        }
    }
}

/// Measured per-channel levels (dBFS) feeding [`diagnose_channels`]. Peaks are
/// required (from `astats`/`levels`); RMS is optional and, when present,
/// preferred for the imbalance magnitude (peaks are spikier).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChannelLevelsDb {
    pub peak_left_db: f64,
    pub peak_right_db: f64,
    pub rms_left_db: Option<f64>,
    pub rms_right_db: Option<f64>,
}

/// The outcome of analysing a stereo recording's channel balance.
#[derive(Debug, Clone, PartialEq)]
pub struct ChannelDiagnosis {
    /// The recommended repair to apply.
    pub recommended: ChannelRepair,
    /// A stable machine code for the situation (for i18n / tests):
    /// `balanced` | `imbalance` | `dead_left` | `dead_right` | `both_dead`.
    pub code: &'static str,
    /// Left − right level difference in dB (positive = left louder). Uses RMS
    /// when both RMS values are present, else peak.
    pub imbalance_db: f64,
}

/// A channel quieter than this (dBFS) while the other is healthy is treated as
/// "dead" — a pulled/!broken cable, not a quiet mix.
const DEAD_FLOOR_DB: f64 = -45.0;
/// The other channel must be at least this loud for the quiet one to count as
/// "dead" rather than "both quiet" (a genuinely soft passage).
const HEALTHY_DB: f64 = -30.0;
/// Below this absolute imbalance we call the pair balanced and recommend no fix.
const BALANCE_TOLERANCE_DB: f64 = 3.0;
/// The largest auto-balance makeup we'll suggest, so balancing a near-dead
/// channel can't lift its noise floor into the mix.
const MAX_AUTO_MAKEUP_DB: f64 = 12.0;

/// Diagnose a stereo recording's channel balance and recommend a repair.
///
/// The decision tree (the "intelligent channel analysis" the user wanted):
/// - **both channels dead** → no repair (nothing usable to duplicate);
/// - **one channel dead, the other healthy** → duplicate the healthy channel
///   into stereo (the bad-cable fix);
/// - **both alive but imbalanced beyond tolerance** → per-channel makeup that
///   brings the quieter channel up toward the louder (capped), i.e. re-centre a
///   hard-panned / gain-mismatched pair;
/// - **within tolerance** → balanced, no repair.
pub fn diagnose_channels(levels: ChannelLevelsDb) -> ChannelDiagnosis {
    let pl = levels.peak_left_db;
    let pr = levels.peak_right_db;

    // Imbalance magnitude prefers RMS (steadier) when we have both.
    let imbalance_db = match (levels.rms_left_db, levels.rms_right_db) {
        (Some(l), Some(r)) => l - r,
        _ => pl - pr,
    };

    let left_dead = pl < DEAD_FLOOR_DB;
    let right_dead = pr < DEAD_FLOOR_DB;
    let left_healthy = pl >= HEALTHY_DB;
    let right_healthy = pr >= HEALTHY_DB;

    if left_dead && right_dead {
        return ChannelDiagnosis {
            recommended: ChannelRepair::None,
            code: "both_dead",
            imbalance_db,
        };
    }
    if left_dead && right_healthy {
        return ChannelDiagnosis {
            recommended: ChannelRepair::DuplicateRight,
            code: "dead_left",
            imbalance_db,
        };
    }
    if right_dead && left_healthy {
        return ChannelDiagnosis {
            recommended: ChannelRepair::DuplicateLeft,
            code: "dead_right",
            imbalance_db,
        };
    }

    if imbalance_db.abs() <= BALANCE_TOLERANCE_DB {
        return ChannelDiagnosis {
            recommended: ChannelRepair::None,
            code: "balanced",
            imbalance_db,
        };
    }

    // Imbalanced but both alive: lift the quieter leg toward the louder, capped.
    let makeup = imbalance_db.abs().min(MAX_AUTO_MAKEUP_DB);
    let recommended = if imbalance_db > 0.0 {
        // Left louder → bring right up.
        ChannelRepair::GainDb {
            left_db: 0.0,
            right_db: makeup,
        }
    } else {
        ChannelRepair::GainDb {
            left_db: makeup,
            right_db: 0.0,
        }
    };
    ChannelDiagnosis {
        recommended,
        code: "imbalance",
        imbalance_db,
    }
}

// ── vocal-chain stages ──────────────────────────────────────────────────────

/// High-pass (low-cut) — removes rumble, handling noise, AC hum fundamentals and
/// plosive thumps below the voice. 75–100 Hz is the spoken-word range.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HighpassStage {
    pub enabled: bool,
    pub freq_hz: u32,
}
impl Default for HighpassStage {
    fn default() -> Self {
        Self {
            enabled: true,
            freq_hz: 80,
        }
    }
}

/// FFT denoiser (`afftdn`) — broadband hiss/fan/air-con reduction. `reduction_db`
/// is how hard to pull the noise down (conservative: 10–14 dB; aggressive: 20+);
/// `noise_floor_db` is where the noise sits (≈ −25 for a typical room).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DenoiseStage {
    pub enabled: bool,
    pub reduction_db: f64,
    pub noise_floor_db: f64,
}
impl Default for DenoiseStage {
    fn default() -> Self {
        Self {
            enabled: false,
            reduction_db: 12.0,
            noise_floor_db: -25.0,
        }
    }
}

/// De-reverb (approximate). ffmpeg has no true spectral dereverb, so this is a
/// pragmatic room-tail reducer: a downward expander (`agate` with a gentle
/// ratio) pulls the level down between words where reverb tails ring out, while
/// leaving speech above the threshold untouched. `strength` 0..1 scales how
/// aggressively (higher threshold + ratio). NOT a substitute for treating the
/// room — documented as a reduction, not removal.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DereverbStage {
    pub enabled: bool,
    pub strength: f64,
}
impl Default for DereverbStage {
    fn default() -> Self {
        Self {
            enabled: false,
            strength: 0.4,
        }
    }
}

/// De-esser (`deesser`) — tames harsh "s"/"sh" sibilance. `intensity` 0..1.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DeesserStage {
    pub enabled: bool,
    pub intensity: f64,
}
impl Default for DeesserStage {
    fn default() -> Self {
        Self {
            enabled: false,
            intensity: 0.4,
        }
    }
}

/// One parametric EQ band (`equalizer`). Positive `gain_db` boosts, negative
/// cuts; `q` is the bandwidth (higher = narrower).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EqBand {
    pub freq_hz: u32,
    pub gain_db: f64,
    pub q: f64,
}

/// Noise gate / downward expander (`agate`) — closes between phrases so room
/// tone, breaths and bleed don't get lifted by the compressor that follows.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GateStage {
    pub enabled: bool,
    pub threshold_db: f64,
    pub ratio: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
}
impl Default for GateStage {
    fn default() -> Self {
        Self {
            enabled: false,
            threshold_db: -40.0,
            ratio: 2.0,
            attack_ms: 5.0,
            release_ms: 120.0,
        }
    }
}

/// Compressor (`acompressor`) — evens out the level so quiet and loud delivery
/// sit closer together. `makeup_db` adds gain back after compression.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CompressorStage {
    pub enabled: bool,
    pub threshold_db: f64,
    pub ratio: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub makeup_db: f64,
}
impl Default for CompressorStage {
    fn default() -> Self {
        Self {
            enabled: true,
            threshold_db: -18.0,
            ratio: 3.0,
            attack_ms: 5.0,
            release_ms: 80.0,
            makeup_db: 2.0,
        }
    }
}

/// Brick-wall limiter (`alimiter`) — catches stray peaks so nothing clips before
/// the loudness stage. `limit_db` is the ceiling in dBFS.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LimiterStage {
    pub enabled: bool,
    pub limit_db: f64,
}
impl Default for LimiterStage {
    fn default() -> Self {
        Self {
            enabled: false,
            limit_db: -1.0,
        }
    }
}

/// A complete, configurable vocal chain. Stages run in producer-canonical order
/// (see [`Self::build_filters`]). Every stage is independently toggleable; the
/// defaults are a sensible "light polish" that only high-passes and gently
/// compresses, leaving the heavier tools (denoise, de-reverb, gate, EQ, limiter)
/// off until the user opts in.
#[derive(Debug, Clone, PartialEq)]
pub struct VocalChain {
    pub channel_repair: ChannelRepair,
    pub highpass: HighpassStage,
    pub denoise: DenoiseStage,
    pub dereverb: DereverbStage,
    pub gate: GateStage,
    pub eq: Vec<EqBand>,
    pub compressor: CompressorStage,
    pub deesser: DeesserStage,
    pub limiter: LimiterStage,
    /// Flexible manual makeup applied last (before the external loudness stage).
    /// dB; `0.0` is a no-op.
    pub gain_db: f64,
}

impl Default for VocalChain {
    fn default() -> Self {
        Self {
            channel_repair: ChannelRepair::None,
            highpass: HighpassStage::default(),
            denoise: DenoiseStage::default(),
            dereverb: DereverbStage::default(),
            gate: GateStage::default(),
            eq: Vec::new(),
            compressor: CompressorStage::default(),
            deesser: DeesserStage::default(),
            limiter: LimiterStage::default(),
            gain_db: 0.0,
        }
    }
}

impl VocalChain {
    /// Render the enabled stages to ordered ffmpeg filter fragments. The order is
    /// the standard spoken-word chain:
    ///
    /// 1. channel repair (`pan`) — fix the layout before anything measures it,
    /// 2. high-pass — drop sub-voice rumble so the compressor isn't chasing it,
    /// 3. denoise (`afftdn`) — clean the broadband floor,
    /// 4. de-reverb (approx, `agate` expander) — pull room tails,
    /// 5. gate (`agate`) — close between phrases,
    /// 6. EQ (`equalizer` per band) — subtractive/additive shaping,
    /// 7. compressor (`acompressor`) — even the dynamics,
    /// 8. de-esser (`deesser`) — after comp, which can lift sibilance,
    /// 9. limiter (`alimiter`) — peak ceiling,
    /// 10. makeup gain (`volume`).
    ///
    /// Returns an empty vec when nothing is enabled (a true pass-through).
    pub fn build_filters(&self) -> Vec<String> {
        let mut f: Vec<String> = Vec::new();

        if let Some(pan) = channel_repair_filter(self.channel_repair) {
            f.push(pan);
        }
        if self.highpass.enabled {
            f.push(format!("highpass=f={}", self.highpass.freq_hz));
        }
        if self.denoise.enabled {
            f.push(format!(
                "afftdn=nr={}:nf={}:tn=1",
                coef(self.denoise.reduction_db),
                coef(self.denoise.noise_floor_db)
            ));
        }
        if self.dereverb.enabled {
            // Map strength 0..1 → a gentle downward expander. Higher strength =
            // higher threshold (acts on more of the tail) + stronger ratio.
            let s = self.dereverb.strength.clamp(0.0, 1.0);
            let threshold_db = -45.0 + 15.0 * s; // −45 … −30 dB
            let ratio = 1.5 + 1.5 * s; // 1.5 … 3.0
            f.push(format!(
                "agate=threshold={}:ratio={}:attack=10:release=200:detection=rms",
                coef(db_to_linear(threshold_db)),
                coef(ratio)
            ));
        }
        if self.gate.enabled {
            f.push(format!(
                "agate=threshold={}:ratio={}:attack={}:release={}",
                coef(db_to_linear(self.gate.threshold_db)),
                coef(self.gate.ratio),
                coef(self.gate.attack_ms),
                coef(self.gate.release_ms)
            ));
        }
        for band in &self.eq {
            f.push(format!(
                "equalizer=f={}:t=q:w={}:g={}",
                band.freq_hz,
                coef(band.q),
                coef(band.gain_db)
            ));
        }
        if self.compressor.enabled {
            f.push(format!(
                "acompressor=threshold={}dB:ratio={}:attack={}:release={}:makeup={}",
                coef(self.compressor.threshold_db),
                coef(self.compressor.ratio),
                coef(self.compressor.attack_ms),
                coef(self.compressor.release_ms),
                coef(self.compressor.makeup_db)
            ));
        }
        if self.deesser.enabled {
            // `deesser` takes intensity `i` (0..1) and makes `m`/`f` defaults.
            f.push(format!(
                "deesser=i={}",
                coef(self.deesser.intensity.clamp(0.0, 1.0))
            ));
        }
        if self.limiter.enabled {
            f.push(format!(
                "alimiter=limit={}",
                coef(db_to_linear(self.limiter.limit_db))
            ));
        }
        if self.gain_db.abs() > 1e-3 {
            f.push(format!("volume={}dB", coef(self.gain_db)));
        }
        f
    }

    /// The chain as a single comma-joined filter string, or `None` if empty.
    pub fn to_filter_string(&self) -> Option<String> {
        let parts = self.build_filters();
        if parts.is_empty() {
            None
        } else {
            Some(parts.join(","))
        }
    }
}

/// A named vocal-chain preset (id + Norwegian label + the chain). These are the
/// one-click starting points; the UI can then tweak any stage.
pub struct VocalChainPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub chain: VocalChain,
}

/// Built-in vocal-chain presets, mirroring how a producer saves chain settings.
pub fn vocal_chain_presets() -> Vec<VocalChainPreset> {
    vec![
        VocalChainPreset {
            id: "voice-light",
            label: "Stemme — lett",
            description: "Bare lavkutt + lett kompresjon. Trygt for gode opptak.",
            chain: VocalChain::default(),
        },
        VocalChainPreset {
            id: "voice-podcast",
            label: "Podkast-stemme (anbefalt)",
            description: "Lavkutt, mild støyreduksjon, EQ, kompresjon, de-esser og takgrense — full vokal-kjede for tale.",
            chain: VocalChain {
                highpass: HighpassStage {
                    enabled: true,
                    freq_hz: 85,
                },
                denoise: DenoiseStage {
                    enabled: true,
                    reduction_db: 10.0,
                    noise_floor_db: -25.0,
                },
                eq: vec![
                    EqBand {
                        freq_hz: 250,
                        gain_db: -2.0,
                        q: 1.0,
                    }, // tame boxiness/mud
                    EqBand {
                        freq_hz: 3500,
                        gain_db: 2.5,
                        q: 1.0,
                    }, // presence/intelligibility
                    EqBand {
                        freq_hz: 10000,
                        gain_db: 1.5,
                        q: 1.5,
                    }, // air
                ],
                compressor: CompressorStage {
                    enabled: true,
                    threshold_db: -20.0,
                    ratio: 3.0,
                    attack_ms: 5.0,
                    release_ms: 80.0,
                    makeup_db: 3.0,
                },
                deesser: DeesserStage {
                    enabled: true,
                    intensity: 0.4,
                },
                limiter: LimiterStage {
                    enabled: true,
                    limit_db: -1.0,
                },
                ..VocalChain::default()
            },
        },
        VocalChainPreset {
            id: "voice-noisy-room",
            label: "Støyete rom",
            description: "Sterkere støyreduksjon, romdemping og gate. For dårlige opptaksforhold.",
            chain: VocalChain {
                highpass: HighpassStage {
                    enabled: true,
                    freq_hz: 100,
                },
                denoise: DenoiseStage {
                    enabled: true,
                    reduction_db: 20.0,
                    noise_floor_db: -20.0,
                },
                dereverb: DereverbStage {
                    enabled: true,
                    strength: 0.5,
                },
                gate: GateStage {
                    enabled: true,
                    threshold_db: -38.0,
                    ratio: 2.5,
                    attack_ms: 5.0,
                    release_ms: 150.0,
                },
                eq: vec![
                    EqBand {
                        freq_hz: 300,
                        gain_db: -3.0,
                        q: 1.0,
                    },
                    EqBand {
                        freq_hz: 3000,
                        gain_db: 3.0,
                        q: 1.0,
                    },
                ],
                compressor: CompressorStage {
                    enabled: true,
                    threshold_db: -22.0,
                    ratio: 4.0,
                    attack_ms: 4.0,
                    release_ms: 70.0,
                    makeup_db: 3.0,
                },
                deesser: DeesserStage {
                    enabled: true,
                    intensity: 0.5,
                },
                limiter: LimiterStage {
                    enabled: true,
                    limit_db: -1.0,
                },
                ..VocalChain::default()
            },
        },
    ]
}

/// Look up a vocal-chain preset by id.
pub fn vocal_chain_preset_by_id(id: &str) -> Option<VocalChainPreset> {
    vocal_chain_presets().into_iter().find(|p| p.id == id)
}

/// A measured noise floor (dBFS) above this is "noisy" — a clean recording sits
/// around −60…−70 dBFS, a room with audible hiss/HVAC/handling around −45.
const NOISE_NOISY_THRESHOLD_DB: f64 = -50.0;

/// Pick the best one-click vocal-chain preset from a measured noise floor: a
/// noisy recording gets the heavier `voice-noisy-room` chain (stronger denoise +
/// de-reverb + gate), a clean one the standard `voice-podcast`. `None` (no
/// measurement) defaults to `voice-podcast`.
pub fn recommend_vocal_preset(noise_floor_db: Option<f64>) -> &'static str {
    match noise_floor_db {
        Some(nf) if nf.is_finite() && nf > NOISE_NOISY_THRESHOLD_DB => "voice-noisy-room",
        _ => "voice-podcast",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── helpers ──────────────────────────────────────────────────────────────

    #[test]
    fn db_to_linear_reference_points() {
        assert!((db_to_linear(0.0) - 1.0).abs() < 1e-9);
        assert!((db_to_linear(6.0) - 1.995).abs() < 1e-2);
        assert!((db_to_linear(-6.0) - 0.501).abs() < 1e-2);
    }

    #[test]
    fn coef_trims_trailing_zeros() {
        assert_eq!(coef(1.0), "1");
        assert_eq!(coef(0.5), "0.5");
        assert_eq!(coef(-1.0), "-1");
        assert_eq!(coef(2.0), "2");
    }

    // ── channel repair ───────────────────────────────────────────────────────

    #[test]
    fn channel_repair_basic_pans() {
        assert_eq!(channel_repair_filter(ChannelRepair::None), None);
        assert_eq!(
            channel_repair_filter(ChannelRepair::SwapLr).unwrap(),
            "pan=stereo|c0=c1|c1=c0"
        );
        assert_eq!(
            channel_repair_filter(ChannelRepair::DuplicateLeft).unwrap(),
            "pan=stereo|c0=c0|c1=c0"
        );
        assert_eq!(
            channel_repair_filter(ChannelRepair::DuplicateRight).unwrap(),
            "pan=stereo|c0=c1|c1=c1"
        );
        assert_eq!(
            channel_repair_filter(ChannelRepair::MonoMix).unwrap(),
            "pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1"
        );
    }

    #[test]
    fn channel_repair_gain_db_renders_linear_coefs() {
        // +6 dB right ≈ 1.995× ; left unity.
        let f = channel_repair_filter(ChannelRepair::GainDb {
            left_db: 0.0,
            right_db: 6.0,
        })
        .unwrap();
        assert!(f.starts_with("pan=stereo|c0=1*c0|c1="), "got {f}");
        assert!(
            f.contains("c1=1.995*c0") || f.contains("c1=1.995*c1"),
            "got {f}"
        );
    }

    #[test]
    fn channel_repair_gain_db_zero_is_noop() {
        assert_eq!(
            channel_repair_filter(ChannelRepair::GainDb {
                left_db: 0.0,
                right_db: 0.0,
            }),
            None
        );
    }

    #[test]
    fn channel_repair_gain_db_clamps_extremes() {
        // +100 dB clamps to +24 dB (≈15.85×), not a wild number.
        let f = channel_repair_filter(ChannelRepair::GainDb {
            left_db: 100.0,
            right_db: 0.0,
        })
        .unwrap();
        assert!(f.contains("c0=15.849*c0"), "got {f}");
    }

    // ── diagnosis ────────────────────────────────────────────────────────────

    #[test]
    fn diagnose_balanced_when_within_tolerance() {
        let d = diagnose_channels(ChannelLevelsDb {
            peak_left_db: -12.0,
            peak_right_db: -13.0,
            rms_left_db: None,
            rms_right_db: None,
        });
        assert_eq!(d.code, "balanced");
        assert_eq!(d.recommended, ChannelRepair::None);
    }

    #[test]
    fn diagnose_dead_right_duplicates_left() {
        // Right channel is silent (bad cable), left is healthy.
        let d = diagnose_channels(ChannelLevelsDb {
            peak_left_db: -10.0,
            peak_right_db: -80.0,
            rms_left_db: None,
            rms_right_db: None,
        });
        assert_eq!(d.code, "dead_right");
        assert_eq!(d.recommended, ChannelRepair::DuplicateLeft);
    }

    #[test]
    fn diagnose_dead_left_duplicates_right() {
        let d = diagnose_channels(ChannelLevelsDb {
            peak_left_db: -70.0,
            peak_right_db: -9.0,
            rms_left_db: None,
            rms_right_db: None,
        });
        assert_eq!(d.code, "dead_left");
        assert_eq!(d.recommended, ChannelRepair::DuplicateRight);
    }

    #[test]
    fn diagnose_both_dead_recommends_nothing() {
        let d = diagnose_channels(ChannelLevelsDb {
            peak_left_db: -80.0,
            peak_right_db: -75.0,
            rms_left_db: None,
            rms_right_db: None,
        });
        assert_eq!(d.code, "both_dead");
        assert_eq!(d.recommended, ChannelRepair::None);
    }

    #[test]
    fn diagnose_imbalance_lifts_quieter_channel_capped() {
        // Left −8, right −20 (both alive) → bring right up by 12 dB (the cap).
        let d = diagnose_channels(ChannelLevelsDb {
            peak_left_db: -8.0,
            peak_right_db: -20.0,
            rms_left_db: None,
            rms_right_db: None,
        });
        assert_eq!(d.code, "imbalance");
        match d.recommended {
            ChannelRepair::GainDb { left_db, right_db } => {
                assert_eq!(left_db, 0.0);
                assert!((right_db - 12.0).abs() < 1e-9, "right_db={right_db}");
            }
            other => panic!("expected GainDb, got {other:?}"),
        }
    }

    #[test]
    fn diagnose_prefers_rms_for_imbalance_magnitude() {
        // Peaks say +8 (left louder) but RMS says right is louder by 5 → lift left.
        let d = diagnose_channels(ChannelLevelsDb {
            peak_left_db: -10.0,
            peak_right_db: -18.0,
            rms_left_db: Some(-25.0),
            rms_right_db: Some(-20.0),
        });
        assert_eq!(d.code, "imbalance");
        match d.recommended {
            ChannelRepair::GainDb { left_db, right_db } => {
                assert!((left_db - 5.0).abs() < 1e-9, "left_db={left_db}");
                assert_eq!(right_db, 0.0);
            }
            other => panic!("expected GainDb, got {other:?}"),
        }
    }

    // ── vocal chain ──────────────────────────────────────────────────────────

    #[test]
    fn default_chain_is_highpass_then_compressor() {
        let parts = VocalChain::default().build_filters();
        assert_eq!(parts.len(), 2, "got {parts:?}");
        assert_eq!(parts[0], "highpass=f=80");
        assert!(parts[1].starts_with("acompressor=threshold=-18dB:ratio=3"));
    }

    #[test]
    fn fully_disabled_chain_is_passthrough() {
        let chain = VocalChain {
            highpass: HighpassStage {
                enabled: false,
                freq_hz: 80,
            },
            compressor: CompressorStage {
                enabled: false,
                ..CompressorStage::default()
            },
            ..VocalChain::default()
        };
        assert!(chain.build_filters().is_empty());
        assert_eq!(chain.to_filter_string(), None);
    }

    #[test]
    fn chain_orders_all_stages_canonically() {
        let chain = VocalChain {
            channel_repair: ChannelRepair::SwapLr,
            highpass: HighpassStage {
                enabled: true,
                freq_hz: 90,
            },
            denoise: DenoiseStage {
                enabled: true,
                reduction_db: 12.0,
                noise_floor_db: -25.0,
            },
            dereverb: DereverbStage {
                enabled: true,
                strength: 0.5,
            },
            gate: GateStage {
                enabled: true,
                ..GateStage::default()
            },
            eq: vec![EqBand {
                freq_hz: 3000,
                gain_db: 2.0,
                q: 1.0,
            }],
            compressor: CompressorStage {
                enabled: true,
                ..CompressorStage::default()
            },
            deesser: DeesserStage {
                enabled: true,
                intensity: 0.4,
            },
            limiter: LimiterStage {
                enabled: true,
                limit_db: -1.0,
            },
            gain_db: 1.5,
        };
        let parts = chain.build_filters();
        // Verify the relative ordering of each filter kind.
        let idx = |needle: &str| parts.iter().position(|p| p.starts_with(needle)).unwrap();
        assert!(idx("pan=") < idx("highpass="));
        assert!(idx("highpass=") < idx("afftdn="));
        // Two agate stages (dereverb + gate) — both present.
        assert_eq!(parts.iter().filter(|p| p.starts_with("agate=")).count(), 2);
        assert!(idx("afftdn=") < idx("agate="));
        assert!(idx("agate=") < idx("equalizer="));
        assert!(idx("equalizer=") < idx("acompressor="));
        assert!(idx("acompressor=") < idx("deesser="));
        assert!(idx("deesser=") < idx("alimiter="));
        assert!(idx("alimiter=") < idx("volume="));
        assert!(parts.last().unwrap().starts_with("volume=1.5dB"));
    }

    #[test]
    fn denoise_filter_shape() {
        let chain = VocalChain {
            highpass: HighpassStage {
                enabled: false,
                freq_hz: 80,
            },
            denoise: DenoiseStage {
                enabled: true,
                reduction_db: 12.0,
                noise_floor_db: -25.0,
            },
            compressor: CompressorStage {
                enabled: false,
                ..CompressorStage::default()
            },
            ..VocalChain::default()
        };
        assert_eq!(chain.build_filters(), vec!["afftdn=nr=12:nf=-25:tn=1"]);
    }

    #[test]
    fn eq_band_renders_equalizer() {
        let chain = VocalChain {
            highpass: HighpassStage {
                enabled: false,
                freq_hz: 80,
            },
            compressor: CompressorStage {
                enabled: false,
                ..CompressorStage::default()
            },
            eq: vec![EqBand {
                freq_hz: 250,
                gain_db: -2.0,
                q: 1.0,
            }],
            ..VocalChain::default()
        };
        assert_eq!(chain.build_filters(), vec!["equalizer=f=250:t=q:w=1:g=-2"]);
    }

    #[test]
    fn limiter_threshold_is_linear() {
        let chain = VocalChain {
            highpass: HighpassStage {
                enabled: false,
                freq_hz: 80,
            },
            compressor: CompressorStage {
                enabled: false,
                ..CompressorStage::default()
            },
            limiter: LimiterStage {
                enabled: true,
                limit_db: -1.0,
            },
            ..VocalChain::default()
        };
        // −1 dBFS ≈ 0.891 linear.
        assert_eq!(chain.build_filters(), vec!["alimiter=limit=0.891"]);
    }

    // ── presets ──────────────────────────────────────────────────────────────

    #[test]
    fn presets_have_unique_ids_and_build() {
        let presets = vocal_chain_presets();
        assert!(presets.len() >= 3);
        let mut ids: Vec<&str> = presets.iter().map(|p| p.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), presets.len());
        // Every preset produces a non-empty chain except possibly the lightest.
        for p in &presets {
            let _ = p.chain.build_filters(); // must not panic
        }
    }

    #[test]
    fn podcast_preset_has_full_chain() {
        let p = vocal_chain_preset_by_id("voice-podcast").unwrap();
        let parts = p.chain.build_filters();
        assert!(parts.iter().any(|s| s.starts_with("highpass=")));
        assert!(parts.iter().any(|s| s.starts_with("afftdn=")));
        assert!(parts.iter().any(|s| s.starts_with("equalizer=")));
        assert!(parts.iter().any(|s| s.starts_with("acompressor=")));
        assert!(parts.iter().any(|s| s.starts_with("deesser=")));
        assert!(parts.iter().any(|s| s.starts_with("alimiter=")));
    }

    #[test]
    fn unknown_preset_id_is_none() {
        assert!(vocal_chain_preset_by_id("nope").is_none());
    }

    #[test]
    fn recommend_preset_picks_noisy_room_when_floor_high() {
        // Clean recording (low noise floor) → standard podcast chain.
        assert_eq!(recommend_vocal_preset(Some(-65.0)), "voice-podcast");
        assert_eq!(recommend_vocal_preset(Some(-50.0)), "voice-podcast");
        // Noisy (floor above −50) → the heavier noisy-room chain.
        assert_eq!(recommend_vocal_preset(Some(-45.0)), "voice-noisy-room");
        assert_eq!(recommend_vocal_preset(Some(-30.0)), "voice-noisy-room");
        // No measurement / non-finite → default to podcast.
        assert_eq!(recommend_vocal_preset(None), "voice-podcast");
        assert_eq!(recommend_vocal_preset(Some(f64::NAN)), "voice-podcast");
    }
}
