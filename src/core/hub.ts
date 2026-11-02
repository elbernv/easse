import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ResilienceBuffer, type ResilienceBufferOptions } from './buffer.js';
import { formatFrame, SSEStream } from './stream.js';

export const RESET_EVENT = 'easse:reset';
export const DEFAULT_HEARTBEAT_MS = 25_000;
export const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

export interface EasseOptions extends ResilienceBufferOptions {
  /** Interval between keep-alive comments, in milliseconds. `0` disables them. */
  heartbeatMs?: number;
  /** Pending bytes allowed per client before it is disconnected. */
  maxBufferedBytes?: number;
}

/**
 * A channel of connected clients sharing one recovery buffer. Use it directly
 * when the `easse()` middleware does not fit.
 */
export class Easse {
  private readonly buffer: ResilienceBuffer;
  private readonly clients = new Set<SSEStream>();
  private readonly heartbeatMs: number;
  private readonly maxBufferedBytes: number;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor({
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
    ...bufferOptions
  }: EasseOptions = {}) {
    if (!Number.isFinite(heartbeatMs) || heartbeatMs < 0) {
      throw new RangeError('easse: heartbeatMs must be zero or a positive number');
    }
    if (!Number.isFinite(maxBufferedBytes) || maxBufferedBytes <= 0) {
      throw new RangeError('easse: maxBufferedBytes must be a positive number');
    }

    this.buffer = new ResilienceBuffer(bufferOptions);
    this.heartbeatMs = heartbeatMs;
    this.maxBufferedBytes = maxBufferedBytes;
  }

  /**
   * Opens the SSE connection and registers the client. If it is reconnecting,
   * replays what it missed or, when that is no longer possible, sends it a
   * `RESET_EVENT` so it can reload its state.
   */
  handle(req: Request, res: Response): SSEStream {
    const header = req.headers['last-event-id'];
    const lastEventId = typeof header === 'string' && header !== '' ? header : undefined;
    const missed = lastEventId === undefined ? undefined : this.buffer.getMissedEvents(lastEventId);

    const stream = new SSEStream(res, {
      maxBufferedBytes: this.maxBufferedBytes,
      lastEventId,
      recovered: Array.isArray(missed),
    });

    stream.init();
    this.addClient(stream);

    res.on('close', () => {
      this.removeClient(stream);
    });

    if (missed === null) {
      // Carries the current ID so the next reconnection starts from here.
      stream.write(formatFrame({}, { event: RESET_EVENT, id: this.buffer.lastId }));
    } else if (missed !== undefined && missed.length > 0) {
      stream.writeReplay(missed.map((e) => e.frame));
    }

    return stream;
  }

  /** Sends an event to every connected client and stores it for recovery. */
  broadcast(data: unknown, event?: string): void {
    const id = randomUUID();
    const frame = formatFrame(data, { event, id });

    this.buffer.add(id, frame);

    for (const client of this.clients) {
      client.write(frame);
    }
  }

  private addClient(stream: SSEStream): void {
    this.clients.add(stream);

    if (this.heartbeatMs > 0 && this.heartbeat === undefined) {
      this.heartbeat = setInterval(() => {
        for (const client of this.clients) {
          client.write(': heartbeat\n\n');
        }
      }, this.heartbeatMs);
      this.heartbeat.unref();
    }
  }

  private removeClient(stream: SSEStream): void {
    this.clients.delete(stream);

    if (this.clients.size === 0) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }
}
