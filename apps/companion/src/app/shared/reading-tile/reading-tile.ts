import { Component, computed, input } from '@angular/core';
import type { Reading } from '@copilot/vehicle-core';
import { formatReading } from '../../core/format';

/**
 * One reading on the car screen of the phone (docs/design/mockups/PhoneCar.dc.html): label, value and unit,
 * the car's own target for a tyre. An unavailable reading keeps its tile with a dashed edge, «Недоступно»
 * and the reason — never a dash, a zero or an estimate.
 */
@Component({
  selector: 'app-reading-tile',
  template: `
    <span class="phone-label label" data-label>{{ label() }}</span>
    <span class="value" data-value>{{ formatted().text }}@if (unitLine(); as unit) {<span class="unit"> {{ unit }}</span>}</span>
    @if (formatted().note; as note) {
      <span class="note" data-note>{{ note }}</span>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
      padding: 14px var(--space-3);
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      background: var(--surface-raised);
      color: var(--ink);
    }
    :host(.unavailable) {
      border: 1px dashed var(--line-strong);
      color: var(--ink-dim);
    }
    .label, .unit, .note { color: var(--ink-dim); }
    .value { font-size: 22px; line-height: 28px; font-weight: 400; overflow-wrap: anywhere; }
    .unit { font-size: 17px; line-height: 26px; }
    .note { font-size: 13px; line-height: 16px; }
  `,
  host: { '[class.unavailable]': '!formatted().available' },
})
export class ReadingTile {
  readonly label = input.required<string>();
  readonly reading = input.required<Reading<number | string>>();
  /** The time the age note is measured against. */
  readonly now = input.required<number>();
  /** The car's own target (tyre pressure); left out when the car did not send it. */
  readonly target = input<Reading<number> | null>(null);

  protected readonly formatted = computed(() => formatReading(this.reading(), this.now()));

  protected readonly unitLine = computed(() => {
    const value = this.formatted();
    if (!value.available) return null;
    const target = this.target();
    const targetText = target && target.available ? `ціль ${formatReading(target, this.now()).text}` : null;
    const parts = [value.unit, targetText].filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(' · ') : null;
  });
}
