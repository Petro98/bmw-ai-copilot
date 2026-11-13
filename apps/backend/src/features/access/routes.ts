import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiError } from '@copilot/shared';
import type { RouteContext } from '../../http/app';
import { HTTP_STATUS, HttpError, apiError } from '../../http/errors';
import {
  LoginLimiter, SESSION_COOKIE, issueSessionValue, readCookie, sameSecret, sessionClearCookie, sessionSetCookie,
  verifySessionValue,
} from './session';

// Ukrainian, sentence case, no exclamation marks (docs/design/README.md → Content).
export const ACCESS_MESSAGES = {
  signIn: 'Потрібно увійти.',
  deviceRefused: 'Пристрій не підʼєднано або його відʼєднано.',
  wrongToken: 'Невірний ключ доступу.',
  locked: 'Забагато спроб входу. Спробуйте через хвилину.',
  badLogin: 'Введіть ключ доступу.',
} as const;

/** The body of a 401 (sent with HTTP_STATUS.unauthorized); clients act on the HTTP status. */
export function unauthorized(message: string): ApiError {
  return apiError('unauthorized', message);
}

/** Routes under /api that stay open with OWNER_TOKEN set (matched against the route pattern, not the raw URL). */
const OPEN_API_ROUTES: ReadonlySet<string> = new Set(['/api/health', '/api/session']);
const MAX_TOKEN_CHARS = 512;

const loginSchema = z.object({ token: z.string().min(1).max(MAX_TOKEN_CHARS) });

/** The peer address of the socket. X-Forwarded-For is never trusted (the app does not enable trustProxy). */
function remoteAddress(request: FastifyRequest): string {
  return request.socket?.remoteAddress ?? 'unknown';
}

/** True when the request carries a valid owner session cookie. */
export function hasOwnerSession(request: FastifyRequest, ctx: Pick<RouteContext, 'config' | 'clock'>): boolean {
  const secret = ctx.config.sessionSecret;
  if (!secret) return false;
  const value = readCookie(request.headers.cookie, SESSION_COOKIE);
  return value !== null && verifySessionValue(value, secret, ctx.clock.now());
}

/**
 * The one owner-access hook (onRequest). With OWNER_TOKEN set, every /api route except /api/health and /api/session
 * needs the session cookie; without it the API is open (config.ts then allows only a loopback HOST).
 * /car/v1 routes authenticate devices themselves (car-link/routes.ts).
 */
export function ownerAuthHook(ctx: Pick<RouteContext, 'config' | 'clock'>) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    if (!ctx.config.ownerToken || request.method === 'OPTIONS') return undefined;
    const route = request.routeOptions.url;
    // An unmatched URL reaches the 404 handler, which reveals nothing.
    if (typeof route !== 'string' || !route.startsWith('/api/') || OPEN_API_ROUTES.has(route)) return undefined;
    if (hasOwnerSession(request, ctx)) return undefined;
    return reply.code(HTTP_STATUS.unauthorized).send(unauthorized(ACCESS_MESSAGES.signIn));
  };
}

/** `POST /api/session { token }` (sign in) and `DELETE /api/session` (sign out). Neither body nor log holds the token. */
export function accessRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const limiter = new LoginLimiter();

  app.post('/api/session', async (request, reply) => {
    const { ownerToken, sessionSecret } = ctx.config;
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError('validation', ACCESS_MESSAGES.badLogin);
    // No OWNER_TOKEN: the API is open and needs no session.
    if (!ownerToken || !sessionSecret) return reply.code(204).send();

    const address = remoteAddress(request);
    const now = ctx.clock.now();
    if (limiter.isLocked(address, now)) throw new HttpError('rate-limited', ACCESS_MESSAGES.locked);
    if (!sameSecret(parsed.data.token, ownerToken)) {
      limiter.recordFailure(address, now);
      request.log.info('owner sign-in refused');
      return reply.code(HTTP_STATUS.unauthorized).send(unauthorized(ACCESS_MESSAGES.wrongToken));
    }
    limiter.reset(address);
    request.log.info('owner signed in');
    return reply.code(204).header('set-cookie', sessionSetCookie(issueSessionValue(sessionSecret, now))).send();
  });

  app.delete('/api/session', async (_request, reply) => reply.code(204).header('set-cookie', sessionClearCookie()).send());
}
