/**
 * API HTTP del Resolver (sin dependencias: node:http).
 *
 *   GET  /v1/home                 Home resuelta (contrato §7). ?debug=1 agrega diagnostics.
 *   POST /v1/webhooks/strapi      Publicación en Strapi → recarga contenido e invalida caché.
 *   POST /v1/events               Ingesta de eventos de la app (§15), buffer en memoria.
 *   GET  /v1/metrics              Salud: latencias, fuente, caché, decisiones por motivo.
 *   GET  /health
 *   /preview/*                    Simulador (solo con SIMULATOR_ENABLED).
 *   /v1/simulator/*               Opciones, kill switch y fallas simuladas (solo simulador).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { MODALITIES, PLATFORMS, isSemver, type Modality, type Platform, type ResolveRequest } from '@chedraui-xp/contract';
import { resolveHome, type ResolverDeps } from './engine/resolve.ts';
import type { ContentSnapshot, ContentSource } from './content/source.ts';
import type { ConnectorName, FaultInjection, StoreFile } from './connectors/fixtures.ts';

export interface ServerOptions {
  deps: Omit<ResolverDeps, 'content'>;
  source: ContentSource;
  webhookSecret: string;
  simulator?: {
    enabled: boolean;
    previewDir: string;
    storeFile: StoreFile;
    customers: { id: string; persona?: string }[];
    faults: FaultInjection;
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...headers });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('payload_too_large');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

export async function createResolverServer(opts: ServerOptions) {
  let snapshot: ContentSnapshot = await opts.source.load();
  const killOverrides = new Map<string, boolean>();
  const deps: ResolverDeps = {
    ...opts.deps,
    content: () =>
      killOverrides.size === 0
        ? snapshot
        : { ...snapshot, registry: snapshot.registry.map((r) => (killOverrides.has(r.type) ? { ...r, killSwitch: killOverrides.get(r.type) as boolean } : r)) },
  };

  const metrics = {
    requests: 0,
    notFound: 0,
    latencies: [] as number[],
    decisions: new Map<string, number>(),
    reloads: 0,
    lastReloadAt: snapshot.loadedAt,
  };
  const events: { name: string; props: Record<string, unknown>; receivedAt: string }[] = [];
  const pushEvent = (name: string, props: Record<string, unknown>) => {
    events.push({ name, props, receivedAt: new Date().toISOString() });
    if (events.length > 500) events.shift();
  };
  const upstreamEmit = deps.emit;
  deps.emit = (name, props) => {
    pushEvent(`server.${name}`, props);
    upstreamEmit?.(name, props);
  };

  const sim = opts.simulator?.enabled ? opts.simulator : null;

  async function reload(): Promise<{ experiences: number; cacheCleared: number }> {
    snapshot = await opts.source.load();
    metrics.reloads++;
    metrics.lastReloadAt = snapshot.loadedAt;
    return { experiences: snapshot.experiences.length, cacheCleared: deps.cache.clear() };
  }

  async function handleHome(url: URL, res: ServerResponse): Promise<void> {
    const q = url.searchParams;
    const platform = (q.get('platform') ?? 'android') as Platform;
    const appVersion = q.get('appVersion') ?? '7.2.0';
    const modality = (q.get('modality') || null) as Modality | null;
    if (!PLATFORMS.includes(platform)) return send(res, 400, { error: 'platform_invalid', allowed: PLATFORMS });
    if (!isSemver(appVersion)) return send(res, 400, { error: 'appVersion_invalid' });
    if (modality && !MODALITIES.includes(modality)) return send(res, 400, { error: 'modality_invalid', allowed: MODALITIES });

    const request: ResolveRequest = {
      storeId: q.get('storeId') || null,
      modality,
      platform,
      appVersion,
      customerId: q.get('customerId') || null,
    };
    // Simular otra fecha solo en simulador (p. ej. ver la campaña de Buen Fin antes de que inicie).
    const at = q.get('at');
    if (sim && at && !Number.isNaN(Date.parse(at))) request.now = new Date(at);

    if (sim) {
      sim.faults.failing = new Set((q.get('fail') ?? '').split(',').filter(Boolean) as ConnectorName[]);
    }

    const t0 = performance.now();
    const response = await resolveHome(request, deps, { debug: q.get('debug') === '1' });
    const ms = performance.now() - t0;
    metrics.requests++;
    metrics.latencies.push(ms);
    if (metrics.latencies.length > 2000) metrics.latencies.shift();
    if (!response) {
      metrics.notFound++;
      return send(res, 503, { error: 'no_experience', message: 'No hay experiencia base publicada. La app debe usar caché o Home embebida.' });
    }
    for (const d of response.diagnostics?.modules ?? []) {
      const k = `${d.outcome}:${d.reason}`;
      metrics.decisions.set(k, (metrics.decisions.get(k) ?? 0) + 1);
    }
    send(res, 200, response, {
      'cache-control': `public, max-age=${response.ttlSeconds}`,
      'x-experience-version': response.tracking.experienceVersion,
      'server-timing': `resolve;dur=${ms.toFixed(1)}`,
    });
  }

  async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    if (!sim) return send(res, 404, { error: 'not_found' });
    const rel = normalize(pathname.replace(/^\/preview\/?/, '') || 'index.html');
    if (rel.startsWith('..')) return send(res, 400, { error: 'bad_path' });
    try {
      const body = await readFile(join(sim.previewDir, rel));
      res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch {
      send(res, 404, { error: 'not_found' });
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'content-type' });
        return res.end();
      }
      if (route === 'GET /health') return send(res, 200, { ok: true, source: snapshot.source, loadedAt: snapshot.loadedAt });
      if (route === 'GET /v1/home') return await handleHome(url, res);

      if (route === 'POST /v1/webhooks/strapi') {
        const secret = String(req.headers['x-webhook-secret'] ?? '');
        if (!opts.webhookSecret || !safeEqual(secret, opts.webhookSecret)) return send(res, 401, { error: 'unauthorized' });
        const body = (await readBody(req)) as { event?: string; model?: string };
        const t0 = performance.now();
        const result = await reload();
        pushEvent('server.content_reloaded', { trigger: body.event ?? 'webhook', model: body.model ?? null, ms: Math.round(performance.now() - t0) });
        return send(res, 200, { ok: true, ...result });
      }

      if (route === 'POST /v1/events') {
        const body = (await readBody(req)) as { events?: { name: string; props: Record<string, unknown> }[] };
        const list = Array.isArray(body.events) ? body.events.slice(0, 100) : [];
        list.forEach((e) => typeof e?.name === 'string' && pushEvent(e.name, e.props ?? {}));
        return send(res, 202, { accepted: list.length });
      }

      if (route === 'GET /v1/metrics') {
        return send(res, 200, {
          requests: metrics.requests,
          noExperience: metrics.notFound,
          latencyMs: { p50: +percentile(metrics.latencies, 50).toFixed(1), p95: +percentile(metrics.latencies, 95).toFixed(1) },
          cache: { entries: deps.cache.size, hits: deps.cache.hits, misses: deps.cache.misses },
          decisions: Object.fromEntries([...metrics.decisions.entries()].sort((a, b) => b[1] - a[1])),
          content: { source: snapshot.source, loadedAt: metrics.lastReloadAt, reloads: metrics.reloads, experiences: snapshot.experiences.length },
        });
      }

      if (sim) {
        if (route === 'GET /v1/events') return send(res, 200, { events: events.slice(-100).reverse() });
        if (route === 'GET /v1/simulator/options') {
          return send(res, 200, {
            stores: sim.storeFile.stores,
            segments: sim.storeFile.segments,
            customers: sim.customers,
            registry: deps.content().registry,
            experiences: snapshot.experiences.map((e) => ({
              id: e.id,
              name: e.name,
              audience: e.audience.name,
              audienceDescription: e.audience.description,
              priority: e.priority,
              startsAt: e.startsAt ?? null,
              endsAt: e.endsAt ?? null,
              isFallback: e.isFallback,
              stores: e.storeScope.map((s) => s.name),
              modules: e.modules.length,
            })),
          });
        }
        if (route === 'POST /v1/simulator/kill-switch') {
          const body = (await readBody(req)) as { type?: string; on?: boolean };
          if (!body.type || !snapshot.registry.some((r) => r.type === body.type)) return send(res, 400, { error: 'unknown_type' });
          killOverrides.set(body.type, Boolean(body.on));
          deps.cache.clear();
          pushEvent('studio.kill_switch_toggled', { type: body.type, on: Boolean(body.on), user_role: 'ds_admin' });
          return send(res, 200, { ok: true, type: body.type, killSwitch: Boolean(body.on) });
        }
        if (route === 'POST /v1/simulator/reload') return send(res, 200, { ok: true, ...(await reload()) });
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(302, { location: '/preview/' });
          return res.end();
        }
        if (req.method === 'GET' && url.pathname.startsWith('/preview')) return await serveStatic(url.pathname, res);
      }

      send(res, 404, { error: 'not_found' });
    } catch (err) {
      const message = (err as Error).message;
      send(res, message === 'payload_too_large' ? 413 : 500, { error: 'internal', message });
    }
  });

  return { server, reload, getSnapshot: () => snapshot };
}
