import { describe, expect, test } from 'vitest';
import { SELF_MEASURE_INTERVAL_MS, measure, type Sample } from './selfmeasure';

const MB = 1024 * 1024;

function meters() {
  const m = { rss: 41 * MB, heapUsed: 12 * MB, user: 0, system: 0, memCalls: 0, cpuCalls: 0 };
  return {
    m,
    mem: () => { m.memCalls++; return { rss: m.rss, heapUsed: m.heapUsed }; },
    cpu: () => { m.cpuCalls++; return { user: m.user, system: m.system }; },
  };
}

describe('measure', () => {
  test('the first call only takes a baseline', () => {
    const { mem, cpu } = meters();
    const r = measure(null, 1_000_000, mem, cpu);
    expect(r.line).toBeNull();
    expect(r.sample).toMatchObject({ at: 1_000_000, user: 0, system: 0 });
  });

  test('a line like "self: rss=41MB heap=12MB cpu=0.6%" after ten minutes, CPU over that window', () => {
    const { m, mem, cpu } = meters();
    let s = measure(null, 0, mem, cpu).sample;
    // 3.6 s of CPU time (user + system, in microseconds) over ten minutes = 0.6 %
    m.user = 3_000_000;
    m.system = 600_000;
    const r = measure(s, SELF_MEASURE_INTERVAL_MS, mem, cpu);
    expect(r.line).toBe('self: rss=41MB heap=12MB cpu=0.6%');
    s = r.sample;
    expect(s).toMatchObject({ at: SELF_MEASURE_INTERVAL_MS, user: 3_000_000, system: 600_000 });
  });

  test('self-measure emits at most one line per ten minutes', () => {
    const { m, mem, cpu } = meters();
    let sample: Sample | null = null;
    const lines: string[] = [];
    // one call a second for an hour, as the app's 1 Hz tick makes them
    for (let t = 0; t <= 3_600_000; t += 1000) {
      m.user += 500;
      const r = measure(sample, t, mem, cpu);
      sample = r.sample;
      if (r.line) lines.push(r.line);
    }
    expect(lines.length).toBe(6);
    for (const line of lines) expect(line).toMatch(/^self: rss=\d+MB heap=\d+MB cpu=\d+\.\d%$/);
  });

  test('between lines it reads neither memory nor CPU', () => {
    const { m, mem, cpu } = meters();
    let sample = measure(null, 0, mem, cpu).sample;
    const before = { mem: m.memCalls, cpu: m.cpuCalls };
    for (let t = 1000; t < SELF_MEASURE_INTERVAL_MS; t += 1000) sample = measure(sample, t, mem, cpu).sample;
    expect(m.memCalls).toBe(before.mem);
    expect(m.cpuCalls).toBe(before.cpu);
  });

  test('a clock that went back starts a new baseline instead of a negative window', () => {
    const { m, mem, cpu } = meters();
    const s = measure(null, 5_000_000, mem, cpu).sample;
    m.user = 10_000_000;
    const back = measure(s, 1_000_000, mem, cpu);
    expect(back.line).toBeNull();
    expect(back.sample.at).toBe(1_000_000);
    const later = measure(back.sample, 1_000_000 + SELF_MEASURE_INTERVAL_MS, mem, cpu);
    expect(later.line).toBe('self: rss=41MB heap=12MB cpu=0.0%');
  });

  test('CPU counters that went down do not print a negative share', () => {
    const { m, mem, cpu } = meters();
    m.user = 9_000_000;
    const s = measure(null, 0, mem, cpu).sample;
    m.user = 0;
    expect(measure(s, SELF_MEASURE_INTERVAL_MS, mem, cpu).line).toBe('self: rss=41MB heap=12MB cpu=0.0%');
  });
});
