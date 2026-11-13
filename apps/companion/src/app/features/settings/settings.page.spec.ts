import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import type { DeviceDto, ScenarioDto, SettingsDto, StatusDto } from '@copilot/shared';
import { ApiService } from '../../core/api.service';
import { LiveService } from '../../core/live.service';
import { DeviceApi } from '../pair/pair.page';
import { SettingsPage, formatDateTime } from './settings.page';

const SETTINGS: SettingsDto = {
  ownerLimits: { oilTempMaxC: 115, coolantTempMaxC: null, battery12vMinPercent: null, tyrePressureDeviationBar: null },
  popupsEnabled: true,
  diagnosticsEnabled: false,
};

function status(source: 'mock' | 'car', voiceModel = 'claude-opus-5-5'): StatusDto {
  return {
    version: '0.1.0',
    vehicle: { source, connected: true, lastSnapshotAt: 1, scenario: source === 'mock' ? 'steady-cruise' : null },
    claude: { mode: 'live', model: 'claude-opus-5-5', voiceModel },
    budget: { dayUsd: 0.12, dayLimitUsd: 1, monthUsd: 3.4, monthLimitUsd: 20 },
  };
}

const SCENARIO_LIST: ScenarioDto[] = [
  { id: 'steady-cruise', title: 'Рівна їзда' },
  { id: 'signals-missing', title: 'Сигнали відсутні' },
];

const DEVICES: DeviceDto[] = [
  { deviceId: 'test-device-000000000002', label: 'Новий блок', createdAt: Date.UTC(2026, 10, 12, 9, 5), lastSeenAt: null },
  { deviceId: 'test-device-000000000001', label: 'Головний блок', createdAt: Date.UTC(2026, 10, 1, 8, 0), lastSeenAt: Date.UTC(2026, 10, 13, 7, 30) },
];

describe('SettingsPage', () => {
  let devices: { list: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; register: ReturnType<typeof vi.fn> };
  let live: { status: ReturnType<typeof signal<StatusDto | null>> };
  let api: { settings: ReturnType<typeof vi.fn>; saveSettings: ReturnType<typeof vi.fn>; scenarios: ReturnType<typeof vi.fn>; setScenario: ReturnType<typeof vi.fn> };

  async function render(): Promise<{ el: HTMLElement; update: () => Promise<void> }> {
    await TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [
        { provide: LiveService, useValue: live }, { provide: ApiService, useValue: api }, { provide: DeviceApi, useValue: devices },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const update = async () => { fixture.detectChanges(); await fixture.whenStable(); };
    return { el: fixture.nativeElement as HTMLElement, update };
  }

  const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const limitRow = (el: HTMLElement, key: string) => el.querySelector<HTMLButtonElement>(`[data-limit="${key}"]`)!;
  const button = (el: HTMLElement, label: string) => Array.from(el.querySelectorAll('button')).find((b) => text(b) === label)!;

  beforeEach(() => {
    devices = { list: vi.fn(() => of(DEVICES)), remove: vi.fn(() => of(undefined)), register: vi.fn() };
    live = { status: signal<StatusDto | null>(status('mock')) };
    api = {
      settings: vi.fn(() => of(SETTINGS)),
      saveSettings: vi.fn((s: SettingsDto) => of(s)),
      scenarios: vi.fn(() => of(SCENARIO_LIST)),
      setScenario: vi.fn((id: string) => of({ id })),
    };
  });

  it('shows the four owner limits as the owner\'s own, each «Не задано» or its value', async () => {
    const { el } = await render();
    expect(el.textContent).toContain('Це ваші власні межі, а не значення BMW. Поки ліміт не задано, попереджень за ним немає.');
    expect(text(limitRow(el, 'oilTempMaxC'))).toBe('Температура масла 115 °C');
    expect(text(limitRow(el, 'coolantTempMaxC'))).toBe('Охолоджувальна рідина Не задано');
    expect(text(limitRow(el, 'battery12vMinPercent'))).toBe('Акумулятор 12 В Не задано');
    expect(text(limitRow(el, 'tyrePressureDeviationBar'))).toBe('Відхилення тиску в шинах Не задано');
  });

  it('saving a limit sends a number; «Прибрати ліміт» sends null', async () => {
    const { el, update } = await render();
    limitRow(el, 'coolantTempMaxC').click();
    await update();
    const input = el.querySelector<HTMLInputElement>('input#limit-coolantTempMaxC')!;
    expect(input.type).toBe('number');
    expect(el.querySelector('label[for="limit-coolantTempMaxC"]')).not.toBeNull();
    input.value = '105';
    input.dispatchEvent(new Event('input'));
    await update();
    button(el, 'Зберегти').click();
    await update();
    expect(api.saveSettings).toHaveBeenLastCalledWith({ ...SETTINGS, ownerLimits: { ...SETTINGS.ownerLimits, coolantTempMaxC: 105 } });
    expect(text(limitRow(el, 'coolantTempMaxC'))).toBe('Охолоджувальна рідина 105 °C');
    expect(el.querySelector('input#limit-coolantTempMaxC')).toBeNull();

    limitRow(el, 'oilTempMaxC').click();
    await update();
    button(el, 'Прибрати ліміт').click();
    await update();
    const sent = api.saveSettings.mock.lastCall?.[0] as SettingsDto;
    expect(sent.ownerLimits.oilTempMaxC).toBeNull();
    expect(sent.ownerLimits.coolantTempMaxC).toBe(105);
    expect(text(limitRow(el, 'oilTempMaxC'))).toBe('Температура масла Не задано');
  });

  it('a rejected limit shows the server message and keeps the previous value', async () => {
    api.saveSettings.mockReturnValue(throwError(() => new HttpErrorResponse({
      status: 400, error: { error: { code: 'validation', message: 'Ліміт масла має бути від 40 до 200 °C.' } },
    })));
    const { el, update } = await render();
    limitRow(el, 'oilTempMaxC').click();
    await update();
    const input = el.querySelector<HTMLInputElement>('input#limit-oilTempMaxC')!;
    expect(input.value).toBe('115');
    input.value = '900';
    input.dispatchEvent(new Event('input'));
    await update();
    button(el, 'Зберегти').click();
    await update();
    expect(api.saveSettings).toHaveBeenCalledWith({ ...SETTINGS, ownerLimits: { ...SETTINGS.ownerLimits, oilTempMaxC: 900 } });
    expect(text(el.querySelector('[data-limit-error]'))).toBe('Ліміт масла має бути від 40 до 200 °C.');
    expect(text(limitRow(el, 'oilTempMaxC'))).toBe('Температура масла 115 °C');
  });

  it('does not rewrite the field while the owner types an incomplete decimal', async () => {
    const { el, update } = await render();
    limitRow(el, 'oilTempMaxC').click();
    await update();
    const input = el.querySelector<HTMLInputElement>('input#limit-oilTempMaxC')!;
    expect(input.value).toBe('115');
    // Record every write to this element's value; a browser reports '' for "115." while the text stays visible.
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    const writes: string[] = [];
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() { return proto.get!.call(this) as string; },
      set(v: string) { writes.push(v); proto.set!.call(this, v); },
    });
    proto.set!.call(input, '');
    input.dispatchEvent(new Event('input'));
    await update();
    expect(writes).toEqual([]);
    expect(button(el, 'Зберегти').disabled).toBe(true);
    proto.set!.call(input, '0.35');
    input.dispatchEvent(new Event('input'));
    await update();
    expect(writes).toEqual([]);
    button(el, 'Зберегти').click();
    await update();
    expect(api.saveSettings).toHaveBeenLastCalledWith({ ...SETTINGS, ownerLimits: { ...SETTINGS.ownerLimits, oilTempMaxC: 0.35 } });
  });

  it('does not send a limit that is not a number', async () => {
    const { el, update } = await render();
    limitRow(el, 'battery12vMinPercent').click();
    await update();
    expect(button(el, 'Зберегти').disabled).toBe(true);
    button(el, 'Зберегти').click();
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('switches pop-ups and shows the diagnostics switch disabled with its note', async () => {
    const { el, update } = await render();
    const popups = el.querySelector<HTMLInputElement>('input#popups')!;
    expect(popups.checked).toBe(true);
    expect(text(el.querySelector('label[for="popups"]'))).toBe('Вікна на екрані авто');
    popups.click();
    await update();
    expect(api.saveSettings).toHaveBeenLastCalledWith({ ...SETTINGS, popupsEnabled: false });

    const diagnostics = el.querySelector<HTMLInputElement>('input#diagnostics')!;
    expect(diagnostics.disabled).toBe(true);
    expect(diagnostics.checked).toBe(false);
    expect(text(el.querySelector('label[for="diagnostics"]'))).toContain('Вимкнено, доки ви не погодите перевірку в авто');
  });

  it('shows the models and today\'s and this month\'s spend against the budgets', async () => {
    const { el, update } = await render();
    expect(text(el.querySelector('[data-line="model"]'))).toBe('Модель claude-opus-5-5');
    expect(text(el.querySelector('[data-line="voice-model"]'))).toBe('Модель для голосу Та сама');
    expect(text(el.querySelector('[data-line="spend-day"]'))).toBe('Сьогодні 0,12 $ з 1 $');
    expect(text(el.querySelector('[data-line="spend-month"]'))).toBe('Цього місяця 3,4 $ з 20 $');
    live.status.set(status('mock', 'claude-haiku-5'));
    await update();
    expect(text(el.querySelector('[data-line="voice-model"]'))).toBe('Модель для голосу claude-haiku-5');
  });

  it('lists the demo scenarios when the vehicle source is mock and switches to the chosen one', async () => {
    const { el, update } = await render();
    const select = el.querySelector<HTMLSelectElement>('select#scenario')!;
    expect(text(el.querySelector('label[for="scenario"]'))).toBe('Демо-сценарій');
    expect(Array.from(select.options).map((o) => o.textContent?.trim())).toEqual(['Рівна їзда', 'Сигнали відсутні']);
    expect(select.value).toBe('steady-cruise');
    select.value = 'signals-missing';
    select.dispatchEvent(new Event('change'));
    await update();
    expect(api.setScenario).toHaveBeenCalledWith('signals-missing');
  });

  it('the scenario selector is absent when the vehicle source is car', async () => {
    live.status.set(status('car'));
    const { el } = await render();
    expect(el.querySelector('select#scenario')).toBeNull();
    expect(el.textContent).not.toContain('Демо-сценарій');
    expect(api.scenarios).not.toHaveBeenCalled();
  });

  it('lists the paired devices with when they were paired and last seen', async () => {
    const { el } = await render();
    expect(text(el.querySelector('#settings-devices'))).toBe('ПІДʼЄДНАНІ ПРИСТРОЇ');
    const rows = Array.from(el.querySelectorAll('[data-device]'));
    expect(rows.map((row) => row.getAttribute('data-device'))).toEqual(['test-device-000000000002', 'test-device-000000000001']);
    const hint = (row: Element) => text(row.querySelector('.hint'));
    expect(text(rows[0]).startsWith('Новий блок')).toBe(true);
    expect(hint(rows[0])).toBe(`Підʼєднано ${formatDateTime(DEVICES[0].createdAt)} · ще не виходив на звʼязок`);
    expect(text(rows[1]).startsWith('Головний блок')).toBe(true);
    expect(hint(rows[1])).toBe(`Підʼєднано ${formatDateTime(DEVICES[1].createdAt)} · на звʼязку ${formatDateTime(DEVICES[1].lastSeenAt!)}`);
    expect(rows.map((row) => text(row.querySelector('button')))).toEqual(['Відʼєднати', 'Відʼєднати']);
  });

  it('«Відʼєднати» revokes a device and removes its row; a failure keeps it and says so', async () => {
    const { el, update } = await render();
    const unpair = (id: string) => el.querySelector<HTMLButtonElement>(`[data-device="${id}"] button`)!;
    devices.remove.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 500 })));
    unpair('test-device-000000000002').click();
    await update();
    expect(devices.remove).toHaveBeenCalledWith('test-device-000000000002');
    expect(el.querySelectorAll('[data-device]')).toHaveLength(2);
    expect(text(el.querySelector('[data-devices-error]'))).toBe('Не вдалося відʼєднати пристрій. Спробуйте ще раз.');

    unpair('test-device-000000000002').click();
    await update();
    expect(Array.from(el.querySelectorAll('[data-device]')).map((row) => row.getAttribute('data-device'))).toEqual(['test-device-000000000001']);
    expect(el.querySelector('[data-devices-error]')).toBeNull();
  });

  it('with no paired device it says how to pair one', async () => {
    devices.list.mockReturnValue(of([]));
    const { el } = await render();
    expect(el.textContent).toContain('Немає підʼєднаних пристроїв. Відскануйте QR-код на екрані авто, щоб підʼєднати його.');
  });

  it('formats times as day, month, year and hour in local time', () => {
    const at = new Date(2026, 10, 3, 7, 5).getTime();
    expect(formatDateTime(at)).toBe('03.11.2026, 07:05');
  });
});
