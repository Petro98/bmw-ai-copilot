import { TestBed } from '@angular/core/testing';
import type { AskStreamEvent, DialogTurn } from '@copilot/shared';
import { ASK_FAILED_MESSAGE, AskService } from './ask.service';

const TURN: DialogTurn = {
  id: 't1', at: 1000, question: 'Як почувається авто?', answer: 'Масло 92 °C.',
  style: 'full', source: 'panel', model: 'claude-opus-5-5', snapshotAt: 900,
};

function frame(event: AskStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** A streamed response whose body arrives in the given byte chunks. */
function streamResponse(chunks: Uint8Array[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function splitBytes(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

describe('AskService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let service: AskService;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({});
    service = TestBed.inject(AskService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('AskService accumulates deltas, resolves with the turn and clears pending', async () => {
    const text = frame({ type: 'delta', text: 'Масло ' }) + ': ping\n\n' + frame({ type: 'delta', text: '92 °C.' }) + frame({ type: 'done', turn: TURN });
    fetchMock.mockResolvedValue(streamResponse(splitBytes(text, 7)));   // splits inside multi-byte letters too

    const promise = service.ask('Як почувається авто?');
    expect(service.pending()).toBe(true);
    const turn = await promise;

    expect(turn).toEqual(TURN);
    expect(service.partial()).toBe('Масло 92 °C.');
    expect(service.pending()).toBe(false);
    expect(service.error()).toBeNull();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/ask/stream');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'Як почувається авто?', style: 'full', source: 'panel' });
  });

  it('AskService surfaces an error event as its message and resolves null', async () => {
    const text = frame({ type: 'delta', text: 'Мас' }) + frame({ type: 'error', error: { code: 'budget-exhausted', message: 'Денний бюджет вичерпано.' } });
    fetchMock.mockResolvedValue(streamResponse(splitBytes(text, 1000)));

    await expect(service.ask('Питання')).resolves.toBeNull();
    expect(service.error()).toBe('Денний бюджет вичерпано.');
    expect(service.pending()).toBe(false);
  });

  it('shows the server message of an ApiError response that is not a stream', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'validation', message: 'Питання задовге.' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }));

    await expect(service.ask('x')).resolves.toBeNull();
    expect(service.error()).toBe('Питання задовге.');
    expect(service.pending()).toBe(false);
  });

  it('shows a generic message when the network fails or the stream ends without an answer', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(service.ask('Питання')).resolves.toBeNull();
    expect(service.error()).toBe(ASK_FAILED_MESSAGE);

    fetchMock.mockResolvedValueOnce(streamResponse(splitBytes(frame({ type: 'delta', text: 'Ма' }), 1000)));
    await expect(service.ask('Питання')).resolves.toBeNull();
    expect(service.error()).toBe(ASK_FAILED_MESSAGE);
    expect(service.pending()).toBe(false);
  });

  it('sends the spoken style when asked', async () => {
    fetchMock.mockResolvedValue(streamResponse(splitBytes(frame({ type: 'done', turn: TURN }), 1000)));
    await service.ask('Питання', 'spoken');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).style).toBe('spoken');
  });

  it('cancel aborts the request, resolves null and shows no error', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));

    const promise = service.ask('Питання');
    expect(service.pending()).toBe(true);
    service.cancel();
    await expect(promise).resolves.toBeNull();
    expect(service.pending()).toBe(false);
    expect(service.error()).toBeNull();
    expect(service.partial()).toBe('');
  });

  it('a new question clears the previous error and partial text', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await service.ask('Питання');
    fetchMock.mockResolvedValueOnce(streamResponse(splitBytes(frame({ type: 'done', turn: TURN }), 1000)));
    const promise = service.ask('Питання');
    expect(service.error()).toBeNull();
    expect(service.partial()).toBe('');
    await promise;
  });
});
