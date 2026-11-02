import type { Response } from 'express';

export interface FrameOptions {
  event?: string;
  id?: string;
}

export interface SSEStreamOptions {
  /** Pending bytes allowed for this client before it is disconnected. */
  maxBufferedBytes: number;
  lastEventId?: string;
  recovered?: boolean;
}

function assertSingleLine(name: string, value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new TypeError(`easse: ${name} cannot contain line breaks or NUL characters`);
  }
}

function serialize(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }

  const json = JSON.stringify(data);
  if (json === undefined) {
    throw new TypeError(`easse: cannot serialize data of type ${typeof data}`);
  }
  return json;
}

/**
 * Serializes an event to the SSE wire format.
 *
 * @throws {TypeError} If `event` or `id` could break out of their field, or if
 * `data` has no JSON representation.
 */
export function formatFrame(data: unknown, { event, id }: FrameOptions = {}): string {
  let frame = '';

  if (event !== undefined) {
    assertSingleLine('event', event);
    frame += `event: ${event}\n`;
  }

  if (id !== undefined) {
    assertSingleLine('id', id);
    frame += `id: ${id}\n`;
  }

  // The SSE spec treats CRLF, LF and CR alike as line terminators.
  for (const line of serialize(data).split(/\r\n|\r|\n/)) {
    frame += `data: ${line}\n`;
  }

  return `${frame}\n`;
}

/** A single client connection. */
export class SSEStream {
  /** The `Last-Event-ID` sent by the client, if it is reconnecting. */
  readonly lastEventId: string | undefined;
  /** Whether the client reconnected and its missed events were replayed. */
  readonly recovered: boolean;

  private readonly res: Response;
  private readonly maxBufferedBytes: number;
  private catchingUp = false;
  /** What is waiting for the client to read, while it catches up. */
  private queue: string[] = [];
  private queuedBytes = 0;
  private lowestQueuedBytes = 0;

  constructor(res: Response, options: SSEStreamOptions) {
    this.res = res;
    this.maxBufferedBytes = options.maxBufferedBytes;
    this.lastEventId = options.lastEventId;
    this.recovered = options.recovered ?? false;
  }

  /** Sends the response headers and opens the stream. */
  init(): void {
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Forces the headers out so the client knows the connection is open.
    this.res.write(': connected\n\n');
  }

  /**
   * Sends an event to this connection only. It is never stored for replay, and
   * unless `id` is given it leaves the client's recovery position untouched.
   */
  send(data: unknown, event?: string, id?: string): void {
    this.write(formatFrame(data, { event, id }));
  }

  /**
   * Writes an already serialized chunk. A client that has stopped reading is
   * disconnected instead of letting its pending data grow without limit; once
   * it catches up, it can reconnect and recover what it missed.
   *
   * @internal
   */
  write(chunk: string): void {
    if (this.res.destroyed || this.res.writableEnded) {
      return;
    }

    if (this.catchingUp) {
      this.enqueue(chunk);
      return;
    }

    if (this.res.writableLength > this.maxBufferedBytes) {
      this.res.destroy();
      return;
    }

    this.res.write(chunk);
  }

  /**
   * Sends the events a reconnecting client missed, only as fast as it reads
   * them. Until it is done, anything else written to this stream waits its turn.
   * The frames are shared with the buffer, so a replay costs almost no memory.
   *
   * @internal
   */
  writeReplay(frames: string[]): void {
    this.queue = [...frames];
    this.queuedBytes = frames.reduce((total, frame) => total + frame.length, 0);
    this.lowestQueuedBytes = this.queuedBytes;
    this.catchingUp = true;

    this.res.once('close', () => {
      this.queue = [];
    });
    this.pump();
  }

  /** A client catching up only has to keep making progress, whatever the size of its replay. */
  private enqueue(chunk: string): void {
    this.queue.push(chunk);
    this.queuedBytes += chunk.length;

    if (this.queuedBytes - this.lowestQueuedBytes > this.maxBufferedBytes) {
      this.res.destroy();
    }
  }

  private readonly pump = (): void => {
    while (this.queue.length > 0) {
      if (this.res.destroyed || this.res.writableEnded) {
        return;
      }

      const frame = this.queue.shift() as string;
      this.queuedBytes -= frame.length;
      this.lowestQueuedBytes = Math.min(this.lowestQueuedBytes, this.queuedBytes);

      if (!this.res.write(frame)) {
        this.res.once('drain', this.pump);
        return;
      }
    }

    this.catchingUp = false;
  };
}
