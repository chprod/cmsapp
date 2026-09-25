import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DEFAULT_REGISTRY, type HomeResponse, type ResolveRequest } from '@chedraui-xp/contract';
import { createFixtureConnectors, type FaultInjection } from '../src/connectors/fixtures.ts';
import { FileContentSource, type ContentSnapshot } from '../src/content/source.ts';
import { TtlCache } from '../src/engine/cache.ts';
import { resolveHome, resolveModality, type ResolverDeps } from '../src/engine/resolve.ts';
import { createResolverServer } from '../src/server.ts';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');
const snapshot = await new FileContentSource(fixtures).load();

function setup(mutate?: (s: ContentSnapshot) => void, faults: FaultInjection = {}) {
  const content = structuredClone(snapshot);
  mutate?.(content);
  const { connectors } = createFixtureConnectors(fixtures, () => faults);
  const deps: ResolverDeps = { connectors, content: () => content, cache: new TtlCache(60_000) };
  return { deps, content };
}

const req = (over: Partial<ResolveRequest> = {}): ResolveRequest => ({
  storeId: '0231',
  modality: 'super_veloz',
  platform: 'android',
  appVersion: '7.3.0',
  customerId: 'c_recurrente',
  now: new Date('2026-09-25T12:00:00-06:00'),
  ...over,
});

const keys = (r: HomeResponse | null) => r?.modules.map((m) => m.moduleKey) ?? [];
const decision = (r: HomeResponse | null, key: string) => r?.diagnostics?.modules.find((d) => d.moduleKey === key);

// ───────────── Selección de experiencia ─────────────

test('recurrente en CDMX durante la campaña recibe la campaña (mayor prioridad)', async () => {
  const { deps } = setup();
  const r = await resolveHome(req(), deps);
  assert.equal(r?.experience.id, 'exp_camp_fyv_cdmx');
  assert.equal(r?.tracking.experienceVersion, 'exp_camp_fyv_cdmx@2');
});

test('fuera de CDMX, el recurrente recibe su Home de recurrente', async () => {
  const { deps } = setup();
  const r = await resolveHome(req({ storeId: '0107' }), deps);
  assert.equal(r?.experience.id, 'exp_home_recurrentes');
});

test('HU-01 · la campaña entra en startsAt y sale sola en endsAt', async () => {
  const { deps } = setup();
  const before = await resolveHome(req({ now: new Date('2026-09-19T12:00:00-06:00') }), deps);
  const during = await resolveHome(req({ now: new Date('2026-09-20T06:00:00-06:00') }), deps);
  const after = await resolveHome(req({ now: new Date('2026-10-06T00:00:00-06:00') }), deps);
  assert.equal(before?.experience.id, 'exp_home_recurrentes');
  assert.equal(during?.experience.id, 'exp_camp_fyv_cdmx');
  assert.equal(after?.experience.id, 'exp_home_recurrentes');
});

test('HU-01 · el TTL nunca sobrevive al fin de la campaña', async () => {
  const { deps } = setup();
  const r = await resolveHome(req({ now: new Date('2026-10-05T23:58:00-06:00') }), deps);
  assert.equal(r?.experience.endsAt, '2026-10-05T23:59:59-06:00');
  assert.ok(r!.ttlSeconds <= 119, `ttl ${r?.ttlSeconds}`);
});

test('cliente anónimo sin tienda: Home de nuevo cliente + selector de tienda arriba', async () => {
  const { deps } = setup();
  const r = await resolveHome(req({ customerId: null, storeId: null, modality: null }), deps);
  assert.equal(r?.experience.id, 'exp_home_nuevos');
  assert.equal(r?.modules[0]?.type, 'store-selector');
});

test('si ninguna experiencia aplica, se usa la base nacional', async () => {
  const { deps } = setup();
  // "en riesgo": 64 días sin comprar → no es recurrente ni nuevo
  const r = await resolveHome(req({ customerId: 'c_dormido', storeId: '0107' }), deps);
  assert.equal(r?.experience.id, 'exp_home_base');
});

test('sin experiencia base publicada: null (la app usa caché o Home embebida)', async () => {
  const { deps } = setup((s) => {
    s.experiences = s.experiences.filter((e) => !e.isFallback);
  });
  assert.equal(await resolveHome(req({ customerId: 'c_dormido', storeId: '0107' }), deps), null);
});

test('empate de prioridad: gana la publicada más recientemente', async () => {
  const { deps } = setup((s) => {
    const rec = s.experiences.find((e) => e.id === 'exp_home_recurrentes')!;
    s.experiences.push({ ...structuredClone(rec), id: 'exp_rec_nueva', publishedAt: '2026-09-24T00:00:00Z' });
  });
  const r = await resolveHome(req({ storeId: '0107' }), deps, { debug: true });
  assert.equal(r?.experience.id, 'exp_rec_nueva');
  assert.match(r!.diagnostics!.selected.reason, /empate/);
});

// ───────────── Tienda y modalidad ─────────────

test('tienda sin Súper Veloz: se resuelve con otra modalidad y se avisa', async () => {
  const { deps } = setup();
  const r = await resolveHome(req({ storeId: '0412' }), deps);
  assert.equal(r?.experience.resolvedFor.modality, 'pickup');
  assert.equal(r?.experience.resolvedFor.modalityAdjusted, true);
  assert.equal(r?.experience.resolvedFor.requestedModality, 'super_veloz');
});

test('resolveModality usa la preferida del cliente si no se pide una', () => {
  const store = { id: 's', name: 's', city: '', zone: '', modalities: ['pickup', 'envio_programado'] as const };
  assert.deepEqual(resolveModality({ ...store, modalities: [...store.modalities] }, null, 'envio_programado'), { modality: 'envio_programado', adjusted: false });
});

// ───────────── Módulos ─────────────

test('HU-02 · app vieja: promo-mechanic se reemplaza por product-carousel, sin huecos', async () => {
  const { deps } = setup();
  const r = await resolveHome(req({ appVersion: '7.1.0' }), deps, { debug: true });
  const m = r?.modules.find((x) => x.moduleKey === 'ofertas_despensa');
  assert.equal(m?.type, 'product-carousel');
  assert.equal(decision(r, 'ofertas_despensa')?.outcome, 'replaced');
  assert.ok(r?.diagnostics?.events.some((e) => e.name === 'fallback_applied'));
});

test('HU-02 · static_image: loyalty en app vieja muestra la imagen de respaldo', async () => {
  const { deps } = setup((s) => {
    s.registry = s.registry.map((e) => (e.type === 'loyalty' ? { ...e, minAppVersionAndroid: '8.0.0' } : e));
  });
  const r = await resolveHome(req({ customerId: 'c_dormido', storeId: '0107' }), deps);
  const m = r?.modules.find((x) => x.moduleKey === 'lealtad');
  assert.equal(m?.type, 'static-image');
});

test('HU-02 · patrocinado sin reemplazo posible se oculta (nunca publicidad sin etiqueta)', async () => {
  const { deps } = setup((s) => {
    s.registry = s.registry.map((e) =>
      e.type === 'sponsored-carousel' ? { ...e, minAppVersionAndroid: '9.0.0', fallbackBehavior: 'replace_with', replaceWith: 'product-carousel' } : e,
    );
  });
  const r = await resolveHome(req({ storeId: '0107' }), deps, { debug: true });
  assert.ok(!keys(r).includes('patrocinado_bebidas'));
  assert.equal(decision(r, 'patrocinado_bebidas')?.reason, 'app_version_unsupported');
});

test('patrocinado conserva la etiqueta fija "Patrocinado"', async () => {
  const { deps } = setup();
  const r = await resolveHome(req({ storeId: '0107' }), deps);
  const m = r?.modules.find((x) => x.type === 'sponsored-carousel');
  assert.equal(m?.props.sponsoredLabel, 'Patrocinado');
});

test('HU-03 · R7: carrusel con menos de minAvailableItems disponibles no se pinta', async () => {
  const { deps } = setup((s) => {
    // Colección con 8 SKUs de FyV; en Xalapa 4 no están disponibles → subimos el mínimo a 5.
    s.registry = s.registry.map((e) => (e.type === 'product-carousel' ? { ...e, minAvailableItems: 5 } : e));
    const base = s.experiences.find((e) => e.isFallback)!;
    base.modules.splice(2, 1, { type: 'product-carousel', moduleKey: 'fyv', spacingTop: 'l', props: { title: 'FyV', source: 'collection', collectionId: 'fyv-temporada' } });
  });
  const r = await resolveHome(req({ customerId: 'c_dormido', storeId: '0412', modality: 'pickup' }), deps, { debug: true });
  assert.ok(!keys(r).includes('fyv'));
  assert.equal(decision(r, 'fyv')?.reason, 'min_available_items');
});

test('HU-03 · nunca se muestra un producto no disponible en la tienda y modalidad', async () => {
  const { deps } = setup();
  const r = await resolveHome(req({ storeId: '0107', modality: 'super_veloz' }), deps);
  for (const m of r!.modules) {
    for (const i of (m.props.items as { available: boolean; sku: string }[] | undefined) ?? []) {
      assert.equal(i.available, true, `${m.moduleKey}: ${i.sku}`);
    }
  }
  // Cerveza en Mérida solo pickup → no aparece en Súper Veloz
  const skus = r!.modules.flatMap((m) => ((m.props.items as { sku: string }[]) ?? []).map((i) => i.sku));
  assert.ok(!skus.includes('7502223770016'));
});

test('HU-03 · R8: un SKU no se repite entre carruseles (gana el de arriba)', async () => {
  const { deps } = setup();
  const r = await resolveHome(req(), deps);
  const all = r!.modules.flatMap((m) => ((m.props.items as { sku: string }[]) ?? []).map((i) => i.sku));
  assert.equal(new Set(all).size, all.length);
});

test('buy-again, order-status y listas no aparecen para cliente nuevo (sin huecos)', async () => {
  const { deps } = setup((s) => {
    // Forzamos que el nuevo vea la Home de recurrente para probar las reglas por tipo.
    s.experiences.find((e) => e.id === 'exp_home_recurrentes')!.audience.rule = { match: 'all', conditions: [] };
  });
  const r = await resolveHome(req({ customerId: 'c_nueva', storeId: '0107' }), deps, { debug: true });
  assert.equal(r?.experience.id, 'exp_home_recurrentes');
  for (const k of ['estado_pedido', 'volver_a_comprar', 'mis_listas']) assert.ok(!keys(r).includes(k), k);
  assert.equal(decision(r, 'volver_a_comprar')?.reason, 'no_orders');
  assert.equal(r?.modules[0]?.spacingTop, 'none', 'el primer módulo visible no hereda espacio superior');
});

test('regla de visibilidad por módulo', async () => {
  const { deps } = setup();
  const r = await resolveHome(req({ customerId: 'c_nueva' }), deps, { debug: true });
  assert.equal(r?.experience.id, 'exp_camp_fyv_cdmx');
  assert.equal(decision(r, 'volver_a_comprar')?.reason, 'visibility_rule');
  assert.match(decision(r, 'volver_a_comprar')!.explanation, /Clientes con pedidos/);
});

test('kill switch oculta el tipo en todas las experiencias al instante', async () => {
  const { deps } = setup((s) => {
    s.registry = s.registry.map((e) => (e.type === 'category-rail' ? { ...e, killSwitch: true } : e));
  });
  for (const r of [await resolveHome(req(), deps), await resolveHome(req({ storeId: '0107' }), deps)]) {
    assert.ok(!r!.modules.some((m) => m.type === 'category-rail'));
  }
});

test('conector caído: se oculta solo ese módulo y se emite module_data_error', async () => {
  const { deps } = setup(undefined, { failing: new Set(['recommendations']) });
  const r = await resolveHome(req({ storeId: '0107' }), deps, { debug: true });
  assert.equal(decision(r, 'para_ti')?.reason, 'data_error');
  assert.ok(keys(r).includes('volver_a_comprar'));
  assert.ok(r?.diagnostics?.events.some((e) => e.name === 'module_data_error'));
});

test('conector lento: timeout por conector, la Home responde igual', async () => {
  const { deps } = setup(undefined, { latencyMs: { recommendations: 200 } });
  deps.connectorTimeoutMs = 50;
  const r = await resolveHome(req({ storeId: '0107' }), deps, { debug: true });
  assert.match(decision(r, 'para_ti')!.explanation, /timeout/);
});

test('perfil de cliente caído: se degrada a anónimo, nunca a error', async () => {
  const { deps } = setup(undefined, { failing: new Set(['customers']) });
  const r = await resolveHome(req({ storeId: '0107' }), deps, { debug: true });
  assert.equal(r?.experience.id, 'exp_home_nuevos');
  assert.ok(r?.diagnostics?.events.some((e) => e.name === 'customer_data_error'));
});

test('promo vencida se oculta sola', async () => {
  const { deps } = setup();
  const r = await resolveHome(req({ customerId: 'c_dormido', storeId: '0107', now: new Date('2027-01-02T00:00:00Z') }), deps, { debug: true });
  assert.equal(decision(r, 'promo_despensa')?.reason, 'expired');
});

test('caché por segmento: segunda llamada es hit y no cambia el resultado', async () => {
  const { deps } = setup();
  const a = await resolveHome(req({ customerId: 'c_dormido', storeId: '0107' }), deps, { debug: true });
  const b = await resolveHome(req({ customerId: 'c_dormido', storeId: '0107' }), deps, { debug: true });
  assert.equal(a?.diagnostics?.cache, 'miss');
  assert.equal(b?.diagnostics?.cache, 'hit');
  assert.deepEqual(a?.modules, b?.modules);
});

test('fixtures: todas las experiencias publicadas pasan las validaciones de edición', async () => {
  const { validateExperience, hasBlockingIssues } = await import('@chedraui-xp/contract');
  for (const e of snapshot.experiences) {
    const issues = validateExperience(
      { ...e, audience: e.audience, storeScope: e.storeScope },
      { registry: DEFAULT_REGISTRY, others: snapshot.experiences.filter((o) => o.id !== e.id) },
    );
    assert.equal(hasBlockingIssues(issues), false, `${e.id}: ${JSON.stringify(issues)}`);
  }
});

// ───────────── HTTP ─────────────

test('HTTP · /v1/home, validación de parámetros y webhook con secreto', async () => {
  const { connectors } = createFixtureConnectors(fixtures);
  const { server } = await createResolverServer({
    source: new FileContentSource(fixtures),
    webhookSecret: 's3cret',
    deps: { connectors, cache: new TtlCache(60_000) },
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ok = await fetch(`${base}/v1/home?storeId=0107&customerId=c_recurrente&platform=ios&appVersion=7.3.0`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('cache-control') ?? '', /max-age=\d+/);
    const body = (await ok.json()) as HomeResponse;
    assert.equal(body.contractVersion, '1.0.0');
    assert.equal(body.diagnostics, undefined, 'diagnostics solo con debug=1');

    assert.equal((await fetch(`${base}/v1/home?platform=web`)).status, 400);
    assert.equal((await fetch(`${base}/v1/home?appVersion=siete`)).status, 400);

    assert.equal((await fetch(`${base}/v1/webhooks/strapi`, { method: 'POST', body: '{}' })).status, 401);
    const hook = await fetch(`${base}/v1/webhooks/strapi`, { method: 'POST', headers: { 'x-webhook-secret': 's3cret' }, body: '{"event":"entry.publish"}' });
    assert.equal(hook.status, 200);
    assert.ok(((await hook.json()) as { cacheCleared: number }).cacheCleared >= 1);

    assert.equal((await fetch(`${base}/preview/`)).status, 404, 'simulador apagado por defecto');
  } finally {
    server.close();
  }
});
