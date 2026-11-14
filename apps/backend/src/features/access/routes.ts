import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiError } from '@copilot/shared';
import type { RouteContext } from '../../http/app';
import { HTTP_STATUS, HttpError, MESSAGES, apiError } from '../../http/errors';
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

/**
 * True when the Host header names this machine: localhost, 127.x.x.x or [::1], with an optional port.
 * Without OWNER_TOKEN this is what keeps a web page whose name was re-pointed at 127.0.0.1 (DNS rebinding) away from
 * the open API: the browser sends that page's own name as Host.
 */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (typeof host !== 'string') return false;
  const match = /^(\[::1\]|[^:[\]]+)(:\d{1,5})?$/.exec(host.trim());
  if (!match) return false;
  const name = match[1].toLowerCase();
  return name === 'localhost' || name === '[::1]' || /^127(\.\d{1,3}){3}$/.test(name);
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
 * needs the session cookie; without it the API is open (config.ts then allows only a loopback HOST) and every request
 * must name a loopback host in its Host header. /car/v1 routes authenticate devices themselves (car-link/routes.ts).
 */
export function ownerAuthHook(ctx: Pick<RouteContext, 'config' | 'clock'>) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    if (!ctx.config.ownerToken) {
      if (isLoopbackHostHeader(request.headers.host)) return undefined;
      request.log.info('request with a non-loopback Host refused (open API)');
      return reply.code(HTTP_STATUS.validation).send(apiError('validation', MESSAGES.invalidRequest));
    }
    if (request.method === 'OPTIONS') return undefined;
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
