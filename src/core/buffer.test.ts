import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ResilienceBuffer } from './buffer.js';

describe('ResilienceBuffer', () => {
  let buffer: ResilienceBuffer;

  beforeEach(() => {
    // 500ms retention for testing
    buffer = new ResilienceBuffer(500);
  });

  it('should initialize with default options', () => {
    const defaultBuffer = new ResilienceBuffer();
    expect(defaultBuffer).toBeDefined();
  });

  it('should store events and retrieve them by ID', () => {
    buffer.add({ id: '1', data: 'test1' });
    buffer.add({ id: '2', data: 'test2' });
    buffer.add({ id: '3', data: 'test3' });

    const missed = buffer.getMissedEvents('1');
    expect(missed).toHaveLength(2);
    expect(missed[0].id).toBe('2');
    expect(missed[1].id).toBe('3');
  });

  it('should return empty array if last-id is not found', () => {
    buffer.add({ id: '1', data: 'test1' });

    const missed = buffer.getMissedEvents('999');
    expect(missed).toHaveLength(0);
  });

  it('should respect max capacity (evict oldest)', () => {
    // Default max capacity is 5. We add 6 events.
    buffer.add({ id: '1', data: '1' });
    buffer.add({ id: '2', data: '2' });
    buffer.add({ id: '3', data: '3' });
    buffer.add({ id: '4', data: '4' });
    buffer.add({ id: '5', data: '5' });
    buffer.add({ id: '6', data: '6' });

    // ID '1' should be gone
    const allMissed = buffer.getMissedEvents('0'); // '0' not in buffer, returns [] usually, but here we want to check internal state or just retrieval behavior.

    // Better check: if we ask for missed after '1', it should return nothing because '1' is evicted so we can't find the anchor?
    // Actually implementation says: if index -1 returns [].
    // So if '1' is evicted, getMissedEvents('1') returns [].

    expect(buffer.getMissedEvents('1')).toEqual([]);
    expect(allMissed).toEqual([]);

    // If we ask for '2', it should return 3, 4, 5, 6 (4 events)
    const missedFrom2 = buffer.getMissedEvents('2');
    expect(missedFrom2).toHaveLength(4);
    expect(missedFrom2[0].id).toBe('3');
    expect(missedFrom2[3].id).toBe('6');
  });

  it('should respect time retention', async () => {
    // buffer configured with 500ms retention in beforeEach
    buffer.add({ id: '1', data: 'test' });

    // Wait for retention to pass
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Trigger constraints check (usually happens on add, so we add a new one)
    buffer.add({ id: '2', data: 'new' });

    // '1' should be expired and removed.
    // So asking for missed events since '1' should return empty because '1' is not found.
    expect(buffer.getMissedEvents('1')).toEqual([]);

    // Asking for events since a non-existent ID returns empty, which is consistent.
    // To verify it's gone, we can try to find it via a hypothetical method or deduce it.
    // If '1' was there, getMissedEvents('1') would return '2'.
    // Since it returns [], '1' is likely gone (or '2' is gone too, but '2' is fresh).
  });
});
