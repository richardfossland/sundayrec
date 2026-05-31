import { describe, expect, it } from "vitest";

import {
  fileName,
  filterHistory,
  historyStats,
  isVideoRow,
  isoDate,
  pairAudioVideo,
} from "./historyFilter";
import type { RecordingRow } from "@/lib/bindings/RecordingRow";

let seq = 0;
function row(overrides: Partial<RecordingRow> = {}): RecordingRow {
  seq += 1;
  return {
    id: `r${seq}`,
    file_path: `/rec/2026-05-31_${seq}.mp3`,
    device_name: "Soundcraft",
    started_at: 1_700_000_000_000,
    duration_ms: 60_000,
    byte_size: 1_000_000,
    created_at: 1_700_000_000_000,
    note: null,
    ...overrides,
  };
}

describe("fileName", () => {
  it("returns the basename for both separators", () => {
    expect(fileName("/a/b/c.mp3")).toBe("c.mp3");
    expect(fileName("C:\\rec\\x.mp4")).toBe("x.mp4");
    expect(fileName("bare.wav")).toBe("bare.wav");
  });
});

describe("isoDate", () => {
  it("formats an epoch as YYYY-MM-DD and an empty/zero stamp as ''", () => {
    // 1700000000000 ms = 2023-11-14T...Z
    expect(isoDate(1_700_000_000_000)).toBe("2023-11-14");
    expect(isoDate(0)).toBe("");
  });
});

describe("isVideoRow", () => {
  it("detects a video by container extension", () => {
    expect(isVideoRow(row({ file_path: "/rec/x.mp4" }))).toBe(true);
    expect(isVideoRow(row({ file_path: "/rec/x.mov" }))).toBe(true);
    expect(isVideoRow(row({ file_path: "/rec/x.mp3" }))).toBe(false);
  });

  it("detects a video by the 'Video' note tag (case-insensitive)", () => {
    expect(isVideoRow(row({ file_path: "/rec/x.mka", note: "video" }))).toBe(
      true,
    );
    expect(isVideoRow(row({ file_path: "/rec/x.mka", note: "Notat" }))).toBe(
      false,
    );
  });
});

describe("filterHistory", () => {
  const rows = [
    row({ file_path: "/rec/Pinse_2026-05-03.mp3", note: "Prøveopptak" }),
    row({ file_path: "/rec/Søndag_2026-05-10.mp3", note: null }),
    row({
      file_path: "/rec/Julaften.mp3",
      started_at: Date.UTC(2026, 11, 24, 11, 0),
      note: "Spesial",
    }),
  ];

  it("returns a copy of all rows for an empty query", () => {
    const out = filterHistory(rows, "   ");
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });

  it("matches on filename case-insensitively", () => {
    expect(filterHistory(rows, "pinse").map((r) => r.file_path)).toEqual([
      "/rec/Pinse_2026-05-03.mp3",
    ]);
  });

  it("matches on the note text", () => {
    expect(filterHistory(rows, "spesial").map((r) => r.file_path)).toEqual([
      "/rec/Julaften.mp3",
    ]);
  });

  it("matches on the ISO date derived from started_at", () => {
    expect(filterHistory(rows, "2026-12-24").map((r) => r.file_path)).toEqual([
      "/rec/Julaften.mp3",
    ]);
  });

  it("returns no rows when nothing matches", () => {
    expect(filterHistory(rows, "zzz-nope")).toEqual([]);
  });
});

describe("pairAudioVideo", () => {
  it("pairs an adjacent audio + video sharing a started_at (audio leads)", () => {
    const at = 1_700_000_111_000;
    const video = row({ file_path: "/rec/s.mp4", started_at: at });
    const audio = row({ file_path: "/rec/s.mp3", started_at: at });
    // Newest-first order can present video before audio — still pairs.
    const paired = pairAudioVideo([video, audio]);
    expect(paired).toHaveLength(1);
    expect(paired[0].audio.file_path).toBe("/rec/s.mp3");
    expect(paired[0].video?.file_path).toBe("/rec/s.mp4");
  });

  it("does not pair rows with different start times", () => {
    const a = row({ file_path: "/rec/a.mp4", started_at: 1 });
    const b = row({ file_path: "/rec/b.mp3", started_at: 2 });
    const paired = pairAudioVideo([a, b]);
    expect(paired).toHaveLength(2);
    expect(paired.every((p) => p.video === null)).toBe(true);
  });

  it("does not pair two audio rows even at the same start time", () => {
    const at = 5;
    const paired = pairAudioVideo([
      row({ file_path: "/rec/a.mp3", started_at: at }),
      row({ file_path: "/rec/b.mp3", started_at: at }),
    ]);
    expect(paired).toHaveLength(2);
  });

  it("leaves a lone recording unpaired", () => {
    const paired = pairAudioVideo([row({ file_path: "/rec/solo.mp3" })]);
    expect(paired).toHaveLength(1);
    expect(paired[0].video).toBeNull();
  });
});

describe("historyStats", () => {
  it("counts paired sessions once and sums audio duration", () => {
    const at = 100;
    const stats = historyStats([
      row({ file_path: "/rec/s.mp4", started_at: at, duration_ms: 90_000 }),
      row({ file_path: "/rec/s.mp3", started_at: at, duration_ms: 80_000 }),
      row({ file_path: "/rec/lone.mp3", started_at: 200, duration_ms: 30_000 }),
    ]);
    // One pair (counts once, audio's 80s) + one lone (30s) = 2 sessions, 110s.
    expect(stats.count).toBe(2);
    expect(stats.totalDurationMs).toBe(110_000);
    expect(stats.lastRecordedAt).toBe(200);
  });

  it("skips null durations and reports null last for an empty history", () => {
    const stats = historyStats([
      row({ started_at: 10, duration_ms: null }),
      row({ started_at: 20, duration_ms: 5_000 }),
    ]);
    expect(stats.totalDurationMs).toBe(5_000);
    expect(historyStats([]).lastRecordedAt).toBeNull();
  });
});
