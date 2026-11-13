import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { LiveService } from '../../core/live.service';
import { LoginPage, goToLogin, unauthorizedInterceptor } from './login.page';

@Component({ template: '' })
class Blank {}

describe('goToLogin', () => {
  async function at(url: string): Promise<Router> {
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: 'car', component: Blank }, { path: 'login', component: Blank }])],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    return TestBed.inject(Router);
  }

  it('opens «Вхід» with the current page as the return address', async () => {
    const router = await at('/car');
    goToLogin(router);
    await new Promise((r) => setTimeout(r, 0));
    expect(router.url).toBe('/login?return=%2Fcar');
  });

  it('stays put when the owner is already on «Вхід»', async () => {
    const router = await at('/login?return=%2Fcar');
    const navigate = vi.spyOn(router, 'navigate');
    goToLogin(router);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('LoginPage', () => {
  it('reconnects the live stream at once after signing in, instead of waiting for the next retry', async () => {
    const live = { reconnectNow: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'login', component: LoginPage }, { path: 'car', component: Blank }]),
        provideHttpClient(withInterceptors([unauthorizedInterceptor])),
        provideHttpClientTesting(),
        { provide: LiveService, useValue: live },
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/login?return=%2Fcar');
    const el = harness.routeNativeElement as HTMLElement;
    el.querySelector<HTMLInputElement>('input#login-token')!.value = 'test-owner-token-000000000000';
    el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    const controller = TestBed.inject(HttpTestingController);

    expect(live.reconnectNow).not.toHaveBeenCalled();
    controller.expectOne('/api/session').flush(null, { status: 204, statusText: 'No Content' });
    await harness.fixture.whenStable();
    expect(live.reconnectNow).toHaveBeenCalledTimes(1);
    expect(TestBed.inject(Router).url).toBe('/car');
  });

  it('does not reconnect when signing in fails', async () => {
    const live = { reconnectNow: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'login', component: LoginPage }]),
        provideHttpClient(withInterceptors([unauthorizedInterceptor])),
        provideHttpClientTesting(),
        { provide: LiveService, useValue: live },
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/login');
    const el = harness.routeNativeElement as HTMLElement;
    el.querySelector<HTMLInputElement>('input#login-token')!.value = 'wrong-token-000000000000000000';
    el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    TestBed.inject(HttpTestingController).expectOne('/api/session').flush(
      { error: { code: 'unauthorized', message: 'Невірний ключ доступу.' } }, { status: 401, statusText: 'Unauthorized' },
    );
    expect(live.reconnectNow).not.toHaveBeenCalled();
  });
});
