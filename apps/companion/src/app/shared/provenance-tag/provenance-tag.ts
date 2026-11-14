import { Component, computed, input } from '@angular/core';
import type { Provenance } from '@copilot/event-engine';

/**
 * Where a warning comes from (docs/design/README.md, Content: «BMW CHECK CONTROL», «СЕРВІС BMW», «ВАШ ЛІМІТ»).
 * A limit the owner typed in is always the owner's, never the manufacturer's.
 */
const PROVENANCE_TAG: Record<Provenance, string> = {
  'bmw-check-control': 'BMW CHECK CONTROL',
  'bmw-service': 'СЕРВІС BMW',
  'owner-configured': 'ВАШ ЛІМІТ',
  // Not named by the design docs; a fault the car itself flagged (spec §7, `bmw-fault-status`).
  'bmw-fault-status': 'ПАМ\'ЯТЬ ПОМИЛОК BMW',
};

export function provenanceTag(provenance: Provenance): string {
  return PROVENANCE_TAG[provenance];
}

/** The provenance tag as text, for a tag line set in `phone-label`. */
@Component({
  selector: 'app-provenance-tag',
  template: '{{ text() }}',
  host: { '[attr.data-provenance]': 'provenance()' },
})
export class ProvenanceTag {
  readonly provenance = input.required<Provenance>();
  protected readonly text = computed(() => provenanceTag(this.provenance()));
}
