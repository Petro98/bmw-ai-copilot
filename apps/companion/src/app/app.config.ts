import { ApplicationConfig, isDevMode, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './app.routes';
import { unauthorizedInterceptor } from './features/login/login.page';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // A 401 from any API call sends the owner to «Вхід» (Plan 2 Task 7).
    provideHttpClient(withFetch(), withInterceptors([unauthorizedInterceptor])),
    provideRouter(routes),
    // Installable app (Plan 3 Task 4): caches the app shell only. copilot-sw.js wraps Angular's worker and leaves
    // /api/* and /car/v1/* to the network untouched; ngsw-config.json has no data groups. Production builds only.
    provideServiceWorker('copilot-sw.js', { enabled: !isDevMode(), registrationStrategy: 'registerWhenStable:30000' }),
  ],
};
