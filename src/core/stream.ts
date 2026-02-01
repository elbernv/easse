import { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ResilienceBuffer, SSEEvent } from './buffer.js';

export class SSEStream {
  private res: Response;
  private buffer: ResilienceBuffer;

  constructor(res: Response, buffer: ResilienceBuffer) {
    this.res = res;
    this.buffer = buffer;
  }

  /**
   * Initializes the SSE connection by sending the necessary headers.
   */
  init(): void {
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Avoid buffering in proxies like Nginx
    });

    // Initial comment to force header flush and confirm connection
    this.res.write(': connected\n\n');
  }

  /**
   * Sends an event to the client and stores it in the resilience buffer.
   */
  send(data: unknown, event?: string, id?: string, options: { skipBuffer?: boolean } = {}): void {
    const currentId = id || randomUUID();

    // Format frame
    const frame = this.formatFrame(data, currentId, event);

    // Write to response
    this.res.write(frame);

    // Store in buffer for future reconnected clients (unless skipped)
    if (!options.skipBuffer) {
      this.buffer.add({
        id: currentId,
        data,
        event,
      });
    }
  }

  /**
   * Replays a list of historical events (without adding them back to the buffer).
   */
  replay(events: SSEEvent[]): void {
    if (events.length === 0) return;

    const stream = events.map((e) => this.formatFrame(e.data, e.id, e.event)).join('');
    this.res.write(stream);
  }

  private formatFrame(data: unknown, id: string, event?: string): string {
    let frame = '';

    if (event) {
      frame += `event: ${event}\n`;
    }

    frame += `id: ${id}\n`;

    // Data serialization
    let dataStr: string;
    if (typeof data === 'string') {
      dataStr = data;
    } else if (typeof data === 'object') {
      dataStr = JSON.stringify(data);
    } else {
      dataStr = String(data);
    }

    // Handle multi-line data
    frame += dataStr
      .split('\n')
      .map((line) => `data: ${line}`)
      .join('\n');
    frame += '\n\n';

    return frame;
  }
}