import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { appConfig } from './app.config';

/**
 * The installable app (Plan 3 Task 4): the web manifest, the icons, the service-worker configuration and the
 * nginx rules that keep answers, live streams and the car link away from any cache.
 */

// The spec runs in Node under Vitest, but the panel has no Node typings, so the built-in module is taken untyped.
interface NodeFs {
  readFileSync(path: string): Uint8Array;
  readFileSync(path: string, encoding: 'utf8'): string;
  existsSync(path: string): boolean;
}
const nodeProcess = (globalThis as unknown as {
  process: { cwd(): string; getBuiltinModule(id: 'node:fs'): NodeFs };
}).process;
const fs = nodeProcess.getBuiltinModule('node:fs');
/** `npm test` runs in apps/companion. */
const ROOT = nodeProcess.cwd();
const read = (path: string): string => fs.readFileSync(`${ROOT}/${path}`, 'utf8');
const readJson = <T>(path: string): T => JSON.parse(read(path)) as T;

interface ManifestIcon { src: string; sizes: string; type: string; purpose?: string }
interface Manifest {
  name: string; short_name: string; lang: string; display: string; start_url: string; scope: string;
  theme_color: string; background_color: string; icons: ManifestIcon[];
}
interface AssetGroup { name: string; resources: { files?: string[]; urls?: string[] } }
interface NgswConfig {
  index: string; assetGroups: AssetGroup[]; dataGroups?: unknown[]; navigationUrls?: string[]; navigationRequestStrategy?: string;
}

/** Width and height from the IHDR chunk of a PNG file. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = fs.readFileSync(`${ROOT}/${path}`);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  expect(Array.from(bytes.subarray(0, 8))).toEqual(signature);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** The service worker's glob rules: `**` crosses slashes, `*` does not, `?` is one character. */
function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { source += '.*'; i++; }
    else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** Requests that must always reach the network: answers, live streams, sign-in, pairing and the car link. */
const NETWORK_ONLY = [
  '/api/ask/stream', '/api/events', '/api/status', '/api/session', '/api/devices', '/api/devices/abc',
  '/car/v1/dialog', '/car/v1/snapshots', '/car/v1/alerts',
];

describe('installable app', () => {
  describe('web manifest', () => {
    const manifest = readJson<Manifest>('public/manifest.webmanifest');
    const tokens = readJson<{ color: { tokens: { name: string; value: string }[] } }>('../../docs/design/tokens.json');
    const ground = tokens.color.tokens.find((token) => token.name === 'ground')?.value;

    it('is named Copilot, Ukrainian, standalone and starts at the assistant', () => {
      expect(manifest.name).toBe('Copilot');
      expect(manifest.short_name).toBe('Copilot');
      expect(manifest.lang).toBe('uk');
      expect(manifest.display).toBe('standalone');
      expect(manifest.start_url).toBe('/');
      expect(manifest.scope).toBe('/');
    });

    it('takes its theme and background colour from the design token ground', () => {
      expect(ground).toBe('#05070a');
      expect(manifest.theme_color).toBe(ground);
      expect(manifest.background_color).toBe(ground);
    });

    it('lists 192 and 512 px icons and a maskable 512 px icon that exist at those sizes', () => {
      const find = (sizes: string, purpose: string) =>
        manifest.icons.find((icon) => icon.sizes === sizes && (icon.purpose ?? 'any').split(' ').includes(purpose));
      const expected: [string, string][] = [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']];
      for (const [sizes, purpose] of expected) {
        const icon = find(sizes, purpose);
        expect(icon, `${sizes} ${purpose}`).toBeDefined();
        expect(icon!.type).toBe('image/png');
        const [width, height] = sizes.split('x').map(Number);
        expect(pngSize(`public/${icon!.src}`)).toEqual({ width, height });
      }
    });

    it('is linked from index.html', () => {
      expect(read('src/index.html')).toContain('<link rel="manifest" href="manifest.webmanifest">');
    });
  });

  describe('service worker configuration', () => {
    const config = readJson<NgswConfig>('ngsw-config.json');
    const patterns = config.assetGroups.flatMap((group) => [...(group.resources.files ?? []), ...(group.resources.urls ?? [])]);

    it('caches the app shell only: no data groups', () => {
      expect(config.index).toBe('/index.html');
      expect(config.dataGroups ?? []).toEqual([]);
      expect(config.assetGroups.length).toBeGreaterThan(0);
    });

    it('has no asset pattern that matches the API or the car link', () => {
      for (const pattern of patterns) {
        expect(pattern).not.toMatch(/^\/(api|car)\b/);
        for (const url of NETWORK_ONLY) expect(globToRegExp(pattern).test(url), `${pattern} ~ ${url}`).toBe(false);
      }
    });

    it('never answers a navigation to the API or the car link with the app shell', () => {
      const urls = config.navigationUrls ?? [];
      expect(urls).toContain('!/api/**');
      expect(urls).toContain('!/car/v1/**');
    });

    it('loads the newest app shell from the network on every visit, the cached one only when offline', () => {
      expect(config.navigationRequestStrategy).toBe('freshness');
    });
  });

  describe('service worker script', () => {
    /** Runs public/copilot-sw.js against a fake worker scope and returns its fetch listener. */
    function load() {
      const listeners: { type: string; listener: (event: unknown) => void }[] = [];
      const imported: string[] = [];
      const scope = {
        location: { origin: 'https://panel.example' },
        addEventListener: (type: string, listener: (event: unknown) => void) => {
          // The bypass must be registered before the Angular worker adds its own fetch listener.
          expect(imported).toEqual([]);
          listeners.push({ type, listener });
        },
      };
      const run = new Function('self', 'importScripts', read('public/copilot-sw.js')) as
        (self: unknown, importScripts: (...urls: string[]) => void) => void;
      run(scope, (...urls: string[]) => imported.push(...urls));
      const fetchListener = listeners.find((entry) => entry.type === 'fetch')?.listener;
      expect(fetchListener).toBeDefined();
      return { fetchListener: fetchListener!, imported };
    }

    function dispatch(listener: (event: unknown) => void, url: string) {
      const event = { request: { url }, stopImmediatePropagation: vi.fn(), respondWith: vi.fn() };
      listener(event);
      return event;
    }

    it('loads the Angular service worker after its own fetch listener', () => {
      expect(load().imported).toEqual(['ngsw-worker.js']);
    });

    it.each(NETWORK_ONLY)('leaves %s to the browser and the network', (path) => {
      const event = dispatch(load().fetchListener, `https://panel.example${path}?x=1`);
      expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(1);
      expect(event.respondWith).not.toHaveBeenCalled();
    });

    it.each(['/', '/car', '/main-ABC123.js', '/manifest.webmanifest', '/api-docs.html'])
      ('hands %s to the Angular worker', (path) => {
        const event = dispatch(load().fetchListener, `https://panel.example${path}`);
        expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
        expect(event.respondWith).not.toHaveBeenCalled();
      });

    it('hands requests to another origin to the Angular worker', () => {
      const event = dispatch(load().fetchListener, 'https://fonts.example/api/x');
      expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    });
  });

  describe('nginx', () => {
    const conf = read('nginx.conf');
    const block = (location: string): string => {
      const start = conf.indexOf(`location ${location} {`);
      expect(start, location).toBeGreaterThanOrEqual(0);
      return conf.slice(start, conf.indexOf('}', start));
    };

    it('proxies the car link unbuffered, above the 25 s dialog long poll, with a 1 MB body limit', () => {
      const car = block('/car/v1/');
      expect(car).toContain('proxy_pass http://backend:3000;');
      expect(car).toContain('proxy_buffering off;');
      expect(car).toContain('client_max_body_size 1m;');
      const timeout = /proxy_read_timeout (\d+)s;/.exec(car);
      expect(Number(timeout?.[1])).toBeGreaterThanOrEqual(60);
    });

    it('keeps the API unbuffered and never caches index.html or the service worker scripts', () => {
      expect(block('/api/')).toContain('proxy_buffering off;');
      for (const path of ['/index.html', '/copilot-sw.js', '/ngsw-worker.js', '/ngsw.json', '/safety-worker.js', '/worker-basic.min.js']) {
        expect(block(`= ${path}`)).toContain('add_header Cache-Control "no-cache"');
      }
    });
  });

  describe('app config', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({ providers: [...appConfig.providers, provideHttpClientTesting()] });
    });

    it('registers the service worker without dropping the 401 interceptor', async () => {
      expect(TestBed.inject(SwUpdate)).toBeInstanceOf(SwUpdate);
      const router = TestBed.inject(Router);
      const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
      let failed: unknown = null;
      TestBed.inject(HttpClient).get('/api/status').subscribe({ error: (error: unknown) => (failed = error) });
      TestBed.inject(HttpTestingController).expectOne('/api/status').flush(null, { status: 401, statusText: 'Unauthorized' });
      expect(failed).toBeInstanceOf(HttpErrorResponse);
      expect(navigate).toHaveBeenCalledWith(['/login'], expect.anything());
    });
  });
});
