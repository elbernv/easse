import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { formatFrame, SSEStream } from './stream.js';

describe('SSEStream', () => {
  const LIMIT = 100;
  const frame = (name: string) => name.padEnd(40, '.');

  class FakeResponse extends EventEmitter {
    writableLength = 0;
    writableEnded = false;
    destroyed = false;
    socketFull = false;
    written: string[] = [];

    write(chunk: string): boolean {
      this.written.push(chunk);
      return !this.socketFull;
    }

    destroy(): void {
      this.destroyed = true;
      this.emit('close');
    }

    /** The client read everything pending: the next write fills the socket again, if `stayFull`. */
    drain(stayFull = true): void {
      this.socketFull = stayFull;
      this.emit('drain');
    }
  }

  function setup() {
    const res = new FakeResponse();
    const stream = new SSEStream(res as unknown as Response, { maxBufferedBytes: LIMIT });
    return { res, stream };
  }

  it('allows exactly the limit and disconnects beyond it', () => {
    const { res, stream } = setup();

    res.writableLength = LIMIT;
    stream.write('x');
    expect(res.destroyed).toBe(false);

    res.writableLength = LIMIT + 1;
    stream.write('x');
    expect(res.destroyed).toBe(true);
  });

  describe('during a replay', () => {
    const frames = ['a', 'b', 'c', 'd', 'e', 'f'].map(frame);

    function setupReplay() {
      const { res, stream } = setup();
      res.socketFull = true;
      stream.writeReplay(frames);
      return { res, stream };
    }

    it('writes only as fast as the client reads', () => {
      const { res } = setupReplay();
      expect(res.written).toEqual(frames.slice(0, 1));

      res.drain();
      expect(res.written).toEqual(frames.slice(0, 2));
    });

    it('writes everything at once if the socket keeps accepting it', () => {
      const { res, stream } = setup();

      stream.writeReplay(frames);

      expect(res.written).toEqual(frames);
    });

    it('holds back anything else until the replay ends, keeping the order', () => {
      const { res, stream } = setupReplay();

      stream.write('later');
      expect(res.written).not.toContain('later');

      for (let i = 0; i < frames.length; i++) res.drain();
      expect(res.written).toEqual([...frames, 'later']);
    });

    it('does not count the size of the replay against the limit', () => {
      const { res, stream } = setupReplay();

      stream.write('x');

      expect(frames.join('').length).toBeGreaterThan(LIMIT);
      expect(res.destroyed).toBe(false);
    });

    it('disconnects a client that falls further behind than the limit', () => {
      const { res, stream } = setupReplay();

      stream.write('x'.repeat(LIMIT));
      expect(res.destroyed).toBe(false);

      stream.write('x');
      expect(res.destroyed).toBe(true);
    });

    it('holds the client to the progress it has already made', () => {
      const { res, stream } = setupReplay();

      res.drain();
      res.drain();
      res.drain();
      stream.write('x'.repeat(LIMIT));
      expect(res.destroyed).toBe(false);

      stream.write('x');
      expect(res.destroyed).toBe(true);
    });

    it('stops writing once the client is gone', () => {
      const { res } = setupReplay();
      const before = res.written.length;

      res.destroy();
      res.emit('drain');

      expect(res.written).toHaveLength(before);
    });

    it('goes back to writing directly once the replay ends', () => {
      const { res, stream } = setup();
      stream.writeReplay(frames);

      stream.write('live');
      expect(res.written.at(-1)).toBe('live');

      res.writableLength = LIMIT + 1;
      stream.write('x');
      expect(res.destroyed).toBe(true);
    });
  });
});

describe('formatFrame', () => {
  it('writes the event, ID and data fields', () => {
    expect(formatFrame({ a: 1 }, { event: 'update', id: '7' })).toBe(
      'event: update\nid: 7\ndata: {"a":1}\n\n',
    );
  });

  it('omits the fields that were not given', () => {
    expect(formatFrame('hello')).toBe('data: hello\n\n');
  });

  it.each([
    ['LF', 'a\nb'],
    ['CRLF', 'a\r\nb'],
    ['CR', 'a\rb'],
  ])('keeps %s line breaks inside data fields', (_name, data) => {
    expect(formatFrame(data)).toBe('data: a\ndata: b\n\n');
  });

  it('does not let a CR in the data inject other fields', () => {
    expect(formatFrame('a\revent: admin')).toBe('data: a\ndata: event: admin\n\n');
  });

  it.each(['a\nb', 'a\rb', 'a\0b'])('rejects the event name %j', (event) => {
    expect(() => formatFrame('x', { event })).toThrow(TypeError);
  });

  it.each(['a\nb', 'a\rb', 'a\0b'])('rejects the ID %j', (id) => {
    expect(() => formatFrame('x', { id })).toThrow(TypeError);
  });

  it.each([
    [0, '0'],
    [false, 'false'],
    [null, 'null'],
    ['', ''],
  ])('serializes %j', (data, expected) => {
    expect(formatFrame(data)).toBe(`data: ${expected}\n\n`);
  });

  it.each([[undefined], [() => {}], [Symbol('x')]])('rejects unserializable data', (data) => {
    expect(() => formatFrame(data)).toThrow(TypeError);
  });
});
