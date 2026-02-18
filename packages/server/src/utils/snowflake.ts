/**
 * Discord-style Snowflake ID Generator
 *
 * Structure (64-bit):
 * - 42 bits: milliseconds since custom epoch (Jan 1, 2024)
 * - 10 bits: worker/process ID
 * - 12 bits: sequence number (per-millisecond)
 *
 * This gives us:
 * - ~139 years of IDs from epoch
 * - 1024 workers
 * - 4096 IDs per millisecond per worker
 */

const EPOCH = 1704067200000n; // Jan 1, 2024 00:00:00 UTC
const WORKER_ID = BigInt(process.pid % 1024);

let sequence = 0n;
let lastTimestamp = -1n;

export function generateSnowflake(): string {
  let timestamp = BigInt(Date.now());

  if (timestamp === lastTimestamp) {
    sequence = (sequence + 1n) & 0xFFFn; // 12-bit mask
    if (sequence === 0n) {
      // Sequence exhausted, wait for next millisecond
      while (timestamp <= lastTimestamp) {
        timestamp = BigInt(Date.now());
      }
    }
  } else {
    sequence = 0n;
  }

  lastTimestamp = timestamp;

  const id =
    ((timestamp - EPOCH) << 22n) |
    (WORKER_ID << 12n) |
    sequence;

  return id.toString();
}

export function snowflakeToTimestamp(snowflake: string): number {
  const id = BigInt(snowflake);
  const timestamp = (id >> 22n) + EPOCH;
  return Number(timestamp);
}
