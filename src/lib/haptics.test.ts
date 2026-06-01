import { describe, expect, it, vi } from "vitest";

import { makeHapticThrottle, type HapticPattern } from "./haptics";

describe("makeHapticThrottle", () => {
  it("fires the first tap immediately", () => {
    const fired: HapticPattern[] = [];
    const tap = makeHapticThrottle(
      100,
      (p) => fired.push(p),
      () => 0,
    );
    expect(tap("generic")).toBe(true);
    expect(fired).toEqual(["generic"]);
  });

  it("drops taps that arrive inside the gap, then fires once past it", () => {
    const fired: HapticPattern[] = [];
    let now = 0;
    const tap = makeHapticThrottle(
      100,
      (p) => fired.push(p),
      () => now,
    );

    expect(tap("alignment")).toBe(true); // t=0 → fires
    now = 40;
    expect(tap("alignment")).toBe(false); // inside 100 ms gap → dropped
    now = 90;
    expect(tap("alignment")).toBe(false); // still inside → dropped
    now = 100;
    expect(tap("alignment")).toBe(true); // exactly at the gap → fires
    now = 150;
    expect(tap("alignment")).toBe(false); // new window → dropped

    // Only the two that crossed the gap actually fired.
    expect(fired).toEqual(["alignment", "alignment"]);
  });

  it("keeps the latest pattern when it does fire", () => {
    const fire = vi.fn();
    let now = 0;
    const tap = makeHapticThrottle(50, fire, () => now);
    now = 0;
    tap("generic");
    now = 60;
    tap("levelChange");
    expect(fire).toHaveBeenNthCalledWith(1, "generic");
    expect(fire).toHaveBeenNthCalledWith(2, "levelChange");
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("a zero gap never throttles", () => {
    const fire = vi.fn();
    const tap = makeHapticThrottle(0, fire, () => 0);
    expect(tap("generic")).toBe(true);
    expect(tap("generic")).toBe(true);
    expect(tap("generic")).toBe(true);
    expect(fire).toHaveBeenCalledTimes(3);
  });
});
