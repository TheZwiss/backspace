/** Throttle source frames to a target cadence without accumulating drift. */
export class FrameCadence {
  private _rate: number;
  private nextDeadline: number | null = null;
  private lastDrawAt: number | null = null;

  constructor(rate: number) {
    this._rate = isValidRate(rate) ? rate : 60;
  }

  get rate(): number {
    return this._rate;
  }

  setRate(rate: number): void {
    if (!isValidRate(rate) || rate === this._rate) return;

    this._rate = rate;
    if (this.lastDrawAt !== null) {
      this.nextDeadline = this.lastDrawAt + 1000 / rate;
    }
  }

  shouldDraw(now: number): boolean {
    if (!Number.isFinite(now)) return false;
    if (this.nextDeadline === null || this.lastDrawAt === null) {
      this.lastDrawAt = now;
      this.nextDeadline = now + 1000 / this._rate;
      return true;
    }
    const interval = 1000 / this._rate;
    const tolerance = interval * 1e-9;
    if (now + tolerance < this.nextDeadline) return false;

    this.lastDrawAt = now;
    // Move the deadline forward by whole intervals to keep the long-term
    // cadence, while producing only one draw after a delayed callback.
    const intervalsElapsed = Math.floor((now - this.nextDeadline + tolerance) / interval) + 1;
    this.nextDeadline += intervalsElapsed * interval;
    return true;
  }
}

function isValidRate(rate: number): boolean {
  return Number.isFinite(rate) && rate > 0;
}
