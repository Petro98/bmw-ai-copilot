export interface SseEvent { event: string; data: string }

/**
 * Splits a server-sent-events buffer into complete events and the incomplete tail.
 * Feed the tail back in front of the next chunk. Comment lines (keep-alives) and
 * blocks without data are dropped; an event without an `event:` field is "message".
 */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const text = buffer.replace(/\r\n?/g, '\n');
  const events: SseEvent[] = [];
  let start = 0;
  let end = text.indexOf('\n\n', start);
  while (end !== -1) {
    const event = parseBlock(text.slice(start, end));
    if (event) events.push(event);
    start = end + 2;
    end = text.indexOf('\n\n', start);
  }
  return { events, rest: text.slice(start) };
}

function parseBlock(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length > 0 ? { event, data: data.join('\n') } : null;
}
