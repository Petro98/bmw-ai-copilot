import { Component, input } from '@angular/core';

/**
 * A connection mark of the top bar («АВТО», «CLAUDE»): a check when the link is up, a dash when it is not,
 * plus the state in words for screen readers — never colour alone (docs/design/mockups/PhoneTalk.dc.html).
 */
@Component({
  selector: 'app-status-mark',
  template: `
    @if (on()) {
      <svg class="icon on" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>
    } @else {
      <svg class="icon off" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12h12"></path></svg>
    }
    {{ label() }}
    <span class="visually-hidden">{{ on() ? 'підключено' : 'не підключено' }}</span>
  `,
  styles: `
    :host { display: inline-flex; align-items: center; gap: var(--space-1); color: var(--ink-dim); }
    .icon.on { color: var(--signal); }
    .icon.off { color: var(--ink-dim); }
  `,
  host: {
    class: 'phone-label',
    '[attr.data-mark]': 'name()',
    '[attr.data-state]': "on() ? 'on' : 'off'",
  },
})
export class StatusMark {
  /** Machine name of the link, e.g. `vehicle` or `claude`. */
  readonly name = input.required<string>();
  /** The word shown, e.g. «АВТО». */
  readonly label = input.required<string>();
  readonly on = input.required<boolean>();
}
