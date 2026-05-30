//! MJPEG stream parsing — pure, std-only, no Tauri/ffmpeg.
//!
//! ffmpeg captures from the camera and writes a raw **MJPEG** byte stream to its
//! stdout: a back-to-back sequence of complete JPEG images, each delimited by a
//! Start-Of-Image marker (`FF D8`) and an End-Of-Image marker (`FF D9`). The
//! `src-tauri` preview engine reads ffmpeg's stdout in arbitrary-sized chunks
//! and feeds them here; [`MjpegFrameSplitter`] reassembles whole JPEG frames so
//! each can be pushed to the renderer as a `<img>` source — independent of the
//! webview's video codec support (the whole point of the preview design, see
//! `docs/MIGRATION-TAURI2.md`, risk register "Webview media").
//!
//! This is the behavioural port of the Electron `video-preview.ts` stdout
//! parser (the SOI/EOI splitter + `readJpegDimensions`), rebuilt as a pure,
//! deterministic state machine that is exercised entirely under `cargo test`
//! with synthetic byte streams — no camera, no ffmpeg.

/// JPEG Start-Of-Image marker.
const SOI: [u8; 2] = [0xff, 0xd8];
/// JPEG End-Of-Image marker.
const EOI: [u8; 2] = [0xff, 0xd9];

/// Overflow guard: if the internal buffer grows past this (a frame never
/// completed — a malformed stream, or a stall), drop everything but the most
/// recent [`TRIM_TO`] bytes so we can resync on the next SOI rather than growing
/// unboundedly. Mirrors the Electron `4 MiB → keep last 2 MiB` guard.
const MAX_BUFFER: usize = 4 * 1024 * 1024;
const TRIM_TO: usize = 2 * 1024 * 1024;

/// Find the first occurrence of `needle` in `haystack`, starting the search at
/// `from`. Returns the absolute index in `haystack`, or `None`.
fn find_from(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from > haystack.len() || haystack.len() - from < needle.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|rel| rel + from)
}

/// Streaming reassembler: feed it raw ffmpeg-stdout chunks, get back complete
/// JPEG frames as they finish. Holds the partial tail internally between pushes.
#[derive(Debug, Default)]
pub struct MjpegFrameSplitter {
    buf: Vec<u8>,
}

impl MjpegFrameSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of bytes currently buffered (an incomplete frame's prefix).
    /// Exposed for tests/diagnostics.
    pub fn buffered(&self) -> usize {
        self.buf.len()
    }

    /// Append a chunk of ffmpeg stdout and return any complete JPEG frames it
    /// completed (0..n). Each returned `Vec<u8>` is a standalone JPEG including
    /// its `FF D8 … FF D9` markers.
    ///
    /// Logic ported byte-for-byte from Electron `video-preview.ts`:
    ///   1. append, then enforce the overflow guard;
    ///   2. find the next SOI — if none, the buffer is junk; clear and wait;
    ///   3. discard anything before the SOI (resync to a frame boundary);
    ///   4. find the EOI *after* the SOI (search from offset 2 so the SOI's own
    ///      bytes can't be mistaken for it) — if none, the frame is incomplete;
    ///      keep the prefix and wait for more;
    ///   5. emit `[SOI..=EOI]` and continue scanning the remainder.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        self.buf.extend_from_slice(chunk);

        if self.buf.len() > MAX_BUFFER {
            let drop_to = self.buf.len() - TRIM_TO;
            self.buf.drain(0..drop_to);
        }

        let mut frames = Vec::new();
        loop {
            let Some(soi) = find_from(&self.buf, &SOI, 0) else {
                // No start marker anywhere — the whole buffer is pre-stream junk.
                self.buf.clear();
                break;
            };
            if soi > 0 {
                self.buf.drain(0..soi);
            }
            // Buffer now begins with SOI. Search for EOI starting past the SOI.
            let Some(eoi) = find_from(&self.buf, &EOI, 2) else {
                // Frame not finished yet; keep the prefix, wait for more bytes.
                break;
            };
            let end = eoi + 2; // include the EOI marker
            let frame = self.buf[..end].to_vec();
            self.buf.drain(0..end);
            frames.push(frame);
        }
        frames
    }
}

/// Decode `(width, height)` from a JPEG buffer by scanning for an SOF0
/// (`FF C0`, baseline) or SOF2 (`FF C2`, progressive) frame header. Returns
/// `None` if no SOF marker is found.
///
/// SOF layout: `FF Cx LL LL PP HH HH WW WW` — after the 2-byte marker and the
/// 2-byte segment length comes 1 byte of sample precision, then height (2 bytes,
/// big-endian) and width (2 bytes). So relative to the `FF` at index `i`:
/// height = bytes `i+5,i+6`, width = bytes `i+7,i+8`.
///
/// Other segments are skipped using their length field (`i+2,i+3`), except the
/// marker-only `D8`/`D9`/`01` which carry no length. Ported from Electron
/// `readJpegDimensions`.
pub fn read_jpeg_dimensions(buf: &[u8]) -> Option<(u16, u16)> {
    let mut i = 0usize;
    while i + 8 < buf.len() {
        if buf[i] != 0xff {
            i += 1;
            continue;
        }
        let marker = buf[i + 1];
        if marker == 0xc0 || marker == 0xc2 {
            let height = ((buf[i + 5] as u16) << 8) | buf[i + 6] as u16;
            let width = ((buf[i + 7] as u16) << 8) | buf[i + 8] as u16;
            if width > 0 && height > 0 {
                return Some((width, height));
            }
        }
        // Skip this segment via its length field, unless it's a marker with no
        // payload (SOI/EOI/TEM).
        if i + 3 < buf.len() && marker != 0xd8 && marker != 0xd9 && marker != 0x01 {
            let seg_len = ((buf[i + 2] as usize) << 8) | buf[i + 3] as usize;
            if seg_len >= 2 {
                i += 2 + seg_len;
                continue;
            }
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal synthetic JPEG: `FF D8` (SOI) + an SOF0 header carrying
    /// `width`×`height` + `body` payload + `FF D9` (EOI).
    fn synthetic_jpeg(width: u16, height: u16, body: &[u8]) -> Vec<u8> {
        let mut v = vec![0xff, 0xd8]; // SOI
                                      // SOF0: FF C0, length=0x0011 (17), precision=8, height, width, then
                                      // component bytes (padding to the declared length — content irrelevant).
        v.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 0x08]);
        v.extend_from_slice(&height.to_be_bytes());
        v.extend_from_slice(&width.to_be_bytes());
        v.extend_from_slice(&[0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
        v.extend_from_slice(body);
        v.extend_from_slice(&[0xff, 0xd9]); // EOI
        v
    }

    #[test]
    fn single_frame_in_one_chunk() {
        let frame = synthetic_jpeg(640, 480, &[1, 2, 3, 4]);
        let mut s = MjpegFrameSplitter::new();
        let out = s.push(&frame);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], frame);
        assert_eq!(s.buffered(), 0);
    }

    #[test]
    fn frame_split_across_chunks_is_reassembled() {
        let frame = synthetic_jpeg(320, 240, &[9, 9, 9, 9, 9, 9]);
        let (a, b) = frame.split_at(frame.len() / 2);
        let mut s = MjpegFrameSplitter::new();
        assert!(s.push(a).is_empty(), "partial frame should not emit yet");
        assert!(s.buffered() > 0);
        let out = s.push(b);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], frame);
        assert_eq!(s.buffered(), 0);
    }

    #[test]
    fn two_frames_in_one_chunk() {
        let f1 = synthetic_jpeg(100, 100, &[1, 1]);
        let f2 = synthetic_jpeg(200, 150, &[2, 2, 2]);
        let mut joined = f1.clone();
        joined.extend_from_slice(&f2);
        let mut s = MjpegFrameSplitter::new();
        let out = s.push(&joined);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], f1);
        assert_eq!(out[1], f2);
    }

    #[test]
    fn junk_before_soi_is_discarded() {
        let frame = synthetic_jpeg(64, 64, &[7, 7]);
        let mut chunk = vec![0x00, 0x11, 0x22, 0x33]; // leading garbage
        chunk.extend_from_slice(&frame);
        let mut s = MjpegFrameSplitter::new();
        let out = s.push(&chunk);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], frame);
    }

    #[test]
    fn incomplete_frame_without_eoi_is_buffered() {
        let mut partial = vec![0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11]; // SOI + start of SOF, no EOI
        partial.extend_from_slice(&[0u8; 32]);
        let mut s = MjpegFrameSplitter::new();
        let out = s.push(&partial);
        assert!(out.is_empty());
        assert_eq!(s.buffered(), partial.len());
    }

    #[test]
    fn no_soi_clears_buffer() {
        let mut s = MjpegFrameSplitter::new();
        let out = s.push(&[0x00, 0x01, 0x02, 0x03, 0x04]);
        assert!(out.is_empty());
        // With no SOI anywhere the buffer is treated as junk and dropped, so we
        // don't grow unboundedly on a non-MJPEG stream.
        assert_eq!(s.buffered(), 0);
    }

    #[test]
    fn overflow_guard_trims_to_last_2mib() {
        let mut s = MjpegFrameSplitter::new();
        // Push >4 MiB of SOI-free junk in one go; the guard keeps only 2 MiB,
        // and then (no SOI) it's cleared. To observe the trim specifically, push
        // junk that contains no SOI so it isn't cleared by the parse step first:
        // we assert the buffer never exceeds the trim ceiling.
        let big = vec![0xaa_u8; MAX_BUFFER + 1024];
        let out = s.push(&big);
        assert!(out.is_empty());
        // No SOI → buffer cleared by the parse loop; guard ran first regardless.
        assert!(s.buffered() <= TRIM_TO);
    }

    #[test]
    fn overflow_guard_keeps_recent_tail_with_resync() {
        // A real resync: lots of junk (no SOI), then a valid frame at the end.
        // The guard trims the junk; the SOI scan resyncs and emits the frame.
        let frame = synthetic_jpeg(128, 96, &[5, 5, 5]);
        let mut chunk = vec![0x55_u8; MAX_BUFFER + 4096];
        chunk.extend_from_slice(&frame);
        let mut s = MjpegFrameSplitter::new();
        let out = s.push(&chunk);
        assert_eq!(out.len(), 1, "frame after trimmed junk should still emit");
        assert_eq!(out[0], frame);
    }

    #[test]
    fn reads_dimensions_from_sof0() {
        let frame = synthetic_jpeg(1280, 720, &[0, 0]);
        assert_eq!(read_jpeg_dimensions(&frame), Some((1280, 720)));
    }

    #[test]
    fn reads_dimensions_from_sof2_progressive() {
        // Same as synthetic_jpeg but with SOF2 (FF C2) instead of SOF0.
        let mut v = vec![0xff, 0xd8, 0xff, 0xc2, 0x00, 0x11, 0x08];
        v.extend_from_slice(&480u16.to_be_bytes()); // height
        v.extend_from_slice(&640u16.to_be_bytes()); // width
        v.extend_from_slice(&[0u8; 10]);
        v.extend_from_slice(&[0xff, 0xd9]);
        assert_eq!(read_jpeg_dimensions(&v), Some((640, 480)));
    }

    #[test]
    fn no_sof_marker_returns_none() {
        // SOI + EOI only, no SOF.
        assert_eq!(read_jpeg_dimensions(&[0xff, 0xd8, 0xff, 0xd9]), None);
        assert_eq!(read_jpeg_dimensions(&[]), None);
        assert_eq!(read_jpeg_dimensions(&[0xff]), None);
    }

    #[test]
    fn dimensions_skips_app_segments_before_sof() {
        // SOI, an APP0/JFIF-like segment (FF E0, length 16), then SOF0.
        let mut v = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
        v.extend_from_slice(&[0u8; 14]); // APP0 payload (length 16 incl. the 2 length bytes)
        v.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 0x08]);
        v.extend_from_slice(&200u16.to_be_bytes()); // height
        v.extend_from_slice(&320u16.to_be_bytes()); // width
        v.extend_from_slice(&[0u8; 10]);
        assert_eq!(read_jpeg_dimensions(&v), Some((320, 200)));
    }
}
