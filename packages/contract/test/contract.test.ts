import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REGISTRY,
  computeMinContractVersion,
  compareSemver,
  deeplinkError,
  describeRule,
  evaluateRule,
  hasBlockingIssues,
  validateDeeplinkDestinations,
  validateExperience,
  validateRule,
  type CustomerContext,
  type DraftModule,
  type ExperienceDraft,
} from '../src/index.ts';

const ctx = (over: Partial<CustomerContext> = {}): CustomerContext => ({
  customerId: 'c1',
  orderCount: 3,
  daysSinceLastOrder: 10,
  loyaltyMember: true,
  platform: 'ios',
  appVersion: '7.2.0',
  preferredModality: 'pickup',
  ...over,
});

let seq = 0;
const hero = (over: Partial<DraftModule> = {}): DraftModule => ({
  type: 'hero-banner',
  moduleKey: `hero_${++seq}`,
  props: {
    image: { url: 'https://cdn/x.webp', alt: 'Frutas' },
    title: 'Frutas a mitad de precio',
    cta: { label: 'Ver ofertas', deeplink: 'chedraui://coleccion/fyv' },
  },
  ...over,
});

const base = (over: Partial<ExperienceDraft> = {}): ExperienceDraft => ({
  id: 'e1',
  name: 'Exp',
  audience: { id: 'aud_todos' },
  storeScope: [],
  modalities: ['todas'],
  priority: 10,
  modules: [hero()],
  ...over,
});

const rules = (issues: { rule: string }[]) => issues.map((i) => i.rule);
const registry = DEFAULT_REGISTRY;

// ───────────── semver ─────────────
test('compareSemver ordena versiones de app', () => {
  assert.equal(compareSemver('7.1.0', '7.3.0'), -1);
  assert.equal(compareSemver('7.10.0', '7.9.9'), 1);
  assert.equal(compareSemver('7.2.0', '7.2.0'), 0);
});

// ───────────── audiencias (HU-05) ─────────────
test('regla vacía = todos los clientes', () => {
  assert.equal(evaluateRule({ match: 'all', conditions: [] }, ctx()), true);
  assert.equal(describeRule({ match: 'all', conditions: [] }), 'Todos los clientes');
});

test('HU-05 · describeRule genera español legible, nunca la expresión', () => {
  const text = describeRule({
    match: 'all',
    conditions: [
      { attribute: 'orderCount', operator: 'eq', value: 0 },
      { attribute: 'loyaltyMember', operator: 'is', value: false },
    ],
  });
  assert.equal(text, 'Clientes sin pedidos y que no son socios del programa de lealtad');
  assert.doesNotMatch(text, /orderCount|=|loyaltyMember/);
});

test('evaluateRule: all / any, enum y semver', () => {
  const rule = {
    match: 'any' as const,
    conditions: [
      { attribute: 'platform' as const, operator: 'in' as const, value: ['android'] },
      { attribute: 'appVersion' as const, operator: 'gte' as const, value: '7.2.0' },
    ],
  };
  assert.equal(evaluateRule(rule, ctx({ platform: 'ios', appVersion: '7.2.0' })), true);
  assert.equal(evaluateRule(rule, ctx({ platform: 'ios', appVersion: '7.1.9' })), false);
  assert.equal(evaluateRule({ ...rule, match: 'all' }, ctx({ platform: 'android', appVersion: '7.3.0' })), true);
});

test('dato desconocido nunca califica (anónimo no entra a "en riesgo")', () => {
  const enRiesgo = { match: 'all' as const, conditions: [{ attribute: 'daysSinceLastOrder' as const, operator: 'gt' as const, value: 45 }] };
  assert.equal(evaluateRule(enRiesgo, ctx({ daysSinceLastOrder: null })), false);
});

test('validateRule rechaza atributos no permitidos y valores mal tipados', () => {
  assert.equal(validateRule({ match: 'all', conditions: [] }).length, 0);
  assert.match(validateRule({ match: 'all', conditions: [{ attribute: 'email', operator: 'eq', value: 'x' }] })[0]!.message, /no permitido/);
  assert.match(validateRule({ match: 'all', conditions: [{ attribute: 'orderCount', operator: 'eq', value: '3' }] })[0]!.message, /número/);
  assert.match(validateRule({ match: 'all', conditions: [{ attribute: 'appVersion', operator: 'gte', value: '7.2' }] })[0]!.message, /versión/);
  assert.equal(validateRule(null).length, 1);
});

// ───────────── deeplinks R10 ─────────────
test('R10 · formato de deeplink', () => {
  assert.equal(deeplinkError('chedraui://coleccion/fyv-temporada'), null);
  assert.equal(deeplinkError('chedraui://lealtad'), null);
  assert.ok(deeplinkError('https://chedraui.com.mx'));
  assert.ok(deeplinkError('chedraui://coleccion'), 'colección sin id');
  assert.ok(deeplinkError('chedraui://inventada/1'));
  assert.ok(deeplinkError(''));
});

test('R10 · destino inexistente (checker asíncrono)', async () => {
  const issues = await validateDeeplinkDestinations(base(), async (l) => l.id !== 'fyv');
  assert.deepEqual(rules(issues), ['R10']);
});

// ───────────── validaciones de edición ─────────────
test('experiencia válida no tiene errores', () => {
  assert.deepEqual(validateExperience(base(), { registry }), []);
});

test('R1 · máximo 8 módulos', () => {
  const modules = Array.from({ length: 9 }, () => hero());
  const issues = validateExperience(base({ modules }), { registry });
  assert.deepEqual(rules(issues), ['R1']);
  assert.match(issues[0]!.message, /quita 1/);
});

test('R2 · patrocinado: máximo 1 y nunca primero', () => {
  const sp = (k: string): DraftModule => ({ type: 'sponsored-carousel', moduleKey: k, props: { title: 'Bebidas', advertiser: 'X', collectionId: 'c' } });
  assert.ok(rules(validateExperience(base({ modules: [sp('a'), hero()] }), { registry })).includes('R2'));
  assert.equal(rules(validateExperience(base({ modules: [hero(), sp('a'), sp('b')] }), { registry })).filter((r) => r === 'R2').length, 1);
  assert.deepEqual(validateExperience(base({ modules: [hero(), sp('a')] }), { registry }), []);
});

test('R3 · imagen sin alt no se guarda', () => {
  const m = hero({ props: { image: { url: 'https://cdn/x.webp', alt: '  ' }, title: 'Hola' } });
  assert.deepEqual(rules(validateExperience(base({ modules: [m] }), { registry })), ['R3']);
});

test('R4 · solo certificados; beta solo con audiencia de prueba', () => {
  const reg = registry.map((r) => (r.type === 'loyalty' ? { ...r, status: 'beta' as const } : r));
  const loyalty: DraftModule = { type: 'loyalty', moduleKey: 'l', props: {} };
  assert.deepEqual(rules(validateExperience(base({ modules: [hero(), loyalty] }), { registry: reg })), ['R4']);
  assert.deepEqual(validateExperience(base({ modules: [hero(), loyalty], audience: { id: 'qa', isTestAudience: true } }), { registry: reg }), []);
  assert.ok(rules(validateExperience(base({ modules: [{ type: 'countdown', moduleKey: 'c' }] }), { registry })).includes('R4'));
});

test('R4 · kill switch activo es advertencia, no bloqueo', () => {
  const reg = registry.map((r) => (r.type === 'hero-banner' ? { ...r, killSwitch: true } : r));
  const issues = validateExperience(base(), { registry: reg });
  assert.equal(issues[0]?.severity, 'warning');
  assert.equal(hasBlockingIssues(issues), false);
});

test('R5 · HU-01: fin ≤ inicio no se guarda y explica por qué', () => {
  const bad = validateExperience(base({ startsAt: '2026-10-05T00:00:00Z', endsAt: '2026-10-01T00:00:00Z' }), { registry });
  assert.deepEqual(rules(bad), ['R5']);
  assert.match(bad[0]!.message, /termina antes de empezar/);
  assert.deepEqual(rules(validateExperience(base({ startsAt: '2026-10-05T00:00:00Z' }), { registry })), ['R5']);
  assert.deepEqual(validateExperience(base({ startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-05T00:00:00Z' }), { registry }), []);
});

test('R6 · misma audiencia, alcance y prioridad en periodo traslapado = advertencia', () => {
  const other = base({ id: 'e2', name: 'Otra', startsAt: '2026-10-03T00:00:00Z', endsAt: '2026-10-10T00:00:00Z' });
  const mine = base({ startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-05T00:00:00Z' });
  const issues = validateExperience(mine, { registry, others: [other] });
  assert.deepEqual(issues.map((i) => [i.rule, i.severity]), [['R6', 'warning']]);
  assert.deepEqual(validateExperience({ ...mine, priority: 11 }, { registry, others: [other] }), []);
  assert.deepEqual(validateExperience({ ...mine, storeScope: [{ id: 'seg_cdmx' }] }, { registry, others: [other] }), []);
  assert.deepEqual(validateExperience({ ...mine, endsAt: '2026-10-03T00:00:00Z' }, { registry, others: [other] }), []);
});

test('R11 · longitudes de título y CTA', () => {
  const m = hero({ props: { image: { url: 'u', alt: 'a' }, title: 'x'.repeat(41), cta: { label: 'y'.repeat(25), deeplink: 'chedraui://lealtad' } } });
  assert.deepEqual(rules(validateExperience(base({ modules: [m] }), { registry })), ['R11', 'R11']);
});

test('R12 · base nacional única, sin fin y sin tiendas', () => {
  const issues = validateExperience(base({ isFallback: true, endsAt: '2026-12-01T00:00:00Z', storeScope: [{ id: 's' }] }), {
    registry,
    others: [base({ id: 'e0', isFallback: true, name: 'Base actual' })],
  });
  assert.deepEqual(rules(issues), ['R12', 'R12', 'R12']);
});

test('MOD · moduleKey único y campos requeridos por fuente', () => {
  const issues = validateExperience(
    base({
      modules: [hero({ moduleKey: 'a' }), hero({ moduleKey: 'a' }), { type: 'product-carousel', moduleKey: 'p', props: { title: 'X', source: 'collection' } }],
    }),
    { registry },
  );
  assert.deepEqual(rules(issues), ['MOD', 'MOD']);
});

test('minContractVersion = máximo de los módulos usados', () => {
  assert.equal(computeMinContractVersion([{ type: 'hero-banner' }, { type: 'product-carousel' }], registry), '1.5.0');
});
