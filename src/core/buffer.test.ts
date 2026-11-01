import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResilienceBuffer } from './buffer.js';

const ids = (events: { id: string }[] | null) => events?.map((e) => e.id) ?? null;

describe('ResilienceBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the events that came after the given ID', () => {
    const buffer = new ResilienceBuffer();
    buffer.add('1', 'a');
    buffer.add('2', 'b');
    buffer.add('3', 'c');

    expect(buffer.getMissedEvents('1')?.map((e) => e.frame)).toEqual(['b', 'c']);
  });

  it('returns null for an unknown ID', () => {
    const buffer = new ResilienceBuffer();
    buffer.add('1', 'a');

    expect(buffer.getMissedEvents('unknown')).toBeNull();
  });

  it('returns null when the buffer is empty, as after a server restart', () => {
    expect(new ResilienceBuffer().getMissedEvents('1')).toBeNull();
  });

  it('evicts the oldest events beyond maxEvents', () => {
    const buffer = new ResilienceBuffer({ maxEvents: 3 });
    ['1', '2', '3', '4'].forEach((id) => buffer.add(id, id));

    expect(buffer.getMissedEvents('1')).toBeNull();
    expect(ids(buffer.getMissedEvents('2'))).toEqual(['3', '4']);
  });

  it('expires events on read, without needing a new event', () => {
    const buffer = new ResilienceBuffer({ retentionMs: 100 });
    buffer.add('1', 'a');
    buffer.add('2', 'b');

    vi.advanceTimersByTime(101);

    expect(buffer.getMissedEvents('1')).toBeNull();
  });

  it('keeps events exactly at the retention limit', () => {
    const buffer = new ResilienceBuffer({ retentionMs: 100 });
    buffer.add('1', 'a');
    buffer.add('2', 'b');

    vi.advanceTimersByTime(100);

    expect(ids(buffer.getMissedEvents('1'))).toEqual(['2']);
  });

  it('treats the newest ID as up to date even after it expires', () => {
    const buffer = new ResilienceBuffer({ retentionMs: 100 });
    buffer.add('1', 'a');

    vi.advanceTimersByTime(101);

    expect(buffer.getMissedEvents('1')).toEqual([]);
    expect(buffer.lastId).toBe('1');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects retentionMs of %s', (value) => {
    expect(() => new ResilienceBuffer({ retentionMs: value })).toThrow(RangeError);
  });

  it.each([0, -1, 1.5])('rejects maxEvents of %s', (value) => {
    expect(() => new ResilienceBuffer({ maxEvents: value })).toThrow(RangeError);
  });
});
