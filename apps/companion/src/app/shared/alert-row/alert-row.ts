import { Component, computed, input } from '@angular/core';
import type { AlertEvent } from '@copilot/event-engine';
import type { Severity } from '@copilot/vehicle-core';
import { ProvenanceTag } from '../provenance-tag/provenance-tag';

/**
 * Severity as a word, beside the icon shape — never colour alone (docs/design/README.md).
 * «ПОПЕРЕДЖЕННЯ» and «ДО ВІДОМА» are the mockups' words (PhoneCar.dc.html); the design has no word for
 * critical, so «КРИТИЧНО» is this panel's.
 */
const SEVERITY_WORD: Record<Severity, string> = {
  critical: 'КРИТИЧНО',
  warning: 'ПОПЕРЕДЖЕННЯ',
  info: 'ДО ВІДОМА',
};

const MONTHS_GENITIVE = [
  'СІЧНЯ', 'ЛЮТОГО', 'БЕРЕЗНЯ', 'КВІТНЯ', 'ТРАВНЯ', 'ЧЕРВНЯ',
  'ЛИПНЯ', 'СЕРПНЯ', 'ВЕРЕСНЯ', 'ЖОВТНЯ', 'ЛИСТОПАДА', 'ГРУДНЯ',
];

/** Which day `at` falls on, seen from `now` (local time). */
export function dayOf(at: number, now: number): 'today' | 'yesterday' | 'earlier' {
  const when = new Date(at);
  const today = new Date(now);
  if (sameDay(when, today)) return 'today';
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  return sameDay(when, yesterday) ? 'yesterday' : 'earlier';
}

/** «12:36» (local time). */
export function clockTime(at: number): string {
  const when = new Date(at);
  return `${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

/** «9 ЛИСТОПАДА» (local time). */
export function dateText(at: number): string {
  const when = new Date(at);
  return `${when.getDate()} ${MONTHS_GENITIVE[when.getMonth()]}`;
}

/** When something happened, for a tag line: «12:36» today, «ВЧОРА», otherwise «9 ЛИСТОПАДА» (local time). */
export function eventTime(at: number, now: number): string {
  const day = dayOf(at, now);
  return day === 'today' ? clockTime(at) : day === 'yesterday' ? 'ВЧОРА' : dateText(at);
}

/**
 * When the car stopped reporting an alert: «ЗНЯТО О 12:39», «ЗНЯТО ВЧОРА», «ЗНЯТО 9 ЛИСТОПАДА», or «ЗНЯТО» when the
 * time is not known. The head-unit screen's words (car/src/ui/strings.uk.ts `clearedAt`).
 */
export function clearedText(clearedAt: number | null, now: number): string {
  if (clearedAt === null || !Number.isFinite(clearedAt)) return 'ЗНЯТО';
  const day = dayOf(clearedAt, now);
  return 'ЗНЯТО ' + (day === 'today' ? `О ${clockTime(clearedAt)}` : day === 'yesterday' ? 'ВЧОРА' : dateText(clearedAt));
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * One alert in the list (docs/design/mockups/PhoneCar.dc.html): severity icon — triangle for warning,
 * octagon for critical, circle for information — the title, and the tag line
 * `<severity word> · <provenance tag> · <time>`. For a cleared alert the time part says so in words
 * («ЗНЯТО О 12:39»), as on the head-unit screen; its title is dimmed as well, but the words carry the state.
 */
@Component({
  selector: 'app-alert-row',
  imports: [ProvenanceTag],
  template: `
    @switch (alert().severity) {
      @case ('critical') {
        <svg class="icon critical" data-shape="octagon" aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.3 3h7.4L21 8.3v7.4L15.7 21H8.3L3 15.7V8.3z"></path><path d="M12 8v5"></path><path d="M12 16.5v.5"></path></svg>
      }
      @case ('warning') {
        <svg class="icon warning" data-shape="triangle" aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"></path><path d="M12 10v4"></path><path d="M12 17v.5"></path></svg>
      }
      @default {
        <svg class="icon info" data-shape="circle" aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 7.5v.5"></path></svg>
      }
    }
    <span class="text">
      <span class="title" data-title>{{ alert().title }}</span>
      <span class="phone-label tags" data-tags>{{ severityWord() }} · <app-provenance-tag [provenance]="alert().provenance" /> · {{ time() }}</span>
    </span>
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: 14px;
      min-height: 48px;
      padding: 14px var(--space-3);
      border-radius: var(--radius-md);
      background: var(--surface);
      color: var(--ink);
    }
    .icon { flex-shrink: 0; }
    .icon.critical { color: var(--critical); }
    .icon.warning { color: var(--warning); }
    .icon.info { color: var(--signal); }
    .text { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .title { font-size: 17px; line-height: 26px; font-weight: 500; overflow-wrap: anywhere; }
    .tags { color: var(--ink-dim); }
    :host([data-active='false']) .title { color: var(--ink-dim); }
  `,
  host: { '[attr.data-severity]': 'alert().severity', '[attr.data-active]': 'alert().active' },
})
export class AlertRow {
  readonly alert = input.required<AlertEvent>();
  /** The time "today" is measured against; the phone's clock when not given. */
  readonly now = input<number | null>(null);

  protected readonly severityWord = computed(() => SEVERITY_WORD[this.alert().severity] ?? SEVERITY_WORD.warning);
  protected readonly time = computed(() => {
    const alert = this.alert();
    const now = this.now() ?? Date.now();
    return alert.active ? eventTime(alert.at, now) : clearedText(alert.clearedAt, now);
  });
}
