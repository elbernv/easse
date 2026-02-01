import { Request, Response } from 'express';
import { ResilienceBuffer } from './buffer.js';
import { SSEStream } from './stream.js';
import { randomUUID } from 'node:crypto';

export interface EasseOptions {
  retentionMs?: number;
}

/**
 * Main class to manage SSE channels with resilience.
 * Allows explicit usage (without middleware) and facilitates broadcasting.
 */
export class Easse {
  private buffer: ResilienceBuffer;
  private clients: Set<SSEStream> = new Set();

  constructor(options: EasseOptions = {}) {
    this.buffer = new ResilienceBuffer(options.retentionMs);
  }

  /**
   * Handles an incoming HTTP request and establishes the SSE connection.
   * Automatically performs the handshake and recovery of missed events.
   *
   * @param req Express Request
   * @param res Express Response
   * @returns The created stream instance
   */
  handle(req: Request, res: Response): SSEStream {
    const stream = new SSEStream(res, this.buffer);

    // 1. Initialize connection (headers, etc.)
    stream.init();

    // 2. Register client for broadcast
    this.clients.add(stream);

    // 3. Auto-cleanup on connection close
    req.on('close', () => {
      this.clients.delete(stream);
    });

    // 4. Resilience Logic (Recovery)
    const lastId = req.headers['last-event-id'] as string;

    if (lastId) {
      const missedEvents = this.buffer.getMissedEvents(lastId);
      if (missedEvents.length > 0) {
        stream.replay(missedEvents);
      }
    }

    return stream;
  }

  /**
   * Sends an event to ALL currently connected clients.
   * Adds it only once to the resilience buffer.
   */
  broadcast(data: unknown, event?: string): void {
    const id = randomUUID();

    // 1. Store in buffer (once)
    this.buffer.add({ id, data, event });

    // 2. Send to all clients (without re-buffering)
    for (const client of this.clients) {
      // We use skipBuffer to avoid duplicating in the buffer for each client
      client.send(data, event, id, { skipBuffer: true });
    }
  }
}