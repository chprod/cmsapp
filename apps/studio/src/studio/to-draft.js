'use strict';

/**
 * Traduce documentos de Strapi (y el payload que manda el admin al guardar) a la
 * forma `ExperienceDraft` del contrato, para validar con la MISMA lógica que el Resolver.
 */

const EXPERIENCE = 'api::experience.experience';

const MODULE_POPULATE = {
  'hero-banner': ['image', 'cta'],
  'promo-banner': ['image', 'cta'],
  'promo-mechanic': [],
  'product-carousel': ['cta'],
  'buy-again': [],
  'order-status': [],
  'shopping-lists': [],
  'category-rail': [],
  loyalty: ['cta'],
  'sponsored-carousel': [],
};

/** populate para leer una experiencia completa con el Document Service. */
const EXPERIENCE_POPULATE = {
  audience: true,
  storeScope: true,
  modules: {
    on: Object.fromEntries(
      Object.entries(MODULE_POPULATE).map(([type, fields]) => [
        `module.${type}`,
        { populate: { base: { populate: '*' }, ...Object.fromEntries(fields.map((f) => [f, true])) } },
      ]),
    ),
  },
};

const relId = (v) => (v && typeof v === 'object' ? v.documentId ?? v.id ?? null : v ?? null);

/** Aplica un cambio de relación del admin ({connect, disconnect, set}) sobre el valor actual. */
function applyRelation(current, change, many) {
  if (change === undefined) return current;
  if (change === null) return many ? [] : null;
  if (Array.isArray(change)) return many ? change.map(relId) : relId(change[0]);
  if (typeof change !== 'object') return many ? [change] : change;
  if (change.set) return many ? change.set.map(relId) : relId(change.set[0]);
  if (!many) {
    if (change.connect && change.connect.length) return relId(change.connect[change.connect.length - 1]);
    if (change.disconnect && change.disconnect.length) return null;
    return current;
  }
  const ids = new Set(current || []);
  (change.disconnect || []).forEach((r) => ids.delete(relId(r)));
  (change.connect || []).forEach((r) => ids.add(relId(r)));
  return [...ids];
}

function toModule(raw) {
  const type = String(raw.__component || '').replace(/^module\./, '');
  const base = raw.base || {};
  const props = { ...raw };
  delete props.__component;
  delete props.id;
  delete props.base;
  delete props.imageAlt;
  if ('image' in raw || 'imageAlt' in raw) {
    // Para validar solo importa que haya archivo y texto alternativo (R3).
    props.image = raw.image ? { url: 'media', alt: raw.imageAlt || '' } : null;
  }
  if (typeof raw.categoryIds === 'string') {
    props.categoryIds = raw.categoryIds.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return {
    type,
    moduleKey: base.moduleKey,
    props,
    fallbackImage: base.fallbackImage ? { url: 'media', alt: base.fallbackImageAlt || '' } : null,
  };
}

function modalities(doc) {
  const flags = [
    [doc.modalitySuperVeloz, 'super_veloz'],
    [doc.modalityPickup, 'pickup'],
    [doc.modalityEnvioProgramado, 'envio_programado'],
  ];
  const on = flags.filter(([v]) => v !== false).map(([, m]) => m);
  return on.length === flags.length ? ['todas'] : on;
}

/**
 * @param {object} doc documento completo (populado) o null si es nuevo
 * @param {object} data payload del guardado (puede ser parcial)
 * @param {Map<string, {id: string, isTestAudience?: boolean}>} audiences
 */
function toDraft(doc, data, audiences) {
  const merged = { ...(doc || {}), ...(data || {}) };
  const audienceId = applyRelation(relId(doc && doc.audience), data ? data.audience : undefined, false);
  const storeIds = applyRelation(((doc && doc.storeScope) || []).map(relId), data ? data.storeScope : undefined, true);
  const audience = audienceId ? audiences.get(audienceId) || { id: audienceId } : null;
  return {
    id: merged.documentId,
    name: merged.name,
    screen: merged.screen || 'home',
    audience,
    storeScope: (storeIds || []).map((id) => ({ id })),
    modalities: modalities(merged),
    priority: Number(merged.priority || 0),
    modules: (merged.modules || []).map(toModule),
    startsAt: merged.startsAt || null,
    endsAt: merged.endsAt || null,
    isFallback: Boolean(merged.isFallback),
  };
}

function toRegistryEntry(r) {
  return {
    type: r.type,
    version: r.version,
    status: r.status,
    minAppVersionIOS: r.minAppVersionIOS,
    minAppVersionAndroid: r.minAppVersionAndroid,
    fallbackBehavior: r.fallbackBehavior,
    replaceWith: r.replaceWith ? r.replaceWith.type : null,
    minAvailableItems: r.minAvailableItems,
    tokensUsed: r.tokensUsed || [],
    killSwitch: Boolean(r.killSwitch),
  };
}

module.exports = { EXPERIENCE, EXPERIENCE_POPULATE, toDraft, toRegistryEntry, applyRelation };
