export const DEFAULT_RETENTION_MS = 30_000;
export const DEFAULT_MAX_EVENTS = 1_000;

export interface ResilienceBufferOptions {
  /** How long events stay available for recovery, in milliseconds. */
  retentionMs?: number;
  /** Maximum number of events kept in memory. */
  maxEvents?: number;
}

export interface BufferedEvent {
  id: string;
  /** The event, already serialized to its SSE wire format. */
  frame: string;
  timestamp: number;
}

/**
 * In-memory window of recent broadcast events, used to replay what a client
 * missed while it was disconnected.
 */
export class ResilienceBuffer {
  private events: BufferedEvent[] = [];
  private latestId: string | undefined;
  private readonly retentionMs: number;
  private readonly maxEvents: number;

  constructor({
    retentionMs = DEFAULT_RETENTION_MS,
    maxEvents = DEFAULT_MAX_EVENTS,
  }: ResilienceBufferOptions = {}) {
    if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
      throw new RangeError('easse: retentionMs must be a positive number');
    }
    if (!Number.isInteger(maxEvents) || maxEvents <= 0) {
      throw new RangeError('easse: maxEvents must be a positive integer');
    }
    this.retentionMs = retentionMs;
    this.maxEvents = maxEvents;
  }

  /** ID of the newest event ever added, even if it has since been evicted. */
  get lastId(): string | undefined {
    return this.latestId;
  }

  add(id: string, frame: string): void {
    this.events.push({ id, frame, timestamp: Date.now() });
    this.latestId = id;

    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    this.evictExpired();
  }

  /**
   * Returns the events that came after `lastId`.
   *
   * @returns The missed events (empty if the client is up to date), or `null`
   * if `lastId` is unknown, meaning the client's gap cannot be determined.
   */
  getMissedEvents(lastId: string): BufferedEvent[] | null {
    this.evictExpired();

    // The newest event has nothing after it, so a client holding its ID has
    // missed nothing, even if the event already expired from the window.
    if (lastId === this.latestId) {
      return [];
    }

    const index = this.events.findIndex((e) => e.id === lastId);
    return index === -1 ? null : this.events.slice(index + 1);
  }

  private evictExpired(): void {
    const now = Date.now();
    const firstLive = this.events.findIndex((e) => now - e.timestamp <= this.retentionMs);

    if (firstLive === -1) {
      this.events = [];
    } else if (firstLive > 0) {
      this.events.splice(0, firstLive);
    }
  }
}
