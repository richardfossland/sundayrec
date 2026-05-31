import { describe, expect, it } from "vitest";

import {
  buildIndex,
  groupHits,
  hitContext,
  indexStats,
  searchTranscripts,
  MIN_QUERY_LENGTH,
  type TranscriptSidecar,
} from "./searchIndex";
import type { TranscriptData } from "@/lib/bindings/TranscriptData";

function transcript(
  createdAt: number,
  texts: string[],
  extra: Partial<TranscriptData> = {},
): TranscriptData {
  return {
    version: 1,
    model: "base",
    language: "no",
    duration: texts.length * 5,
    createdAt,
    translated: null,
    segments: texts.map((text, i) => ({
      start: i * 5,
      end: i * 5 + 5,
      text,
    })),
    ...extra,
  };
}

const SIDECARS: TranscriptSidecar[] = [
  {
    basePath: "/recordings/2026-05-03 Pinse",
    transcript: transcript(1_000, [
      "Nåde være med dere og fred fra Gud vår Far.",
      "La oss be sammen i dag om håp.",
    ]),
  },
  {
    basePath: "C:\\recordings\\2026-05-10 Søndag",
    transcript: transcript(3_000, [
      "Vi synger om håp og om kjærlighet.",
      "Håp er det som bærer oss gjennom uken.",
      "Amen.",
    ]),
  },
  {
    basePath: "/recordings/2026-04-26 Tom",
    transcript: transcript(2_000, []),
  },
];

describe("buildIndex", () => {
  it("derives display names from both / and \\ paths and sorts newest-first", () => {
    const index = buildIndex(SIDECARS);
    expect(index.map((e) => e.displayName)).toEqual([
      "2026-05-10 Søndag", // createdAt 3000 — newest
      "2026-04-26 Tom", // createdAt 2000
      "2026-05-03 Pinse", // createdAt 1000 — oldest
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [...SIDECARS];
    buildIndex(input);
    expect(input).toEqual(SIDECARS);
  });
});

describe("indexStats", () => {
  it("counts transcripts and total segments (empty sidecars included)", () => {
    const stats = indexStats(buildIndex(SIDECARS));
    expect(stats).toEqual({ transcriptCount: 3, segmentCount: 5 });
  });
});

describe("hitContext", () => {
  it("returns the original-cased match with no ellipses for a short segment", () => {
    expect(hitContext("La oss be sammen", "OSS")).toEqual({
      before: "La ",
      match: "oss",
      after: " be sammen",
    });
  });

  it("adds ellipses and a context window for a long segment", () => {
    const long = "x".repeat(80) + "NEEDLE" + "y".repeat(80);
    const ctx = hitContext(long, "needle", 10);
    expect(ctx.match).toBe("NEEDLE");
    expect(ctx.before).toBe("…" + "x".repeat(10));
    expect(ctx.after).toBe("y".repeat(10) + "…");
  });

  it("returns the whole text unmatched when the query is absent", () => {
    expect(hitContext("nothing here", "zzz")).toEqual({
      before: "nothing here",
      match: "",
      after: "",
    });
  });
});

describe("searchTranscripts", () => {
  const index = buildIndex(SIDECARS);

  it("finds case-insensitive substring matches across recordings", () => {
    const hits = searchTranscripts(index, "håp");
    // "håp" appears once in Pinse, twice in Søndag → 3 hits.
    expect(hits).toHaveLength(3);
    expect(
      hits.every((h) => h.segment.text.toLowerCase().includes("håp")),
    ).toBe(true);
  });

  it("returns hits with the matched segment index and a highlight context", () => {
    const hits = searchTranscripts(index, "Amen");
    expect(hits).toHaveLength(1);
    expect(hits[0].segIndex).toBe(2);
    expect(hits[0].segment.start).toBe(10);
    expect(hits[0].context.match).toBe("Amen");
  });

  it("ignores queries shorter than the minimum length", () => {
    expect(searchTranscripts(index, "h")).toEqual([]);
    expect(MIN_QUERY_LENGTH).toBe(2);
  });

  it("trims whitespace-only queries to nothing", () => {
    expect(searchTranscripts(index, "   ")).toEqual([]);
  });

  it("caps the number of hits at maxHits", () => {
    const hits = searchTranscripts(index, "håp", { maxHits: 2 });
    expect(hits).toHaveLength(2);
  });
});

describe("groupHits", () => {
  it("groups hits by recording in first-seen (recency) order", () => {
    const index = buildIndex(SIDECARS);
    const groups = groupHits(searchTranscripts(index, "håp"));
    // Søndag is newest so it is scanned first → it leads the grouping.
    expect(groups.map((g) => g.entry.displayName)).toEqual([
      "2026-05-10 Søndag",
      "2026-05-03 Pinse",
    ]);
    expect(groups[0].hits).toHaveLength(2);
    expect(groups[1].hits).toHaveLength(1);
  });

  it("returns an empty array for no hits", () => {
    expect(groupHits([])).toEqual([]);
  });
});
