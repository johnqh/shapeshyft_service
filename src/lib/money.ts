/**
 * Convert a floating-point cent amount (what `estimateCost` returns) to integer
 * micro-cents (10^-6 cent). Integer micro-cents are what billing hooks receive:
 * exact to sum, and a sub-cent call is never rounded to nothing.
 */
export function toMicroCents(cents: number): bigint {
  return BigInt(Math.round(cents * 1_000_000));
}
