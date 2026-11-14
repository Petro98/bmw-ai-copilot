import { Component, DOCUMENT, Injectable, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import type { AskStyle, DialogTurn } from '@copilot/shared';
import { ApiService } from '../../core/api.service';
import { AskOptions, AskService } from '../../core/ask.service';
import { currentTime } from '../../core/clock';
import { LiveService } from '../../core/live.service';
import { movingNow } from '../../core/vehicle-state';
import { SPEECH_RECOGNIZER, SPEECH_SPEAKER } from '../../speech/speech.tokens';
import { eventTime } from '../../shared/alert-row/alert-row';
import { NO_VOICE_TEXT, TalkController } from './talk.controller';
import { TALK_TEXT, TalkState } from './talk.machine';
import { ScreenWakeLock, WakeLockNavigator } from './wake-lock';

/** The topic chips, each sending exactly this question (plan 1, Task 15). */
export const TOPICS: readonly string[] = [
  'Як почувається авто?',
  'Чи можна навантажувати двигун?',
  'Що з шинами?',
  'Коли наступний сервіс?',
  'Чи є помилки?',
  'Як змінилися показники за останній місяць?',
];

/** While moving: at most three chips (docs/design/README.md, Layout). */
const DRIVING_TOPICS = 3;
/** Same value as `MAX_QUESTION_CHARS` in packages/shared/src/dto.ts (the panel imports the contracts type-only). */
const MAX_QUESTION_CHARS = 500;
const COUNTER_FROM = 400;
const EARLIER_TURNS = 20;
/** How often the motion rule is checked again with no new snapshot, so a speed that went stale ends the driving layout. */
const MOTION_CHECK_EVERY_MS = 5_000;

/** Newest first, one copy per id. */
function mergeTurns(first: DialogTurn[], second: DialogTurn[]): DialogTurn[] {
  const byId = new Map<string, DialogTurn>();
  for (const turn of [...first, ...second]) if (!byId.has(turn.id)) byId.set(turn.id, turn);
  return Array.from(byId.values()).sort((a, b) => b.at - a.at).slice(0, EARLIER_TURNS + 1);
}

/** The state line under the talk button (plan 3, Task 3): the state is always said in words, not by colour. */
export const TALK_STATE_TEXT: Record<TalkState, string> = {
  idle: 'Натисніть і говоріть',
  listening: 'Слухаю…',
  thinking: 'Думаю…',
  speaking: 'Відповідаю…',
};

interface Exchange { question: string; answer: string | null; error: string | null }

/**
 * The dialog state of the assistant screen. It lives at root level, beside AskService, because the routes are
 * lazy: leaving the tab destroys the page while its question stays in flight, and the page opened again must
 * show that question, its growing answer and the stored turn when it arrives.
 */
@Injectable({ providedIn: 'root' })
export class AssistantState {
  /** Stored turns, newest first. */
  readonly turns = signal<DialogTurn[]>([]);
  /** The question in flight, or the one that failed; null once its turn is stored. */
  readonly asked = signal<string | null>(null);
}

/**
 * The assistant screen (docs/design/mockups/PhoneTalk.dc.html): push-to-talk in Ukrainian above the typed question
 * and the topic chips of Plan 1. The microphone opens only from a tap on the talk button.
 */
@Component({
  selector: 'app-assistant-page',
  templateUrl: './assistant.page.html',
  styleUrl: './assistant.page.css',
  // The driving layout (assistant.page.css): the button and its state line stay on screen however long the answer.
  host: { '[class.driving]': 'moving()' },
})
export class AssistantPage implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly live = inject(LiveService);
  protected readonly ask = inject(AskService);
  private readonly document = inject(DOCUMENT);
  private readonly recognizer = inject(SPEECH_RECOGNIZER);

  protected readonly maxChars = MAX_QUESTION_CHARS;
  protected readonly counterFrom = COUNTER_FROM;

  private readonly state = inject(AssistantState);
  private readonly turns = this.state.turns;
  private readonly asked = this.state.asked;
  protected readonly draft = signal('');

  /** The rule of `isMovingNow` (packages/vehicle-core/src/snapshot.ts): a speed older than two minutes is not motion. */
  private readonly clock = currentTime(MOTION_CHECK_EVERY_MS);
  protected readonly moving = computed(() => movingNow(this.live.snapshot(), this.clock()));
  protected readonly topics = computed(() => (this.moving() ? TOPICS.slice(0, DRIVING_TOPICS) : TOPICS));
  private readonly showingAsked = computed(() => this.asked() !== null && (this.ask.pending() || this.ask.error() !== null));

  /** The last exchange: the question in flight with its growing answer or its error, otherwise the newest turn. */
  protected readonly exchange = computed<Exchange | null>(() => {
    const talk = this.talk.model();
    if (talk.state === 'listening' && talk.transcript) return { question: talk.transcript, answer: null, error: null };
    const question = this.asked();
    if (question !== null && this.showingAsked()) {
      const pending = this.ask.pending();
      return { question, answer: pending ? this.ask.partial() : null, error: pending ? null : this.ask.error() };
    }
    const last = this.turns()[0];
    return last ? { question: last.question, answer: last.answer, error: null } : null;
  });

  protected readonly earlier = computed(() => {
    const skip = this.showingAsked() ? 0 : 1;
    return this.turns().slice(skip, skip + EARLIER_TURNS);
  });

  protected readonly canSend = computed(() => !this.busy() && this.draft().trim().length > 0);

  /** Voice: the talk flow drives the same exchange display as a typed question. */
  private readonly talk = new TalkController(this.recognizer, inject(SPEECH_SPEAKER), {
    ask: (text, style, options) => this.askFor(text, style, options),
    cancel: () => this.ask.cancel(),
    error: () => this.ask.error(),
  });
  protected readonly canListen = this.recognizer.isSupported();
  protected readonly talkState = computed(() => this.talk.model().state);
  protected readonly talkIdle = computed(() => this.talkState() === 'idle');
  protected readonly talkLabel = computed(() => (this.talkIdle() ? 'Говорити' : 'Зупинити'));
  protected readonly talkStateText = computed(() => TALK_STATE_TEXT[this.talkState()]);
  /** The level meter: only while listening or speaking (the one permitted animation, docs/design/README.md → Motion). */
  protected readonly meter = computed(() => this.talkState() === 'listening' || this.talkState() === 'speaking');
  /** A typed question in flight keeps the talk button off until it is answered or cancelled. */
  protected readonly talkDisabled = computed(() => !this.canListen || (this.talkIdle() && this.ask.pending()));
  /** One instruction at a time; an answer error already shown in the card is not repeated here. */
  protected readonly talkMessage = computed(() => {
    if (!this.canListen) return TALK_TEXT.unsupported;
    const message = this.talk.model().message;
    return message !== null && message !== this.exchange()?.error ? message : null;
  });
  protected readonly voiceNote = computed(() => (this.talk.voiceMissing() ? NO_VOICE_TEXT : null));
  /** Chips and the text field wait while a question is in flight or the microphone is in use. */
  protected readonly busy = computed(() => this.ask.pending() || !this.talkIdle());

  private readonly wakeLock = new ScreenWakeLock(
    this.document, this.document.defaultView?.navigator as WakeLockNavigator | undefined,
  );
  private readonly onVisibility = () => {
    if (this.document.visibilityState === 'hidden') this.talk.pageHidden();
  };

  ngOnInit(): void {
    this.api.dialog(EARLIER_TURNS + 1).subscribe({
      next: (loaded) => this.turns.update((local) => mergeTurns(local, loaded)),
      error: () => undefined,
    });
    this.document.addEventListener('visibilitychange', this.onVisibility);
    this.wakeLock.start();
  }

  ngOnDestroy(): void {
    this.document.removeEventListener('visibilitychange', this.onVisibility);
    this.wakeLock.stop();
    this.talk.destroy();
  }

  protected onTalk(): void {
    if (this.talkDisabled()) return;
    this.talk.tap();
  }

  protected onInput(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    void this.send(this.draft(), true);
  }

  protected async send(text: string, fromField = false): Promise<void> {
    const question = text.trim();
    if (!question || this.busy()) return;
    this.asked.set(question);
    const turn = await this.ask.ask(question);
    if (!turn) return;                      // the error, if any, stays on screen in place of the answer
    this.stored(turn);
    if (fromField) this.draft.set('');
  }

  /** A voice question: shown and stored like a typed one. */
  private async askFor(text: string, style: AskStyle, options: AskOptions): Promise<DialogTurn | null> {
    this.asked.set(text);
    const turn = await this.ask.ask(text, style, options);
    if (turn) this.stored(turn);
    return turn;
  }

  private stored(turn: DialogTurn): void {
    this.turns.update((turns) => mergeTurns([turn], turns));
    this.asked.set(null);
  }

  protected time(at: number): string {
    return eventTime(at, Date.now());
  }
}
