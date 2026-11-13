import { TestBed } from '@angular/core/testing';
import { CLOCK, currentTime } from './clock';

describe('currentTime', () => {
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    now = 1_000;
    TestBed.configureTestingModule({ providers: [{ provide: CLOCK, useValue: () => now }] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the clock at once and again on every interval, so views move on as time passes', () => {
    const time = TestBed.runInInjectionContext(() => currentTime(5_000));
    expect(time()).toBe(1_000);
    now = 4_000;
    vi.advanceTimersByTime(4_999);
    expect(time()).toBe(1_000);
    vi.advanceTimersByTime(1);
    expect(time()).toBe(4_000);
  });

  it('stops reading when its owner is destroyed', () => {
    TestBed.runInInjectionContext(() => currentTime(5_000));
    expect(vi.getTimerCount()).toBe(1);
    TestBed.resetTestingModule();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('defaults to the phone clock', () => {
    TestBed.resetTestingModule();
    const read = TestBed.inject(CLOCK);
    const before = Date.now();
    expect(read()).toBeGreaterThanOrEqual(before);
  });
});
