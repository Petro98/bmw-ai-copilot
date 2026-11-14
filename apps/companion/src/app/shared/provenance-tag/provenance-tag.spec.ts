import { TestBed } from '@angular/core/testing';
import type { Provenance } from '@copilot/event-engine';
import { ProvenanceTag, provenanceTag } from './provenance-tag';

describe('ProvenanceTag', () => {
  it('names where each warning comes from, and the owner\'s limits as the owner\'s', () => {
    expect(provenanceTag('bmw-check-control')).toBe('BMW CHECK CONTROL');
    expect(provenanceTag('bmw-service')).toBe('СЕРВІС BMW');
    expect(provenanceTag('owner-configured')).toBe('ВАШ ЛІМІТ');
    expect(provenanceTag('bmw-fault-status')).toBe('ПАМ\'ЯТЬ ПОМИЛОК BMW');
  });

  it('renders the tag text', async () => {
    await TestBed.configureTestingModule({ imports: [ProvenanceTag] }).compileComponents();
    const fixture = TestBed.createComponent(ProvenanceTag);
    fixture.componentRef.setInput('provenance', 'owner-configured' satisfies Provenance);
    fixture.detectChanges();
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent?.trim()).toBe('ВАШ ЛІМІТ');
  });
});
