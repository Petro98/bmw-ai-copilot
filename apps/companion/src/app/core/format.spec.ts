import { available, unavailable } from '@copilot/vehicle-core';
import { formatNumber, formatReading, unavailableText } from './format';

const NNBSP = ' ';   // narrow no-break space between thousands

describe('format', () => {
  it('formats a reading with its unit and a decimal comma', () => {
    expect(formatReading(available(2.35, 'bar', 'mock', 0), 0)).toMatchObject({ text: '2,4', unit: 'бар', available: true });
    expect(formatNumber(1850)).toBe(`1${NNBSP}850`);
  });

  it('formats an unavailable reading as «Недоступно» with the reason', () => {
    expect(formatReading(unavailable('diagnostics-disabled'), 0))
      .toEqual({ text: 'Недоступно', unit: null, note: 'Потрібне діагностичне читання. Воно вимкнене в налаштуваннях.', available: false });
  });

  it('adds an age note to a reading older than a minute', () => {
    const minute = 60_000;
    expect(formatReading(available(92, '°C', 'mock', 0), 20 * minute).note).toBe('20 хв тому');
    expect(formatReading(available(92, '°C', 'mock', 0), 59_000).note).toBeNull();
    expect(formatReading(available(92, '°C', 'mock', 0), 3 * 60 * minute).note).toBe('3 год тому');
  });

  it('never shows a negative age when the clock went backwards', () => {
    expect(formatReading(available(92, '°C', 'mock', 50_000_000), 0).note).toBeNull();
  });

  it('formats numbers with a decimal comma, grouped thousands and no trailing zeros', () => {
    expect(formatNumber(2.35)).toBe('2,4');
    expect(formatNumber(92)).toBe('92');
    expect(formatNumber(2.0)).toBe('2');
    expect(formatNumber(12345.678, 2)).toBe(`12${NNBSP}345,68`);
    expect(formatNumber(1234567)).toBe(`1${NNBSP}234${NNBSP}567`);
    expect(formatNumber(-5.25)).toBe('-5,3');
    expect(formatNumber(-0.01)).toBe('0');
    expect(formatNumber(999)).toBe('999');
  });

  it('uses the unit the car displays and its precision', () => {
    expect(formatReading(available(1850, 'rpm', 'mock', 0), 0)).toMatchObject({ text: `1${NNBSP}850`, unit: 'об/хв' });
    expect(formatReading(available(92.4, '°C', 'mock', 0), 0)).toMatchObject({ text: '92', unit: '°C' });
    expect(formatReading(available(2, 'bar', 'mock', 0), 0)).toMatchObject({ text: '2,0', unit: 'бар' });
    expect(formatReading(available(41, 'l', 'mock', 0), 0)).toMatchObject({ text: '41', unit: 'л' });
    expect(formatReading(available(452, 'km', 'mock', 0), 0)).toMatchObject({ text: '452', unit: 'км' });
    expect(formatReading(available(84, '%', 'mock', 0), 0)).toMatchObject({ text: '84', unit: '%' });
    expect(formatReading(available(12.42, 'V', 'mock', 0), 0)).toMatchObject({ text: '12,4', unit: 'В' });
  });

  it('shows a text reading as it is', () => {
    expect(formatReading(available('D4', null, 'mock', 0), 0)).toEqual({ text: 'D4', unit: null, note: null, available: true });
  });

  it('has a reason in words for every unavailable reason', () => {
    for (const reason of ['not-reported', 'invalid-value', 'not-on-this-vehicle', 'diagnostics-disabled', 'stale'] as const) {
      expect(unavailableText(reason)).toMatch(/^\p{Lu}.+\.$/u);
    }
  });
});
