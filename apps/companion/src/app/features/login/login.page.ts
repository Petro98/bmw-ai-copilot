import { HttpClient, HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { LiveService } from '../../core/live.service';

export const LOGIN_PATH = '/login';
const SESSION_URL = '/api/session';

// Ukrainian, sentence case, no exclamation marks (docs/design/README.md → Content).
export const LOGIN_TEXT = {
  empty: 'Введіть ключ доступу.',
  failed: 'Не вдалося увійти. Перевірте зʼєднання і спробуйте ще раз.',
} as const;

/**
 * Where to go after signing in: an address inside the panel only (no other origin, no `//host`), never the sign-in
 * page itself, and never with a fragment (the pairing address carries the device secret there).
 */
export function safeReturnUrl(value: unknown): string {
  if (typeof value !== 'string') return '/';
  const path = value.split('#')[0];
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\') || path.startsWith(LOGIN_PATH)) return '/';
  return path;
}

/**
 * Opens «Вхід», which returns to the current page afterwards (its address without the fragment). Does nothing while
 * the owner is already there. Every 401 the panel meets ends here.
 */
export function goToLogin(router: Router): void {
  const current = router.url.split('#')[0];
  if (current.startsWith(LOGIN_PATH)) return;
  void router.navigate([LOGIN_PATH], { queryParams: { return: safeReturnUrl(current) } });
}

/**
 * A 401 from any API call (except the sign-in itself) sends the owner to «Вхід» (`goToLogin`).
 */
export const unauthorizedInterceptor: HttpInterceptorFn = (request, next) => {
  const router = inject(Router);
  return next(request).pipe(
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse && error.status === 401 && !request.url.startsWith(SESSION_URL)) {
        goToLogin(router);
      }
      return throwError(() => error);
    }),
  );
};

/** The server's Ukrainian `ApiError` message when there is one, otherwise the fallback. */
function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof HttpErrorResponse) {
    const message: unknown = (error.error as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return fallback;
}

/**
 * «Вхід»: the owner types the access token once; the backend answers with an HttpOnly session cookie. The token is
 * read from the field when sent and kept nowhere else (no signal, no storage, no log).
 */
@Component({
  selector: 'app-login-page',
  templateUrl: './login.page.html',
  styleUrl: './login.page.css',
})
export class LoginPage {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly live = inject(LiveService);

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected submit(event: Event, field: HTMLInputElement): void {
    event.preventDefault();
    if (this.busy()) return;
    const token = field.value;
    if (token.trim() === '') {
      this.error.set(LOGIN_TEXT.empty);
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.http.post(SESSION_URL, { token }).subscribe({
      next: () => {
        field.value = '';
        this.busy.set(false);
        // The stream failed while signed out and may be waiting up to 30 s for its next try: open it now.
        this.live.reconnectNow();
        void this.router.navigateByUrl(safeReturnUrl(this.route.snapshot.queryParamMap.get('return')));
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(error, LOGIN_TEXT.failed));
      },
    });
  }
}
