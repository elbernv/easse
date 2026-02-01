export interface SSEEvent {
  id: string;
  data: unknown;
  event?: string;
  retry?: number;
  timestamp: number;
}

export type InputEvent = Omit<SSEEvent, 'timestamp'>;

export class ResilienceBuffer {
  private events: SSEEvent[] = [];
  private readonly retentionMs: number;
  private readonly maxCapacity: number = 5;

  constructor(retentionMs: number = 5000) {
    if (retentionMs > 10000) {
      throw new Error('easse: Resilience buffer retention cannot exceed 10000ms');
    }
    this.retentionMs = retentionMs;
  }

  add(event: InputEvent): void {
    const timestamp = Date.now();

    this.events.push({ ...event, timestamp });

    // Apply constraints: first by quantity (max 5), then by time

    this.applyConstraints();
  }

  getMissedEvents(lastId: string): SSEEvent[] {
    const index = this.events.findIndex((e) => e.id === lastId);

    if (index === -1) {
      return [];
    }

    return this.events.slice(index + 1);
  }

  private applyConstraints(): void {
    const now = Date.now();

    // 1. Capacity limit (Max 5 items)

    if (this.events.length > this.maxCapacity) {
      this.events.shift(); // Remove the oldest
    }

    // 2. Time limit (Eviction by age)

    if (this.events.length > 0) {
      this.events = this.events.filter((e) => now - e.timestamp <= this.retentionMs);
    }
  }
}
