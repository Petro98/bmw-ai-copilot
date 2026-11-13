import { HttpErrorResponse } from '@angular/common/http';
import { Component, OnInit, computed, effect, inject, linkedSignal, signal, untracked } from '@angular/core';
import type { OwnerLimits } from '@copilot/event-engine';
import type { ScenarioDto, SettingsDto } from '@copilot/shared';
import type { ScenarioId } from '@copilot/vehicle-core';
import { ApiService } from '../../core/api.service';
import { formatNumber } from '../../core/format';
import { LiveService } from '../../core/live.service';

export interface LimitView { key: keyof OwnerLimits; label: string; unit: string }

/** The owner's own limits, in the mockup's order and words (docs/design/mockups/PhoneSettings.dc.html). */
export const LIMITS: ReadonlyArray<LimitView> = [
  { key: 'oilTempMaxC', label: 'Температура масла', unit: '°C' },
  { key: 'coolantTempMaxC', label: 'Охолоджувальна рідина', unit: '°C' },
  { key: 'battery12vMinPercent', label: 'Акумулятор 12 В', unit: '%' },
  { key: 'tyrePressureDeviationBar', label: 'Відхилення тиску в шинах', unit: 'бар' },
];

const SAVE_FAILED = 'Не вдалося зберегти. Спробуйте ще раз.';
const LOAD_FAILED = 'Не вдалося завантажити налаштування. Спробуйте ще раз.';

/** The server's Ukrainian `ApiError` message when there is one, otherwise the fallback. */
function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof HttpErrorResponse) {
    const message: unknown = (error.error as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return fallback;
}

/** Owner limits, pop-ups, diagnostics (off), models, spend and — with the mock vehicle — the demo scenario. */
@Component({
  selector: 'app-settings-page',
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.css',
})
export class SettingsPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly live = inject(LiveService);

  protected readonly limits = LIMITS;
  protected readonly settings = signal<SettingsDto | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly saving = signal(false);

  /** The limit open for editing, its typed text and the server's answer when it was rejected. */
  protected readonly editing = signal<keyof OwnerLimits | null>(null);
  /**
   * The field's starting text, set only when the editor opens. The field is never written back from `draft`:
   * a number input reports '' while its text is incomplete ("0.", "-"), and echoing that would erase what was typed.
   */
  protected readonly seed = signal('');
  protected readonly draft = signal('');
  protected readonly limitError = signal<string | null>(null);
  protected readonly draftValue = computed(() => {
    const text = this.draft().trim().replace(',', '.');
    if (text === '') return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  });

  protected readonly switchError = signal<string | null>(null);

  protected readonly status = this.live.status;
  protected readonly isMock = computed(() => this.status()?.vehicle.source === 'mock');
  protected readonly scenarios = signal<ScenarioDto[]>([]);
  protected readonly selectedScenario = linkedSignal<ScenarioId | null>(() => this.status()?.vehicle.scenario ?? null);
  protected readonly scenarioError = signal<string | null>(null);
  private scenariosRequested = false;

  constructor() {
    // The scenario list only exists while the vehicle source is `mock` (404 otherwise), so ask for it then.
    effect(() => {
      if (!this.isMock() || this.scenariosRequested) return;
      this.scenariosRequested = true;
      untracked(() => this.api.scenarios().subscribe({
        next: (list) => this.scenarios.set(list),
        error: (error: unknown) => {
          this.scenariosRequested = false;
          this.scenarioError.set(errorMessage(error, LOAD_FAILED));
        },
      }));
    });
  }

  ngOnInit(): void {
    this.api.settings().subscribe({
      next: (settings) => this.settings.set(settings),
      error: (error: unknown) => this.loadError.set(errorMessage(error, LOAD_FAILED)),
    });
  }

  protected limitText(limit: LimitView): string {
    const value = this.settings()?.ownerLimits[limit.key] ?? null;
    return value === null ? 'Не задано' : `${formatNumber(value, 2)} ${limit.unit}`;
  }

  protected edit(key: keyof OwnerLimits): void {
    if (this.editing() === key) {
      this.editing.set(null);
      return;
    }
    const value = this.settings()?.ownerLimits[key] ?? null;
    const text = value === null ? '' : String(value);
    this.editing.set(key);
    this.seed.set(text);
    this.draft.set(text);
    this.limitError.set(null);
  }

  protected onDraft(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  protected saveLimit(event: Event, key: keyof OwnerLimits): void {
    event.preventDefault();
    const value = this.draftValue();
    if (value !== null) this.storeLimit(key, value);
  }

  /** «Прибрати ліміт»: the limit becomes unset, so its rule is inert again. */
  protected clearLimit(key: keyof OwnerLimits): void {
    this.storeLimit(key, null);
  }

  protected setPopups(event: Event): void {
    const input = event.target as HTMLInputElement;
    const current = this.settings();
    if (!current || this.saving()) {
      input.checked = current?.popupsEnabled ?? false;
      return;
    }
    this.switchError.set(null);
    this.save({ ...current, popupsEnabled: input.checked }, () => undefined, (message) => {
      input.checked = current.popupsEnabled;
      this.switchError.set(message);
    });
  }

  protected chooseScenario(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const id = select.value as ScenarioId;
    const previous = this.selectedScenario();
    this.selectedScenario.set(id);
    this.scenarioError.set(null);
    this.api.setScenario(id).subscribe({
      error: (error: unknown) => {
        this.selectedScenario.set(previous);
        if (previous !== null) select.value = previous;
        this.scenarioError.set(errorMessage(error, SAVE_FAILED));
      },
    });
  }

  protected money(usd: number): string {
    return `${formatNumber(usd, 2)} $`;
  }

  private storeLimit(key: keyof OwnerLimits, value: number | null): void {
    const current = this.settings();
    if (!current || this.saving()) return;
    this.limitError.set(null);
    this.save(
      { ...current, ownerLimits: { ...current.ownerLimits, [key]: value } },
      () => this.editing.set(null),
      (message) => this.limitError.set(message),   // the previous value stays: settings are replaced only on success
    );
  }

  private save(next: SettingsDto, onSaved: () => void, onError: (message: string) => void): void {
    this.saving.set(true);
    this.api.saveSettings(next).subscribe({
      next: (saved) => {
        this.settings.set(saved);
        this.saving.set(false);
        onSaved();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        onError(errorMessage(error, SAVE_FAILED));
      },
    });
  }
}
