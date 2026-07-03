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
 *
 * IMPORTANT: The worker ID MUST be unique per instance to prevent ID
 * collisions in a federation setup. It is generated randomly at first boot
 * and persisted to the database. Call setWorkerId() before generating any IDs.
 */

const EPOCH = 1704067200000n; // Jan 1, 2024 00:00:00 UTC

let WORKER_ID: bigint | null = null;
let sequence = 0n;
let lastTimestamp = -1n;

/**
 * Set the worker ID for this instance. Must be called once during server
 * startup, after the database is initialized, before any IDs are generated.
 * The value is persisted in instance_settings.worker_id.
 */
export function setWorkerId(id: number): void {
  if (id < 0 || id > 1023) {
    throw new Error(`Worker ID must be 0-1023, got ${id}`);
  }
  WORKER_ID = BigInt(id);
}

export function generateSnowflake(): string {
  if (WORKER_ID === null) {
    throw new Error('Snowflake worker ID not initialized — call setWorkerId() during startup');
  }

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
