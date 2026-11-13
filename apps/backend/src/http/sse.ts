import type { FastifyReply } from 'fastify';

/** A comment line goes out this often so proxies and browsers keep an idle stream open. */
export const SSE_KEEP_ALIVE_MS = 25_000;
/** A client this far behind (unsent bytes) is dropped instead of growing the process without bound. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

export interface SseStream {
  /** Writes `event: <type>` and `data: <JSON>`; ignored once the stream is closed. */
  send(type: string, data: unknown): void;
  /** Ends the stream from the server side. Safe to call more than once. */
  close(): void;
  /** Called once when the stream ends, whichever side ended it. */
  onClose(listener: () => void): void;
  readonly closed: boolean;
}

/**
 * The open server-sent-event streams of one app, so shutdown can end them and /api/metrics can count them.
 * A stream leaves the set as soon as it closes, so the set never outlives its clients.
 */
export class SseRegistry {
  private readonly streams = new Set<SseStream>();

  /**
   * Takes over the reply and turns it into an event stream. Headers already set on the reply (CORS) are kept.
   * `kind` counts the stream under that name for metrics.
   */
  open(reply: FastifyReply, kind: 'events' | 'ask'): SseStream {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    raw.flushHeaders?.();

    const listeners: Array<() => void> = [];
    let closed = false;
    const registry = this.streams;
    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      registry.delete(stream);
      for (const listener of listeners.splice(0)) {
        try {
          listener();
        } catch {
          // A failing close listener must not keep the others from running.
        }
      }
    };
    const write = (chunk: string): void => {
      if (closed) return;
      if (raw.writableLength > MAX_BUFFERED_BYTES) {
        stream.close();
        return;
      }
      try {
        raw.write(chunk);
      } catch {
        finish();
      }
    };

    const stream: SseStream & { kind: string } = {
      kind,
      send(type: string, data: unknown): void {
        write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      },
      close(): void {
        if (closed) return;
        try {
          raw.end();
        } catch {
          // Already gone.
        }
        finish();
      },
      onClose(listener: () => void): void {
        if (closed) listener();
        else listeners.push(listener);
      },
      get closed(): boolean {
        return closed;
      },
    };

    const keepAlive = setInterval(() => write(': keep-alive\n\n'), SSE_KEEP_ALIVE_MS);
    keepAlive.unref?.();
    raw.on('close', finish);
    raw.on('error', finish);
    this.streams.add(stream);
    return stream;
  }

  /** Open streams of a kind (all kinds when omitted). */
  count(kind?: 'events' | 'ask'): number {
    if (!kind) return this.streams.size;
    let n = 0;
    for (const stream of this.streams) if ((stream as SseStream & { kind: string }).kind === kind) n++;
    return n;
  }

  /** Ends every open stream (shutdown). */
  closeAll(): void {
    for (const stream of Array.from(this.streams)) stream.close();
  }
}
