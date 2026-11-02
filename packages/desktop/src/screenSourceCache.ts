interface SourceWithThumbnail {
  id: string;
  name: string;
  thumbnailDataUrl: string;
}

/** Keep pixels from the last full scan when a metadata-only scan refreshes the list. */
export class ScreenSourceCache<T extends SourceWithThumbnail> {
  private sources: T[] = [];
  private inFlight: Promise<T[]> | null = null;
  private generation = 0;

  read(): T[] {
    return this.sources;
  }

  get generationToken(): number {
    return this.generation;
  }

  commitIfCurrent(generation: number, commit: () => void): boolean {
    if (generation !== this.generation) return false;
    commit();
    return true;
  }

  clear(): void {
    this.generation += 1;
    this.sources = [];
    this.inFlight = null;
  }

  refresh(capture: () => Promise<T[]>): Promise<T[]> {
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    const pending = Promise.resolve().then(capture).then(sources => {
      if (generation !== this.generation) return this.sources;
      const previous = new Map(this.sources.map(source => [source.id, source]));
      this.sources = sources.map(source => {
        const cached = previous.get(source.id);
        return !source.thumbnailDataUrl && cached?.name === source.name
          ? { ...source, thumbnailDataUrl: cached.thumbnailDataUrl }
          : source;
      });
      return this.sources;
    });
    this.inFlight = pending;
    const settled = () => {
      if (generation === this.generation && this.inFlight === pending) this.inFlight = null;
    };
    void pending.then(settled, settled);
    return pending;
  }
}
