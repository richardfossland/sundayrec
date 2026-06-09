//! Audio analysis — VAD + content classification, pure (P2a).
//!
//! Ported from the Electron `src/main/audio-analysis.ts` and the sermon-pick
//! heuristic in `editor.ts` (`findSermonSegmentLocal`/`detectSegments`). It
//! classifies every 100 ms frame of decoded mono-16 kHz PCM as
//! speech/music/silence/mixed/unknown using a feature-based heuristic (no ONNX,
//! ffmpeg-only environment), smooths the type stream, groups runs into
//! segments, merges sub-5 s segments, and promotes one speech block to the
//! "sermon" best-guess.
//!
//! Everything here is a deterministic function of an in-memory PCM buffer (or
//! pre-extracted frames), so the whole classifier is unit-testable without
//! ffmpeg. The `src-tauri` shell decodes the file to f32 PCM and feeds frames
//! in; this module owns the maths.

/// Sample rate the analyzer expects (matches the ffmpeg `-ar` the shell uses).
pub const SAMPLE_RATE: u32 = 16000;
/// Frame length in milliseconds — 100 ms = 10 frames/sec.
pub const FRAME_MS: u32 = 100;
/// Samples per frame at 16 kHz × 100 ms.
pub const FRAME_SAMPLES: usize = (SAMPLE_RATE as usize * FRAME_MS as usize) / 1000;
/// FFT size — next power of two ≥ frame size; we zero-pad.
pub const FFT_SIZE: usize = 2048;
/// Silence threshold (dBFS). Below this a frame is `silence`.
pub const SILENCE_DB: f64 = -45.0;
/// Half-width (frames) of the median smoother (±5 ≈ ±0.5 s).
pub const SMOOTH_HALF_WIN: usize = 5;
/// Minimum segment duration (seconds) before merge-into-neighbour.
pub const MIN_SEGMENT_SEC: f64 = 5.0;

/// The five content classes. Mirrors `SegmentType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentType {
    Silence,
    Speech,
    Music,
    Mixed,
    Unknown,
}

impl SegmentType {
    /// The default Norwegian label, mirroring the `LABELS` table.
    pub fn label(self) -> &'static str {
        match self {
            SegmentType::Speech => "Tale",
            SegmentType::Music => "Musikk",
            SegmentType::Silence => "Stillhet",
            SegmentType::Mixed => "Blandet",
            SegmentType::Unknown => "—",
        }
    }
}

/// Per-frame features. Mirrors `AnalysisFrame`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AnalysisFrame {
    pub start_sec: f64,
    pub rms_db: f64,
    pub zcr_per_sec: f64,
    pub spectral_centroid: f64,
    pub spectral_flux: f64,
}

/// A grouped, classified segment. Mirrors `AnalysisSegment`.
#[derive(Debug, Clone, PartialEq)]
pub struct AnalysisSegment {
    pub start_sec: f64,
    pub end_sec: f64,
    pub duration_sec: f64,
    pub seg_type: SegmentType,
    pub confidence: f64,
    pub avg_rms_db: f64,
    pub label: String,
}

// ── FFT ─────────────────────────────────────────────────────────────────────

/// Iterative in-place Cooley-Tukey radix-2 FFT over parallel re/im buffers of
/// length N (power of two). Ports the JS `fft` exactly.
pub fn fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    assert_eq!(n, im.len(), "fft: re/im length mismatch");
    assert!(n >= 2 && (n & (n - 1)) == 0, "fft: size must be power of 2");

    // bit-reversal permutation
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }

    // butterflies
    let mut size = 2;
    while size <= n {
        let half = size >> 1;
        let table_step = -2.0 * std::f64::consts::PI / size as f64;
        let mut i = 0;
        while i < n {
            for k in 0..half {
                let angle = table_step * k as f64;
                let wr = angle.cos();
                let wi = angle.sin();
                let a_re = re[i + k];
                let a_im = im[i + k];
                let b_re = re[i + k + half];
                let b_im = im[i + k + half];
                let t_re = wr * b_re - wi * b_im;
                let t_im = wr * b_im + wi * b_re;
                re[i + k] = a_re + t_re;
                im[i + k] = a_im + t_im;
                re[i + k + half] = a_re - t_re;
                im[i + k + half] = a_im - t_im;
            }
            i += size;
        }
        size <<= 1;
    }
}

/// Hann window of `size` samples (`0.5*(1-cos(2πi/(size-1)))`). Ports `hannWindow`.
/// `size <= 1` would divide by `size-1 == 0` → NaN; a 1-sample window is just 1.0
/// (the conventional degenerate case), so guard it.
pub fn hann_window(size: usize) -> Vec<f64> {
    if size <= 1 {
        return vec![1.0; size];
    }
    (0..size)
        .map(|i| 0.5 * (1.0 - (2.0 * std::f64::consts::PI * i as f64 / (size as f64 - 1.0)).cos()))
        .collect()
}

// ── Per-frame features ─────────────────────────────────────────────────────────

/// RMS energy in dBFS. Returns `-inf` for true silence. Ports `rmsDb`.
pub fn rms_db(samples: &[f32]) -> f64 {
    if samples.is_empty() {
        return f64::NEG_INFINITY;
    }
    let mut sum_sq = 0.0_f64;
    for &s in samples {
        sum_sq += (s as f64) * (s as f64);
    }
    let rms = (sum_sq / samples.len() as f64).sqrt();
    if rms <= 1e-12 {
        f64::NEG_INFINITY
    } else {
        20.0 * rms.log10()
    }
}

/// Zero-crossing rate per second. Ports `zcrPerSecond`.
pub fn zcr_per_second(samples: &[f32], sample_rate: u32) -> f64 {
    if samples.len() < 2 {
        return 0.0;
    }
    let mut crossings = 0u64;
    let mut prev = samples[0];
    for &cur in &samples[1..] {
        if (prev >= 0.0 && cur < 0.0) || (prev < 0.0 && cur >= 0.0) {
            crossings += 1;
        }
        prev = cur;
    }
    let duration_sec = samples.len() as f64 / sample_rate as f64;
    crossings as f64 / duration_sec
}

/// Spectral centroid (Hz) + magnitude spectrum (len N/2+1) of a frame. Ports
/// `spectrum`: Hann-windowed, zero-padded to `FFT_SIZE`.
pub fn spectrum(samples: &[f32], sample_rate: u32) -> (f64, Vec<f64>) {
    let n = FFT_SIZE;
    let mut re = vec![0.0_f64; n];
    let mut im = vec![0.0_f64; n];
    let win = hann_window(samples.len());

    let cap = samples.len().min(n);
    for i in 0..cap {
        re[i] = samples[i] as f64 * win[i];
    }

    fft(&mut re, &mut im);

    let half = n >> 1;
    let mut mag = vec![0.0_f64; half + 1];
    let mut weighted_sum = 0.0;
    let mut total_mag = 0.0;
    let bin_hz = sample_rate as f64 / n as f64;
    for (k, m) in mag.iter_mut().enumerate() {
        *m = (re[k] * re[k] + im[k] * im[k]).sqrt();
        weighted_sum += k as f64 * bin_hz * *m;
        total_mag += *m;
    }
    let centroid = if total_mag > 1e-12 {
        weighted_sum / total_mag
    } else {
        0.0
    };
    (centroid, mag)
}

/// L2 norm of bin-wise magnitude difference vs the previous frame. Ports
/// `spectralFlux` (returns 0 when there is no previous frame).
pub fn spectral_flux(curr: &[f64], prev: Option<&[f64]>) -> f64 {
    let Some(prev) = prev else { return 0.0 };
    let n = curr.len().min(prev.len());
    let mut sum = 0.0;
    for i in 0..n {
        let d = curr[i] - prev[i];
        sum += d * d;
    }
    sum.sqrt()
}

/// Extract features for every `frame_ms` frame of `pcm`. Pure. Ports
/// `extractFeatures` (no overlap; trailing partial frame is dropped).
pub fn extract_features(pcm: &[f32], sample_rate: u32, frame_ms: u32) -> Vec<AnalysisFrame> {
    if pcm.is_empty() || sample_rate == 0 || frame_ms == 0 {
        return Vec::new();
    }
    let samples_per_frame = (sample_rate as usize * frame_ms as usize) / 1000;
    if samples_per_frame == 0 {
        return Vec::new();
    }
    let total = pcm.len() / samples_per_frame;
    let mut frames = Vec::with_capacity(total);
    let mut prev_mag: Option<Vec<f64>> = None;
    for f in 0..total {
        let offset = f * samples_per_frame;
        let slice = &pcm[offset..offset + samples_per_frame];
        let start_sec = offset as f64 / sample_rate as f64;
        let r = rms_db(slice);
        let z = zcr_per_second(slice, sample_rate);
        let (centroid, magnitude) = spectrum(slice, sample_rate);
        let flux = spectral_flux(&magnitude, prev_mag.as_deref());
        prev_mag = Some(magnitude);
        frames.push(AnalysisFrame {
            start_sec,
            rms_db: r,
            zcr_per_sec: z,
            spectral_centroid: centroid,
            spectral_flux: flux,
        });
    }
    frames
}

// ── Classifier ────────────────────────────────────────────────────────────────

/// Classify a single frame. Ports `classifyFrame` exactly — the same thresholds
/// and score table, returning the type + a 0..1 confidence.
pub fn classify_frame(frame: &AnalysisFrame) -> (SegmentType, f64) {
    let r = frame.rms_db;
    let z = frame.zcr_per_sec;
    let c = frame.spectral_centroid;
    let fx = frame.spectral_flux;

    // silence: hard energy threshold
    if r < SILENCE_DB {
        let margin = ((SILENCE_DB - r) / 10.0).min(1.0);
        return (SegmentType::Silence, 0.6 + 0.4 * margin);
    }

    let speech_zcr = (400.0..=6000.0).contains(&z);
    let speech_centroid = (300.0..=3500.0).contains(&c);
    let speech_flux = fx > 8.0;
    let speech_energy = (-45.0..=-5.0).contains(&r);

    let music_zcr = z < 1500.0;
    let music_flux = fx < 6.0;
    let music_energy = r >= -40.0;

    let mut speech_score = 0;
    if speech_energy {
        speech_score += 1;
    }
    if speech_zcr {
        speech_score += 1;
    }
    if speech_centroid {
        speech_score += 1;
    }
    if speech_flux {
        speech_score += 1;
    }

    let mut music_score = 0;
    if music_energy {
        music_score += 1;
    }
    if music_zcr {
        music_score += 1;
    }
    if music_flux {
        music_score += 1;
    }

    if speech_score == 4 && music_score < 3 {
        return (SegmentType::Speech, 0.9);
    }
    if music_score == 3 && speech_score <= 2 {
        return (SegmentType::Music, 0.85);
    }
    if speech_score >= 3 && speech_score > music_score {
        return (SegmentType::Speech, 0.7);
    }
    if music_score >= 2 && music_score >= speech_score {
        return (SegmentType::Music, 0.65);
    }
    if speech_score >= 2 && music_score >= 2 {
        return (SegmentType::Mixed, 0.5);
    }
    (SegmentType::Unknown, 0.3)
}

/// Median (mode) filter over a type sequence — for each index, the most frequent
/// type in `±half_win`. Ports `medianSmooth`.
pub fn median_smooth(types: &[SegmentType], half_win: usize) -> Vec<SegmentType> {
    let mut out = Vec::with_capacity(types.len());
    for i in 0..types.len() {
        let lo = i.saturating_sub(half_win);
        let hi = (i + half_win).min(types.len() - 1);
        let mut counts: [u32; 5] = [0; 5];
        let mut best = types[i];
        let mut best_count = 0;
        for t in &types[lo..=hi] {
            let idx = type_index(*t);
            counts[idx] += 1;
            if counts[idx] > best_count {
                best_count = counts[idx];
                best = *t;
            }
        }
        out.push(best);
    }
    out
}

fn type_index(t: SegmentType) -> usize {
    match t {
        SegmentType::Silence => 0,
        SegmentType::Speech => 1,
        SegmentType::Music => 2,
        SegmentType::Mixed => 3,
        SegmentType::Unknown => 4,
    }
}

/// Group consecutive same-type frames into segments. Ports `groupSegments`:
/// `endSec` is the next frame's start (or last frame start + frame duration at
/// EOF); `avgRmsDb` skips `-inf`; `confidence` is the mean.
fn group_segments(
    frames: &[AnalysisFrame],
    types: &[SegmentType],
    confidences: &[f64],
) -> Vec<AnalysisSegment> {
    if frames.is_empty() {
        return Vec::new();
    }
    let mut segments = Vec::new();
    let mut seg_start = 0usize;
    let mut seg_type = types[0];

    let close = |segments: &mut Vec<AnalysisSegment>,
                 start_frame: usize,
                 end_frame: usize,
                 seg_type: SegmentType| {
        let start_sec = frames[start_frame].start_sec;
        let end_sec = if end_frame < frames.len() {
            frames[end_frame].start_sec
        } else {
            frames[end_frame - 1].start_sec + FRAME_MS as f64 / 1000.0
        };
        let mut rms_sum = 0.0;
        let mut rms_count = 0;
        let mut conf_sum = 0.0;
        for i in start_frame..end_frame {
            let r = frames[i].rms_db;
            if r.is_finite() {
                rms_sum += r;
                rms_count += 1;
            }
            conf_sum += confidences[i];
        }
        let avg_rms_db = if rms_count > 0 {
            rms_sum / rms_count as f64
        } else {
            f64::NEG_INFINITY
        };
        let confidence = conf_sum / (end_frame - start_frame) as f64;
        segments.push(AnalysisSegment {
            start_sec,
            end_sec,
            duration_sec: end_sec - start_sec,
            seg_type,
            confidence,
            avg_rms_db,
            label: seg_type.label().to_string(),
        });
    };

    // `i` is used as a segment boundary value (not just an index), so the
    // range loop is the clearest form here.
    #[allow(clippy::needless_range_loop)]
    for i in 1..frames.len() {
        if types[i] != seg_type {
            close(&mut segments, seg_start, i, seg_type);
            seg_start = i;
            seg_type = types[i];
        }
    }
    close(&mut segments, seg_start, frames.len(), seg_type);
    segments
}

/// Extend `target` to swallow `victim` on the given side. Ports `extendInto`.
fn extend_into(target: &AnalysisSegment, victim: &AnalysisSegment, right: bool) -> AnalysisSegment {
    if right {
        AnalysisSegment {
            end_sec: victim.end_sec,
            duration_sec: victim.end_sec - target.start_sec,
            ..target.clone()
        }
    } else {
        AnalysisSegment {
            start_sec: victim.start_sec,
            duration_sec: target.end_sec - victim.start_sec,
            ..target.clone()
        }
    }
}

/// Merge consecutive same-type segments. Ports `collapseAdjacent`.
fn collapse_adjacent(segments: Vec<AnalysisSegment>) -> Vec<AnalysisSegment> {
    if segments.len() <= 1 {
        return segments;
    }
    let mut out: Vec<AnalysisSegment> = vec![segments[0].clone()];
    for cur in &segments[1..] {
        let last = out.last_mut().unwrap();
        if cur.seg_type == last.seg_type {
            last.end_sec = cur.end_sec;
            last.duration_sec = cur.end_sec - last.start_sec;
            last.confidence = (last.confidence + cur.confidence) / 2.0;
            last.avg_rms_db = if last.avg_rms_db.is_finite() && cur.avg_rms_db.is_finite() {
                (last.avg_rms_db + cur.avg_rms_db) / 2.0
            } else if last.avg_rms_db.is_finite() {
                last.avg_rms_db
            } else {
                cur.avg_rms_db
            };
        } else {
            out.push(cur.clone());
        }
    }
    out
}

/// Merge segments shorter than `MIN_SEGMENT_SEC` into the longer neighbour.
/// Ports `mergeShortSegments` (≤10 convergence passes, then `collapseAdjacent`).
pub fn merge_short_segments(segments: &[AnalysisSegment]) -> Vec<AnalysisSegment> {
    if segments.len() <= 1 {
        return segments.to_vec();
    }
    let mut work = segments.to_vec();
    let mut changed = true;
    let mut iterations = 0;
    while changed && iterations < 10 {
        changed = false;
        iterations += 1;
        let mut next: Vec<AnalysisSegment> = Vec::new();
        let mut i = 0;
        while i < work.len() {
            let seg = work[i].clone();
            if seg.duration_sec >= MIN_SEGMENT_SEC || work.len() == 1 {
                next.push(seg);
                i += 1;
                continue;
            }
            let prev = next.last().cloned();
            let nxt = work.get(i + 1).cloned();
            match (prev, nxt) {
                (None, None) => {
                    next.push(seg);
                }
                (None, Some(nxt)) => {
                    work[i + 1] = extend_into(&nxt, &seg, false);
                    changed = true;
                }
                (Some(prev), None) => {
                    *next.last_mut().unwrap() = extend_into(&prev, &seg, true);
                    changed = true;
                }
                (Some(prev), Some(nxt)) => {
                    if prev.duration_sec >= nxt.duration_sec {
                        *next.last_mut().unwrap() = extend_into(&prev, &seg, true);
                    } else {
                        work[i + 1] = extend_into(&nxt, &seg, false);
                    }
                    changed = true;
                }
            }
            i += 1;
        }
        work = next;
    }
    collapse_adjacent(work)
}

/// Classify → smooth → group → merge. Ports `classifyAndGroup`.
pub fn classify_and_group(frames: &[AnalysisFrame]) -> Vec<AnalysisSegment> {
    if frames.is_empty() {
        return Vec::new();
    }
    let mut raw_types = Vec::with_capacity(frames.len());
    let mut confidences = Vec::with_capacity(frames.len());
    for f in frames {
        let (t, c) = classify_frame(f);
        raw_types.push(t);
        confidences.push(c);
    }
    let smoothed = median_smooth(&raw_types, SMOOTH_HALF_WIN);
    let grouped = group_segments(frames, &smoothed, &confidences);
    merge_short_segments(&grouped)
}

// ── Sermon detection ───────────────────────────────────────────────────────────

/// The picked sermon bounds (seconds).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SermonBounds {
    pub start_sec: f64,
    pub end_sec: f64,
}

/// Pick the most plausible "sermon" speech segment. Ports `findSermonSegmentLocal`
/// exactly, in priority order: (0) sermon-only recording (≥80% speech, <5%
/// music → whole speech span), (1) single ≥3-min speech block, (2) multiple
/// long blocks → prefer those after the 5-min mark, longest wins, (3) longest
/// speech of any length. Returns `None` when there is no speech at all.
pub fn find_sermon_segment(segments: &[AnalysisSegment]) -> Option<SermonBounds> {
    let speeches: Vec<&AnalysisSegment> = segments
        .iter()
        .filter(|s| s.seg_type == SegmentType::Speech)
        .collect();
    if speeches.is_empty() {
        return None;
    }

    // Case 0: sermon-only recording.
    let first = &segments[0];
    let last = &segments[segments.len() - 1];
    let total_dur = last.end_sec - first.start_sec;
    if total_dur > 60.0 {
        let speech_dur: f64 = speeches.iter().map(|s| s.duration_sec).sum();
        let music_dur: f64 = segments
            .iter()
            .filter(|s| s.seg_type == SegmentType::Music)
            .map(|s| s.duration_sec)
            .sum();
        let speech_ratio = speech_dur / total_dur;
        let music_ratio = music_dur / total_dur;
        if speech_ratio >= 0.80 && music_ratio < 0.05 {
            let start = speeches
                .iter()
                .map(|s| s.start_sec)
                .fold(f64::INFINITY, f64::min);
            let end = speeches
                .iter()
                .map(|s| s.end_sec)
                .fold(f64::NEG_INFINITY, f64::max);
            return Some(SermonBounds {
                start_sec: start,
                end_sec: end,
            });
        }
    }

    const MIN_SERMON_SEC: f64 = 180.0;
    let long_candidates: Vec<&&AnalysisSegment> = speeches
        .iter()
        .filter(|s| s.duration_sec >= MIN_SERMON_SEC)
        .collect();

    // Case 1: exactly one long block.
    if long_candidates.len() == 1 {
        let s = long_candidates[0];
        return Some(SermonBounds {
            start_sec: s.start_sec,
            end_sec: s.end_sec,
        });
    }

    // Case 2: multiple long candidates — prefer those after 5 min, longest wins.
    if long_candidates.len() > 1 {
        let after_five: Vec<&&&AnalysisSegment> = long_candidates
            .iter()
            .filter(|s| s.start_sec >= 300.0)
            .collect();
        let winner = if !after_five.is_empty() {
            after_five
                .iter()
                .copied()
                .reduce(|a, b| {
                    if a.duration_sec >= b.duration_sec {
                        a
                    } else {
                        b
                    }
                })
                .unwrap()
        } else {
            long_candidates
                .iter()
                .reduce(|a, b| {
                    if a.duration_sec >= b.duration_sec {
                        a
                    } else {
                        b
                    }
                })
                .unwrap()
        };
        return Some(SermonBounds {
            start_sec: winner.start_sec,
            end_sec: winner.end_sec,
        });
    }

    // Case 3: longest speech of any length.
    let longest = speeches
        .iter()
        .reduce(|a, b| {
            if a.duration_sec >= b.duration_sec {
                a
            } else {
                b
            }
        })
        .unwrap();
    Some(SermonBounds {
        start_sec: longest.start_sec,
        end_sec: longest.end_sec,
    })
}

/// A UI-facing segment, with the sermon block promoted (type `sermon`, label
/// "Preken"). Mirrors `AudioSegment` + `detectSegments`'s remap.
#[derive(Debug, Clone, PartialEq)]
pub struct DetectedSegment {
    pub start: f64,
    pub end: f64,
    pub duration: f64,
    pub label: String,
    /// One of the `SegmentType` labels, or `"sermon"` for the promoted block.
    pub kind: String,
}

fn kind_str(t: SegmentType) -> &'static str {
    match t {
        SegmentType::Silence => "silence",
        SegmentType::Speech => "speech",
        SegmentType::Music => "music",
        SegmentType::Mixed => "mixed",
        SegmentType::Unknown => "unknown",
    }
}

/// Map analysis segments to UI segments, promoting the sermon block. Ports
/// `detectSegments`'s `.map(...)`.
pub fn detect_segments(segments: &[AnalysisSegment]) -> Vec<DetectedSegment> {
    let sermon = find_sermon_segment(segments);
    segments
        .iter()
        .map(|s| {
            let is_sermon = sermon.is_some_and(|b| {
                s.start_sec == b.start_sec
                    && s.end_sec == b.end_sec
                    && s.seg_type == SegmentType::Speech
            });
            DetectedSegment {
                start: s.start_sec,
                end: s.end_sec,
                duration: s.duration_sec,
                label: if is_sermon {
                    "Preken".to_string()
                } else {
                    s.label.clone()
                },
                kind: if is_sermon {
                    "sermon".to_string()
                } else {
                    kind_str(s.seg_type).to_string()
                },
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hann_window_handles_degenerate_sizes_without_nan() {
        assert_eq!(hann_window(0).len(), 0);
        // size 1 would divide by (size-1)=0 → NaN; must be a finite 1.0.
        let w1 = hann_window(1);
        assert_eq!(w1.len(), 1);
        assert!(w1[0].is_finite());
        // Normal sizes are unchanged: endpoints ~0, centre ~1.
        let w = hann_window(8);
        assert!(w.iter().all(|x| x.is_finite()));
        assert!(w[0].abs() < 1e-9);
    }

    // ── FFT ──────────────────────────────────────────────────────────────────

    #[test]
    fn fft_of_dc_signal_puts_all_energy_in_bin_zero() {
        let mut re = vec![1.0_f64; 8];
        let mut im = vec![0.0_f64; 8];
        fft(&mut re, &mut im);
        assert!((re[0] - 8.0).abs() < 1e-9);
        for (k, &v) in re.iter().enumerate().skip(1) {
            assert!(v.abs() < 1e-9, "bin {k} re = {v}");
        }
    }

    #[test]
    fn fft_of_single_cycle_sine_peaks_at_bin_one() {
        let n = 16;
        let mut re: Vec<f64> = (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * i as f64 / n as f64).sin())
            .collect();
        let mut im = vec![0.0_f64; n];
        fft(&mut re, &mut im);
        let mag = |k: usize| (re[k] * re[k] + im[k] * im[k]).sqrt();
        // Energy concentrated at bin 1 (and its mirror n-1).
        assert!(mag(1) > 1.0);
        assert!(mag(2) < 1e-6);
    }

    #[test]
    #[should_panic(expected = "power of 2")]
    fn fft_rejects_non_power_of_two() {
        let mut re = vec![0.0; 3];
        let mut im = vec![0.0; 3];
        fft(&mut re, &mut im);
    }

    // ── features ────────────────────────────────────────────────────────────────

    #[test]
    fn rms_db_of_silence_is_neg_inf() {
        assert_eq!(rms_db(&[0.0; 100]), f64::NEG_INFINITY);
        assert_eq!(rms_db(&[]), f64::NEG_INFINITY);
    }

    #[test]
    fn rms_db_of_full_scale_is_zero() {
        let s = [1.0_f32; 100];
        assert!((rms_db(&s) - 0.0).abs() < 1e-9);
    }

    #[test]
    fn zcr_counts_sign_flips_per_second() {
        // Alternating ±1 at 16 kHz over 1600 samples (0.1 s) → 1599 crossings
        // in 0.1 s → ~15990 /sec.
        let s: Vec<f32> = (0..1600)
            .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        let z = zcr_per_second(&s, 16000);
        assert!((z - 15990.0).abs() < 1.0);
    }

    #[test]
    fn extract_features_drops_partial_trailing_frame() {
        // 1.5 frames worth of samples → only 1 full frame extracted.
        let pcm = vec![0.1_f32; FRAME_SAMPLES + FRAME_SAMPLES / 2];
        let frames = extract_features(&pcm, SAMPLE_RATE, FRAME_MS);
        assert_eq!(frames.len(), 1);
    }

    // ── classifier ──────────────────────────────────────────────────────────────

    #[test]
    fn classifies_low_energy_as_silence() {
        let frame = AnalysisFrame {
            start_sec: 0.0,
            rms_db: -60.0,
            zcr_per_sec: 1000.0,
            spectral_centroid: 1000.0,
            spectral_flux: 10.0,
        };
        let (t, conf) = classify_frame(&frame);
        assert_eq!(t, SegmentType::Silence);
        assert!(conf > 0.6);
    }

    #[test]
    fn classifies_full_speech_signature() {
        let frame = AnalysisFrame {
            start_sec: 0.0,
            rms_db: -20.0,
            zcr_per_sec: 2000.0,
            spectral_centroid: 1500.0,
            spectral_flux: 12.0,
        };
        assert_eq!(classify_frame(&frame).0, SegmentType::Speech);
    }

    #[test]
    fn classifies_sustained_tone_as_music() {
        let frame = AnalysisFrame {
            start_sec: 0.0,
            rms_db: -15.0,
            zcr_per_sec: 800.0,
            spectral_centroid: 4000.0,
            spectral_flux: 2.0,
        };
        assert_eq!(classify_frame(&frame).0, SegmentType::Music);
    }

    // ── smoothing ─────────────────────────────────────────────────────────────────

    #[test]
    fn median_smooth_removes_single_outlier() {
        use SegmentType::*;
        let types = vec![Speech, Speech, Music, Speech, Speech];
        let out = median_smooth(&types, 2);
        // The lone Music frame is outvoted by surrounding Speech.
        assert_eq!(out[2], Speech);
    }

    // ── grouping + merge ───────────────────────────────────────────────────────────

    fn seg(start: f64, end: f64, t: SegmentType) -> AnalysisSegment {
        AnalysisSegment {
            start_sec: start,
            end_sec: end,
            duration_sec: end - start,
            seg_type: t,
            confidence: 0.8,
            avg_rms_db: -20.0,
            label: t.label().to_string(),
        }
    }

    #[test]
    fn merge_absorbs_short_island_into_longer_neighbour() {
        use SegmentType::*;
        let segs = vec![
            seg(0.0, 120.0, Speech),
            seg(120.0, 122.0, Mixed), // 2 s island
            seg(122.0, 240.0, Speech),
        ];
        let merged = merge_short_segments(&segs);
        // Island absorbed; the two Speech blocks collapse into one.
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].seg_type, Speech);
        assert_eq!(merged[0].start_sec, 0.0);
        assert_eq!(merged[0].end_sec, 240.0);
    }

    #[test]
    fn merge_keeps_single_short_segment() {
        let segs = vec![seg(0.0, 2.0, SegmentType::Speech)];
        assert_eq!(merge_short_segments(&segs).len(), 1);
    }

    // ── sermon detection ────────────────────────────────────────────────────────────

    #[test]
    fn sermon_none_without_speech() {
        let segs = vec![seg(0.0, 100.0, SegmentType::Music)];
        assert!(find_sermon_segment(&segs).is_none());
    }

    #[test]
    fn sermon_only_recording_spans_all_speech() {
        use SegmentType::*;
        // 95% speech, no music → whole speech span.
        let segs = vec![
            seg(0.0, 5.0, Silence),
            seg(5.0, 600.0, Speech),
            seg(600.0, 605.0, Silence),
        ];
        let b = find_sermon_segment(&segs).unwrap();
        assert_eq!(b.start_sec, 5.0);
        assert_eq!(b.end_sec, 600.0);
    }

    #[test]
    fn sermon_single_long_block_after_worship() {
        use SegmentType::*;
        let segs = vec![
            seg(0.0, 200.0, Music),     // worship
            seg(200.0, 250.0, Speech),  // announcements (<3 min)
            seg(250.0, 400.0, Music),   // hymn
            seg(400.0, 1600.0, Speech), // sermon (20 min)
        ];
        let b = find_sermon_segment(&segs).unwrap();
        assert_eq!(b.start_sec, 400.0);
        assert_eq!(b.end_sec, 1600.0);
    }

    #[test]
    fn sermon_multiple_long_prefers_after_five_min_longest() {
        use SegmentType::*;
        let segs = vec![
            seg(0.0, 250.0, Speech), // long but before 5 min
            seg(250.0, 300.0, Music),
            seg(300.0, 900.0, Speech), // long, after 5 min, longest
            seg(900.0, 950.0, Music),
            seg(950.0, 1300.0, Speech), // long, after 5 min, shorter
        ];
        let b = find_sermon_segment(&segs).unwrap();
        assert_eq!(b.start_sec, 300.0);
        assert_eq!(b.end_sec, 900.0);
    }

    #[test]
    fn detect_segments_promotes_sermon_block() {
        use SegmentType::*;
        let segs = vec![seg(0.0, 200.0, Music), seg(200.0, 1400.0, Speech)];
        let detected = detect_segments(&segs);
        assert_eq!(detected[0].kind, "music");
        assert_eq!(detected[1].kind, "sermon");
        assert_eq!(detected[1].label, "Preken");
    }
}
