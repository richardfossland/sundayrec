import { describe, expect, it } from "vitest";

import {
  WAKE_LEAD_MINUTES,
  confidenceLevel,
  startTime,
  timeUntil,
  wakeTime,
} from "./schedule.confidence";

describe("confidenceLevel", () => {
  it("is 'none' when nothing is scheduled", () => {
    expect(
      confidenceLevel({ nextIso: null, wakeEnabled: true, canWake: true }),
    ).toBe("none");
    expect(
      confidenceLevel({ nextIso: undefined, wakeEnabled: true, canWake: true }),
    ).toBe("none");
  });

  it("is 'ready' only when wake is enabled AND the host can wake", () => {
    expect(
      confidenceLevel({
        nextIso: "2026-06-07T11:00:00",
        wakeEnabled: true,
        canWake: true,
      }),
    ).toBe("ready");
  });

  it("is 'needsOn' when there is a recording but wake can't be guaranteed", () => {
    // feature off
    expect(
      confidenceLevel({
        nextIso: "2026-06-07T11:00:00",
        wakeEnabled: false,
        canWake: true,
      }),
    ).toBe("needsOn");
    // host can't wake from sleep
    expect(
      confidenceLevel({
        nextIso: "2026-06-07T11:00:00",
        wakeEnabled: true,
        canWake: false,
      }),
    ).toBe("needsOn");
  });
});

describe("timeUntil", () => {
  const now = new Date("2026-06-01T09:00:00");

  it("returns null for missing/unparseable input", () => {
    expect(timeUntil(null, now)).toBeNull();
    expect(timeUntil(undefined, now)).toBeNull();
    expect(timeUntil("not-a-date", now)).toBeNull();
  });

  it("buckets to days when far out", () => {
    expect(timeUntil("2026-06-07T11:00:00", now)).toEqual({
      unit: "days",
      value: 6,
    });
    // exactly 2 days ahead → 2 days
    expect(timeUntil("2026-06-03T09:00:00", now)).toEqual({
      unit: "days",
      value: 2,
    });
  });

  it("buckets to hours when under a day", () => {
    expect(timeUntil("2026-06-01T12:30:00", now)).toEqual({
      unit: "hours",
      value: 3,
    });
  });

  it("buckets to minutes when under an hour", () => {
    expect(timeUntil("2026-06-01T09:20:00", now)).toEqual({
      unit: "minutes",
      value: 20,
    });
  });

  it("reports 'now' at the threshold and 'past' once behind", () => {
    expect(timeUntil("2026-06-01T09:00:00", now)).toEqual({
      unit: "now",
      value: 0,
    });
    expect(timeUntil("2026-06-01T08:00:00", now)).toEqual({
      unit: "past",
      value: 0,
    });
  });
});

describe("wakeTime", () => {
  it("subtracts the lead minutes from the start", () => {
    expect(wakeTime("2026-06-07T11:00:00")).toBe("10:50");
    expect(wakeTime("2026-06-07T11:00:00", 5)).toBe("10:55");
  });

  it("uses the backend lead constant by default", () => {
    expect(WAKE_LEAD_MINUTES).toBe(10);
    expect(wakeTime("2026-06-07T11:00:00")).toBe("10:50");
  });

  it("handles wrapping across the hour", () => {
    expect(wakeTime("2026-06-07T11:05:00")).toBe("10:55");
  });

  it("returns null for missing/bad input", () => {
    expect(wakeTime(null)).toBeNull();
    expect(wakeTime("nope")).toBeNull();
  });
});

describe("startTime", () => {
  it("formats the start clock", () => {
    expect(startTime("2026-06-07T11:00:00")).toBe("11:00");
    expect(startTime("2026-06-07T09:05:00")).toBe("09:05");
  });

  it("returns null for missing/bad input", () => {
    expect(startTime(undefined)).toBeNull();
    expect(startTime("bad")).toBeNull();
  });
});
