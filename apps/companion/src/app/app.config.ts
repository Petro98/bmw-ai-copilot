import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { unauthorizedInterceptor } from './features/login/login.page';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // A 401 from any API call sends the owner to «Вхід» (Plan 2 Task 7).
    provideHttpClient(withFetch(), withInterceptors([unauthorizedInterceptor])),
    provideRouter(routes),
  ],
};
