import { describe, expect, it } from 'vitest';
import { formatFrame } from './stream.js';

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
