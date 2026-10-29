import { describe, expect, it } from "vitest";
import { GuestSlots } from "../../src/ws/guest-limits.js";

describe("guest WS slots", () => {
  it("caps concurrent guests per source", () => {
    const slots = new GuestSlots({ perSource: 2, total: 10 });
    expect(slots.acquire("203.0.113.7")).toBe(true);
    expect(slots.acquire("203.0.113.7")).toBe(true);
    expect(slots.acquire("203.0.113.7")).toBe(false);
    expect(slots.acquire("198.51.100.1")).toBe(true);
    slots.release("203.0.113.7");
    expect(slots.acquire("203.0.113.7")).toBe(true);
  });

  it("caps concurrent guests in total", () => {
    const slots = new GuestSlots({ perSource: 5, total: 3 });
    expect(["a", "b", "c"].map((s) => slots.acquire(s))).toEqual([true, true, true]);
    expect(slots.acquire("d")).toBe(false);
    expect(slots.size).toBe(3);
  });

  it("ignores releases that were never acquired", () => {
    const slots = new GuestSlots({ perSource: 1, total: 1 });
    slots.release("x");
    expect(slots.size).toBe(0);
    expect(slots.acquire("x")).toBe(true);
    slots.release("x");
    slots.release("x");
    expect(slots.size).toBe(0);
  });
});
