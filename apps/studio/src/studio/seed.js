'use strict';

/**
 * Semilla para entornos locales y para la prueba de usabilidad de Fase 0 (§17, semana 3).
 * Carga, solo si la base está vacía: registro de componentes, audiencias, segmentos y las
 * experiencias de /fixtures/content.json. Las experiencias pasan por las mismas
 * validaciones que usa un editor (si una semilla no es válida, el arranque lo reporta).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const contract = require('@chedraui-xp/contract/dist');

const REGISTRY = 'api::component-registry.component-registry';
const AUDIENCE = 'api::audience.audience';
const SEGMENT = 'api::store-segment.store-segment';
const EXPERIENCE = 'api::experience.experience';

function placeholderSvg(title) {
  const safe = String(title).replace(/[<>&"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600"><rect width="1200" height="600" fill="#FFE8D6"/><circle cx="1020" cy="120" r="220" fill="#E57308" opacity=".25"/><text x="60" y="320" font-family="Arial" font-size="44" fill="#0F1215">${safe}</text></svg>`;
}

async function uploadPlaceholder(strapi, name, alt) {
  const file = path.join(os.tmpdir(), `seed-${Date.now()}-${Math.random().toString(36).slice(2)}.svg`);
  fs.writeFileSync(file, placeholderSvg(alt));
  try {
    const [uploaded] = await strapi.plugin('upload').service('upload').upload({
      data: { fileInfo: { name: `${name}.svg`, alternativeText: alt } },
      files: { filepath: file, originalFilename: `${name}.svg`, mimetype: 'image/svg+xml', size: fs.statSync(file).size },
    });
    return uploaded.id;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

async function toStrapiModule(strapi, m, audienceIds) {
  const { image, cta, categoryIds, ...rest } = m.props || {};
  const out = {
    __component: `module.${m.type}`,
    base: {
      moduleKey: m.moduleKey,
      spacingTop: m.spacingTop || 'm',
      trackingLabel: m.trackingLabel || null,
      ...(m.visibilityRule ? { visibilityRule: audienceIds.get(m.visibilityRule) } : {}),
      ...(m.fallbackImage ? { fallbackImage: await uploadPlaceholder(strapi, `${m.moduleKey}-fallback`, m.fallbackImage.alt), fallbackImageAlt: m.fallbackImage.alt } : {}),
    },
    ...rest,
  };
  if (image) {
    out.image = await uploadPlaceholder(strapi, m.moduleKey, image.alt);
    out.imageAlt = image.alt;
  }
  if (cta) out.cta = cta;
  if (categoryIds) out.categoryIds = categoryIds.join(',');
  return out;
}

async function seed(strapi) {
  if (process.env.SEED_ON_BOOT !== 'true') return;
  const existing = await strapi.documents(REGISTRY).count({});
  if (existing > 0) return;

  const fixtures = path.resolve(strapi.dirs.app.root, '../../fixtures');
  const content = JSON.parse(fs.readFileSync(path.join(fixtures, 'content.json'), 'utf8'));
  const stores = JSON.parse(fs.readFileSync(path.join(fixtures, 'stores.json'), 'utf8'));
  strapi.log.info('[seed] Base vacía: cargando datos de ejemplo…');

  // Registro (primero sin replaceWith; luego se conecta)
  const regIds = new Map();
  for (const r of contract.DEFAULT_REGISTRY) {
    const { replaceWith, owner, ...data } = r;
    // replace_with necesita que el destino exista: se crea con "hide" y se completa abajo.
    const fallbackBehavior = replaceWith ? 'hide' : data.fallbackBehavior;
    const doc = await strapi.documents(REGISTRY).create({ data: { ...data, fallbackBehavior, ownerEmail: 'ds-admin@chedraui.example' } });
    regIds.set(r.type, doc.documentId);
  }
  for (const r of contract.DEFAULT_REGISTRY.filter((x) => x.replaceWith)) {
    await strapi.documents(REGISTRY).update({
      documentId: regIds.get(r.type),
      data: { fallbackBehavior: r.fallbackBehavior, replaceWith: regIds.get(r.replaceWith) },
    });
  }

  const audienceIds = new Map();
  for (const a of content.audiences) {
    const doc = await strapi.documents(AUDIENCE).create({ data: { name: a.name, rule: a.rule, isTestAudience: Boolean(a.isTestAudience) } });
    audienceIds.set(a.id, doc.documentId);
  }

  const segmentIds = new Map();
  for (const s of stores.segments) {
    const supportsSuperVeloz = s.stores.every((id) => stores.stores.find((st) => st.id === id)?.modalities.includes('super_veloz'));
    const doc = await strapi.documents(SEGMENT).create({ data: { name: s.name, zone: s.zone, stores: s.stores, supportsSuperVeloz } });
    segmentIds.set(s.id, doc.documentId);
  }

  for (const e of content.experiences) {
    try {
      const modules = [];
      for (const m of e.modules) modules.push(await toStrapiModule(strapi, m, audienceIds));
      const all = !e.modalities || e.modalities.includes('todas');
      const doc = await strapi.documents(EXPERIENCE).create({
        data: {
          name: e.name,
          slug: e.id,
          screen: 'home',
          audience: audienceIds.get(e.audience),
          storeScope: e.storeScope.map((id) => segmentIds.get(id)),
          modalitySuperVeloz: all || e.modalities.includes('super_veloz'),
          modalityPickup: all || e.modalities.includes('pickup'),
          modalityEnvioProgramado: all || e.modalities.includes('envio_programado'),
          priority: e.priority,
          startsAt: e.startsAt || null,
          endsAt: e.endsAt || null,
          isFallback: Boolean(e.isFallback),
          notes: e.notes || null,
          modules,
        },
      });
      await strapi.documents(EXPERIENCE).publish({ documentId: doc.documentId });
      strapi.log.info(`[seed] Experiencia publicada: ${e.name}`);
    } catch (err) {
      strapi.log.error(`[seed] "${e.name}" no pasó validación: ${err.message}`);
    }
  }
  strapi.log.info('[seed] Listo.');
}

module.exports = { seed };
