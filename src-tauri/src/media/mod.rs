//! Media subsystem — the bundled ffmpeg/ffprobe sidecar and the async
//! primitives that the recorder (Spike B) and the MJPEG live-preview (Spike A3)
//! are built on.
//!
//! `ffmpeg` owns binary resolution (env override → bundled sidecar → PATH) and
//! the `tokio::process` spawn helper used to drive ffmpeg with real-time
//! stderr/stdout streaming and a graceful stdin `q` shutdown. `preview` is the
//! MJPEG camera-preview engine built on that spawn primitive.

pub mod camera;
pub mod ffmpeg;
pub mod permissions;
pub mod preview;
