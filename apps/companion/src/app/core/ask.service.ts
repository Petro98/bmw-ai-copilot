import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { ApiError, AskRequest, AskSource, AskStreamEvent, AskStyle, DialogTurn } from '@copilot/shared';
import { goToLogin } from '../features/login/login.page';
import { parseSse } from './sse-parser';

/** Shown when no answer and no server message arrived (network down, stream cut off). */
export const ASK_FAILED_MESSAGE = 'Не вдалося отримати відповідь. Перевірте зʼєднання і спробуйте ще раз.';

export interface AskOptions {
  /** Who asks: the typed panel (default) or the voice flow. */
  source?: AskSource;
  /** Receives each whole sentence of a spoken answer as it arrives (`sentence` events, style 'spoken' only). */
  onSentence?: (text: string) => void;
}

/** Asks a question over `POST /api/ask/stream` and exposes the answer as it grows. */
@Injectable({ providedIn: 'root' })
export class AskService {
  private readonly router = inject(Router);
  private readonly pendingState = signal(false);
  private readonly partialState = signal('');
  private readonly errorState = signal<string | null>(null);

  readonly pending = this.pendingState.asReadonly();
  /** The answer text received so far. */
  readonly partial = this.partialState.asReadonly();
  /** A Ukrainian message, safe to display, when the last question failed. */
  readonly error = this.errorState.asReadonly();

  private controller: AbortController | null = null;

  /** Resolves with the stored turn, or null when the question failed or was cancelled. */
  async ask(text: string, style: AskStyle = 'full', options: AskOptions = {}): Promise<DialogTurn | null> {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    this.pendingState.set(true);
    this.partialState.set('');
    this.errorState.set(null);

    const request: AskRequest = { text, style, source: options.source ?? 'panel' };
    try {
      const response = await fetch('/api/ask/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (response.status === 401) {
        // The session has expired: «Вхід», as the HttpClient interceptor does; no error is left on screen.
        if (this.controller === controller) goToLogin(this.router);
        return null;
      }
      const outcome = response.ok && response.body
        ? await this.readStream(response.body, controller, options.onSentence)
        : { turn: null, error: await errorMessageOf(response) };
      if (this.controller !== controller) return null;
      if (outcome.turn) return outcome.turn;
      this.errorState.set(outcome.error ?? ASK_FAILED_MESSAGE);
      return null;
    } catch {
      if (this.controller === controller && !controller.signal.aborted) this.errorState.set(ASK_FAILED_MESSAGE);
      return null;
    } finally {
      if (this.controller === controller) {
        this.controller = null;
        this.pendingState.set(false);
      }
    }
  }

  /** Aborts the question in flight (the server then aborts the Claude request); no error is shown. */
  cancel(): void {
    const controller = this.controller;
    if (!controller) return;
    this.controller = null;
    controller.abort();
    this.pendingState.set(false);
    this.partialState.set('');
  }

  private async readStream(
    body: ReadableStream<Uint8Array>, controller: AbortController, onSentence?: (text: string) => void,
  ): Promise<{ turn: DialogTurn | null; error: string | null }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const parsed = parseSse(done ? `${buffer}\n\n` : buffer);
        buffer = parsed.rest;
        for (const sse of parsed.events) {
          const event = parseEvent(sse.data);
          if (!event) continue;
          if (event.type === 'delta' && this.controller === controller) {
            this.partialState.update((text) => text + event.text);
          } else if (event.type === 'sentence') {
            if (this.controller === controller && typeof event.text === 'string') onSentence?.(event.text);
          } else if (event.type === 'done') {
            return { turn: event.turn, error: null };
          } else if (event.type === 'error') {
            return { turn: null, error: event.error?.message || null };
          }
        }
        if (done) return { turn: null, error: null };
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }
}

function parseEvent(data: string): AskStreamEvent | null {
  try {
    const event = JSON.parse(data) as AskStreamEvent;
    return event && typeof event === 'object' ? event : null;
  } catch {
    return null;
  }
}

async function errorMessageOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as Partial<ApiError>;
    const message = body?.error?.message;
    return typeof message === 'string' && message.length > 0 ? message : null;
  } catch {
    return null;
  }
}
