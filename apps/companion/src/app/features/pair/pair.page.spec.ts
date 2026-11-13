import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Location } from '@angular/common';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import type { DeviceDto, DeviceRegistration } from '@copilot/shared';
import { routes } from '../../app.routes';
import { LoginPage, safeReturnUrl, unauthorizedInterceptor } from '../login/login.page';
import { DeviceApi, PairPage, PairingDraft, parsePairingFragment } from './pair.page';

// Obviously fake values of the required lengths: never a real device.
const DEVICE_ID = 'test-device-000000000001';
const SECRET = 'feedface'.repeat(8);
const PAIR_URL = `/pair#d=${DEVICE_ID}&s=${SECRET}`;

const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

@Component({ template: '' })
class Blank {}

describe('PairPage', () => {
  let api: { list: ReturnType<typeof vi.fn>; register: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  let logged: unknown[][];

  async function render(): Promise<{ el: HTMLElement; update: () => Promise<void> }> {
    await TestBed.configureTestingModule({
      imports: [PairPage],
      providers: [provideRouter([{ path: 'login', component: Blank }]), { provide: DeviceApi, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(PairPage);
    fixture.detectChanges();
    await fixture.whenStable();
    const update = async () => { fixture.detectChanges(); await fixture.whenStable(); };
    return { el: fixture.nativeElement as HTMLElement, update };
  }

  beforeEach(() => {
    api = {
      list: vi.fn(() => of([])),
      register: vi.fn((r: DeviceRegistration): ReturnType<DeviceApi['register']> =>
        of({ deviceId: r.deviceId, label: r.label, createdAt: 1, lastSeenAt: null } satisfies DeviceDto)),
      remove: vi.fn(() => of(undefined)),
    };
    logged = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args); });
    }
    window.history.replaceState(null, '', PAIR_URL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('the pairing page registers the device and removes the fragment', async () => {
    const { el, update } = await render();
    // The fragment left the address bar as soon as the page read it.
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/pair');
    expect(text(el.querySelector('[data-device-id]'))).toBe(DEVICE_ID);
    expect(api.list).toHaveBeenCalledTimes(1);   // the session probe

    const label = el.querySelector<HTMLInputElement>('input#pair-label')!;
    expect(label.value).toBe('Головний блок');
    label.value = '  X3 головний блок  ';
    const connect = Array.from(el.querySelectorAll('button')).find((b) => text(b) === 'Підʼєднати')!;
    connect.click();
    await update();

    expect(api.register).toHaveBeenCalledWith({ deviceId: DEVICE_ID, secret: SECRET, label: 'X3 головний блок' });
    expect(el.textContent).toContain('Авто підʼєднано.');
    expect(TestBed.inject(PairingDraft).peek()).toBeNull();

    // The secret is never shown, logged or stored in the browser.
    expect(el.innerHTML).not.toContain(SECRET);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(SECRET);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(SECRET);
    expect(window.location.href).not.toContain(SECRET);
  });

  it('a rejected registration shows the server message and keeps the device for another try', async () => {
    api.register.mockReturnValueOnce(throwError(() => new HttpErrorResponse({
      status: 400, error: { error: { code: 'validation', message: 'Вкажіть назву пристрою: до 60 символів.' } },
    })));
    const { el, update } = await render();
    const connect = Array.from(el.querySelectorAll('button')).find((b) => text(b) === 'Підʼєднати')!;
    connect.click();
    await update();
    expect(text(el.querySelector('[role="alert"]'))).toBe('Вкажіть назву пристрою: до 60 символів.');
    expect(TestBed.inject(PairingDraft).peek()?.deviceId).toBe(DEVICE_ID);
  });

  it('an incomplete pairing address registers nothing and is removed as well', async () => {
    window.history.replaceState(null, '', '/pair#d=short&s=tiny');
    const { el } = await render();
    expect(window.location.hash).toBe('');
    expect(el.textContent).toContain('Посилання для підʼєднання неповне. Відскануйте QR-код на екрані авто ще раз.');
    expect(el.querySelector('input#pair-label')).toBeNull();
    expect(api.list).not.toHaveBeenCalled();
  });

  it('without a pairing address the page says where to find one', async () => {
    window.history.replaceState(null, '', '/pair');
    const { el } = await render();
    expect(el.textContent).toContain('Відскануйте QR-код на екрані авто');
    expect(api.register).not.toHaveBeenCalled();
  });

  it('parses only a well-formed fragment', () => {
    expect(parsePairingFragment(`#d=${DEVICE_ID}&s=${SECRET}`)).toEqual({ deviceId: DEVICE_ID, secret: SECRET });
    expect(parsePairingFragment(`d=${encodeURIComponent(DEVICE_ID)}&s=${encodeURIComponent(SECRET)}`)).toEqual({ deviceId: DEVICE_ID, secret: SECRET });
    for (const bad of ['', '#', `#d=${DEVICE_ID}`, `#s=${SECRET}`, `#d=bad id&s=${SECRET}`, `#d=${DEVICE_ID}&s=short`]) {
      expect(parsePairingFragment(bad)).toBeNull();
    }
  });
});

describe('the pairing address through the Router', () => {
  const pairRoute = routes.find((r) => r.path === 'pair')!;

  async function open(url: string) {
    window.history.replaceState(null, '', url);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          pairRoute,
          { path: 'login', component: Blank },
          // A lazy chunk that does not arrive (a weak phone connection).
          { path: 'settings', loadComponent: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')) },
        ]),
        provideHttpClient(withInterceptors([unauthorizedInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    return { harness, router: TestBed.inject(Router), location: TestBed.inject(Location) };
  }

  afterEach(() => window.history.replaceState(null, '', '/'));

  it('the Router itself drops the fragment, and a failed navigation away does not bring it back', async () => {
    const { harness, router, location } = await open(PAIR_URL);
    expect(router.url).toBe('/pair');
    expect(location.path(true)).toBe('/pair');
    expect(window.location.href).not.toContain(SECRET);
    expect(TestBed.inject(PairingDraft).peek()).toEqual({ deviceId: DEVICE_ID, secret: SECRET });
    TestBed.inject(HttpTestingController).expectOne('/api/devices').flush([]);
    harness.detectChanges();
    expect(text((harness.routeNativeElement as HTMLElement).querySelector('[data-device-id]'))).toBe(DEVICE_ID);

    await expect(router.navigateByUrl('/settings')).rejects.toThrow('Failed to fetch dynamically imported module');
    expect(router.url).toBe('/pair');
    expect(location.path(true)).toBe('/pair');
    expect(window.location.href).not.toContain(SECRET);
    expect(router.url).not.toContain(SECRET);
  });

  it('an incomplete pairing address through the Router is dropped as well and shows the hint', async () => {
    const { harness, router, location } = await open('/pair#d=short&s=tiny');
    expect(router.url).toBe('/pair');
    expect(location.path(true)).toBe('/pair');
    expect(window.location.hash).toBe('');
    harness.detectChanges();
    expect((harness.routeNativeElement as HTMLElement).textContent)
      .toContain('Посилання для підʼєднання неповне. Відскануйте QR-код на екрані авто ще раз.');
    TestBed.inject(HttpTestingController).expectNone('/api/devices');
  });
});

describe('signing in on the way', () => {
  it('a 401 from an API call sends the owner to /login with the return address, never with its fragment', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'pair', component: Blank }, { path: 'login', component: Blank }]),
        provideHttpClient(withInterceptors([unauthorizedInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(PAIR_URL);
    const router = TestBed.inject(Router);
    const http = TestBed.inject(HttpClient);
    const failed = vi.fn();
    http.get('/api/devices').subscribe({ error: failed });
    TestBed.inject(HttpTestingController).expectOne('/api/devices')
      .flush({ error: { code: 'unauthorized', message: 'Потрібно увійти.' } }, { status: 401, statusText: 'Unauthorized' });
    await harness.fixture.whenStable();
    expect(failed).toHaveBeenCalled();
    expect(router.url).toBe('/login?return=%2Fpair');
    expect(router.url).not.toContain(SECRET);
  });

  it('without a session the pairing page goes through /login and comes back with the device still pending', async () => {
    window.history.replaceState(null, '', PAIR_URL);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'pair', component: PairPage }, { path: 'login', component: Blank }]),
        provideHttpClient(withInterceptors([unauthorizedInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/pair');
    expect(window.location.hash).toBe('');
    const controller = TestBed.inject(HttpTestingController);
    controller.expectOne('/api/devices').flush(
      { error: { code: 'unauthorized', message: 'Потрібно увійти.' } }, { status: 401, statusText: 'Unauthorized' },
    );
    await harness.fixture.whenStable();
    const router = TestBed.inject(Router);
    expect(router.url).toBe('/login?return=%2Fpair');

    await harness.navigateByUrl('/pair');
    controller.expectOne('/api/devices').flush([]);
    harness.detectChanges();
    const el = harness.routeNativeElement as HTMLElement;
    expect(text(el.querySelector('[data-device-id]'))).toBe(DEVICE_ID);
    const connect = Array.from(el.querySelectorAll('button')).find((b) => text(b) === 'Підʼєднати')!;
    connect.click();
    const request = controller.expectOne('/api/devices');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ deviceId: DEVICE_ID, secret: SECRET, label: 'Головний блок' });
    request.flush({ deviceId: DEVICE_ID, label: 'Головний блок', createdAt: 1, lastSeenAt: null }, { status: 201, statusText: 'Created' });
    harness.detectChanges();
    expect(el.textContent).toContain('Авто підʼєднано.');
    window.history.replaceState(null, '', '/');
  });

  it('the sign-in page posts the token, keeps no copy and returns to the page that asked', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'login', component: LoginPage }, { path: 'pair', component: Blank }]),
        provideHttpClient(withInterceptors([unauthorizedInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/login?return=%2Fpair');
    const el = harness.routeNativeElement as HTMLElement;
    const field = el.querySelector<HTMLInputElement>('input#login-token')!;
    expect(field.type).toBe('password');
    expect(el.textContent).toContain('Введіть ключ доступу, заданий на сервері.');

    const button = Array.from(el.querySelectorAll('button')).find((b) => text(b) === 'Увійти')!;
    button.click();
    harness.detectChanges();
    expect(text(el.querySelector('[role="alert"]'))).toBe('Введіть ключ доступу.');

    const controller = TestBed.inject(HttpTestingController);
    field.value = 'wrong-token-000000000000000000';
    button.click();
    controller.expectOne('/api/session').flush(
      { error: { code: 'unauthorized', message: 'Невірний ключ доступу.' } }, { status: 401, statusText: 'Unauthorized' },
    );
    harness.detectChanges();
    expect(text(el.querySelector('[role="alert"]'))).toBe('Невірний ключ доступу.');
    expect(TestBed.inject(Router).url).toBe('/login?return=%2Fpair');

    field.value = 'test-owner-token-000000000000';
    button.click();
    const request = controller.expectOne('/api/session');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ token: 'test-owner-token-000000000000' });
    request.flush(null, { status: 204, statusText: 'No Content' });
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/pair');
    expect(field.value).toBe('');
  });

  it('returns only inside the panel', () => {
    expect(safeReturnUrl('/pair')).toBe('/pair');
    expect(safeReturnUrl(`/pair#d=${DEVICE_ID}&s=${SECRET}`)).toBe('/pair');
    expect(safeReturnUrl('/settings?x=1')).toBe('/settings?x=1');
    for (const bad of [null, undefined, '', 'https://example.invalid/', '//example.invalid', '/\\example.invalid', '/login', 'pair']) {
      expect(safeReturnUrl(bad)).toBe('/');
    }
  });
});
