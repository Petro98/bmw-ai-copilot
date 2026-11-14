import { EventEmitter } from 'node:events';
import type { FastifyReply } from 'fastify';
import { describe, expect, test } from 'vitest';
import { SseRegistry } from './sse';

/** Just enough of a FastifyReply for SseRegistry.open: a raw response whose unsent byte count the test sets. */
function fakeReply(): { reply: FastifyReply; raw: EventEmitter & { writableLength: number; ended: boolean; destroyed: boolean; written: string[] } } {
  const raw = Object.assign(new EventEmitter(), {
    writableLength: 0,
    ended: false,
    destroyed: false,
    written: [] as string[],
    writeHead(): void {},
    flushHeaders(): void {},
    write(chunk: string): boolean { raw.written.push(chunk); return true; },
    end(): void { raw.ended = true; },
    destroy(): void { raw.destroyed = true; raw.emit('close'); },
  });
  const reply = { hijack(): void {}, raw, getHeaders: () => ({}) } as unknown as FastifyReply;
  return { reply, raw };
}

describe('SseRegistry', () => {
  test('a client that stopped reading (over 1 MiB unsent) is destroyed, not ended behind its backlog', () => {
    const registry = new SseRegistry();
    const { reply, raw } = fakeReply();
    const stream = registry.open(reply, 'events');
    let closed = 0;
    stream.onClose(() => { closed++; });
    stream.send('status', { ok: true });
    expect(raw.written).toHaveLength(1);

    raw.writableLength = 1024 * 1024 + 1;
    stream.send('status', { ok: true });
    expect(raw.destroyed).toBe(true);
    expect(raw.written).toHaveLength(1);
    expect(stream.closed).toBe(true);
    expect(closed).toBe(1);
    expect(registry.count()).toBe(0);
  });

  test('a stream closed by the server is ended normally', () => {
    const registry = new SseRegistry();
    const { reply, raw } = fakeReply();
    const stream = registry.open(reply, 'events');
    stream.close();
    expect(raw.ended).toBe(true);
    expect(raw.destroyed).toBe(false);
    expect(registry.count()).toBe(0);
  });
});
