import { parseSse } from './sse-parser';

describe('parseSse', () => {
  it('parses complete events and keeps an incomplete tail', () => {
    const r = parseSse('event: delta\ndata: {"type":"delta","text":"Ма"}\n\nevent: del');
    expect(r.events).toEqual([{ event: 'delta', data: '{"type":"delta","text":"Ма"}' }]);
    expect(r.rest).toBe('event: del');
  });

  it('ignores comment keep-alive lines', () => {
    expect(parseSse(': ping\n\n').events).toEqual([]);
  });

  it('parses several events, CRLF line ends and multi-line data', () => {
    const r = parseSse('event: a\r\ndata: 1\r\n\r\nevent: b\ndata: x\ndata: y\n\n');
    expect(r.events).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: 'x\ny' },
    ]);
    expect(r.rest).toBe('');
  });

  it('names an event without an event field "message"', () => {
    expect(parseSse('data: {}\n\n').events).toEqual([{ event: 'message', data: '{}' }]);
  });

  it('returns the whole buffer as rest while no event is complete', () => {
    expect(parseSse('event: done\ndata: {"a"')).toEqual({ events: [], rest: 'event: done\ndata: {"a"' });
  });
});
