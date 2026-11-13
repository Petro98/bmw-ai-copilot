import { Component, Injectable, OnInit, computed, inject, signal } from '@angular/core';
import type { DialogTurn } from '@copilot/shared';
import type { VehicleSnapshot } from '@copilot/vehicle-core';
import { ApiService } from '../../core/api.service';
import { AskService } from '../../core/ask.service';
import { LiveService } from '../../core/live.service';
import { eventTime } from '../../shared/alert-row/alert-row';

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
/**
 * Same rule as `isMoving` / `MOVING_ABOVE_KMH` in packages/vehicle-core/src/snapshot.ts (kit convention,
 * idrive7-apps@4a8deb7:kit/runtime/parked.js:18 `MAX_KMH = 3`); repeated here because the panel imports
 * vehicle-core type-only. An unknown speed counts as not moving, as there.
 */
const MOVING_ABOVE_KMH = 3;

function isMoving(snapshot: VehicleSnapshot | null): boolean {
  const speed = snapshot?.speed;
  return !!speed && speed.available && speed.value > MOVING_ABOVE_KMH;
}

/** Newest first, one copy per id. */
function mergeTurns(first: DialogTurn[], second: DialogTurn[]): DialogTurn[] {
  const byId = new Map<string, DialogTurn>();
  for (const turn of [...first, ...second]) if (!byId.has(turn.id)) byId.set(turn.id, turn);
  return Array.from(byId.values()).sort((a, b) => b.at - a.at).slice(0, EARLIER_TURNS + 1);
}

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

/** The assistant screen (docs/design/mockups/PhoneTalk.dc.html without the microphone, which Plan 3 adds). */
@Component({
  selector: 'app-assistant-page',
  templateUrl: './assistant.page.html',
  styleUrl: './assistant.page.css',
})
export class AssistantPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly live = inject(LiveService);
  protected readonly ask = inject(AskService);

  protected readonly maxChars = MAX_QUESTION_CHARS;
  protected readonly counterFrom = COUNTER_FROM;

  private readonly state = inject(AssistantState);
  private readonly turns = this.state.turns;
  private readonly asked = this.state.asked;
  protected readonly draft = signal('');

  protected readonly moving = computed(() => isMoving(this.live.snapshot()));
  protected readonly topics = computed(() => (this.moving() ? TOPICS.slice(0, DRIVING_TOPICS) : TOPICS));
  private readonly showingAsked = computed(() => this.asked() !== null && (this.ask.pending() || this.ask.error() !== null));

  /** The last exchange: the question in flight with its growing answer or its error, otherwise the newest turn. */
  protected readonly exchange = computed<Exchange | null>(() => {
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

  protected readonly canSend = computed(() => !this.ask.pending() && this.draft().trim().length > 0);

  ngOnInit(): void {
    this.api.dialog(EARLIER_TURNS + 1).subscribe({
      next: (loaded) => this.turns.update((local) => mergeTurns(local, loaded)),
      error: () => undefined,
    });
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
    if (!question || this.ask.pending()) return;
    this.asked.set(question);
    const turn = await this.ask.ask(question);
    if (!turn) return;                      // the error, if any, stays on screen in place of the answer
    this.turns.update((turns) => mergeTurns([turn], turns));
    this.asked.set(null);
    if (fromField) this.draft.set('');
  }

  protected time(at: number): string {
    return eventTime(at, Date.now());
  }
}
