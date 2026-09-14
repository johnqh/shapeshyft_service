import { describe, it, expect } from "vitest";
import { toMicroCents } from "../../src/lib/money.js";

describe("toMicroCents", () => {
  it("keeps sub-cent costs that Math.round(cents) would zero", () => {
    // 1,000 tokens against a $1 / 1M-token model is 0.1 cent.
    expect(toMicroCents(0.1)).toBe(100_000n);
  });

  it("converts whole cents", () => {
    expect(toMicroCents(250)).toBe(250_000_000n);
  });

  it("rounds to the nearest micro-cent", () => {
    expect(toMicroCents(0.0000004)).toBe(0n);
    expect(toMicroCents(0.0000006)).toBe(1n);
  });

  it("returns 0n for zero cost", () => {
    expect(toMicroCents(0)).toBe(0n);
  });
});
