'use strict';

/**
 * Reglas del Studio (PRD §9) aplicadas como middleware del Document Service de Strapi v5.
 * Usan el paquete @chedraui-xp/contract: la misma lógica corre en Strapi y en el Resolver.
 *
 * - Experiencias: R1–R6, R10–R12 al guardar y al publicar. Errores bloquean; advertencias
 *   quedan en `reviewWarnings` para que el aprobador las vea.
 * - Audiencias: la regla se valida y su resumen en español se genera solo.
 * - Registro: coherencia de fallback; el kill switch avisa al Resolver al instante.
 * - Toda publicación o cambio vivo avisa al Resolver para invalidar caché (§8.3).
 */
const { errors } = require('@strapi/utils');
const contract = require('@chedraui-xp/contract/dist');
const { EXPERIENCE, EXPERIENCE_POPULATE, toDraft, toRegistryEntry } = require('./to-draft');
const { notifyResolver } = require('./notify');

const AUDIENCE = 'api::audience.audience';
const REGISTRY = 'api::component-registry.component-registry';
const SEGMENT = 'api::store-segment.store-segment';

function fail(title, issues) {
  const list = issues.map((i) => `• ${i.message}`).join('\n');
  throw new errors.ValidationError(`${title}\n${list}`, {
    // Rutas del contrato (modules[1].props.title) → rutas del formulario de Strapi (modules.1.title).
    errors: issues.map((i) => ({ path: i.path.split(/[.[\]]/).filter((p) => p && p !== 'props'), message: `[${i.rule}] ${i.message}`, name: 'ValidationError' })),
  });
}

async function loadContext(strapi, selfId) {
  const [registryDocs, audienceDocs, others] = await Promise.all([
    strapi.documents(REGISTRY).findMany({ populate: { replaceWith: true }, limit: 100 }),
    strapi.documents(AUDIENCE).findMany({ limit: 500 }),
    strapi.documents(EXPERIENCE).findMany({ status: 'published', populate: { audience: true, storeScope: true }, limit: 500 }),
  ]);
  const audiences = new Map(audienceDocs.map((a) => [a.documentId, { id: a.documentId, isTestAudience: Boolean(a.isTestAudience) }]));
  return {
    audiences,
    registry: registryDocs.map(toRegistryEntry),
    others: others.filter((o) => o.documentId !== selfId).map((o) => toDraft(o, null, audiences)),
  };
}

async function validateExperienceDoc(strapi, documentId, data, { forPublish }) {
  const current = documentId
    ? await strapi.documents(EXPERIENCE).findOne({ documentId, status: 'draft', populate: EXPERIENCE_POPULATE })
    : null;
  const ctx = await loadContext(strapi, documentId);
  const draft = toDraft(current, data, ctx.audiences);
  // R10: aquí solo el formato. "Destino existente" requiere catálogo (VTEX) y entra en Fase 1
  // con contract.validateDeeplinkDestinations().
  const issues = contract.validateExperience(draft, { registry: ctx.registry, others: ctx.others });
  if (forPublish && !draft.audience) {
    issues.push({ rule: 'MOD', severity: 'error', path: 'audience', message: 'Elige una audiencia antes de publicar.' });
  }
  return { draft, issues, registry: ctx.registry };
}

function warningsText(issues) {
  const w = issues.filter((i) => i.severity === 'warning');
  return w.length ? w.map((i) => `[${i.rule}] ${i.message}`).join('\n') : null;
}

function register({ strapi }) {
  strapi.documents.use(async (context, next) => {
    const { uid, action, params } = context;

    // ───────────── Experiencias ─────────────
    if (uid === EXPERIENCE && (action === 'create' || action === 'update')) {
      const { draft, issues, registry } = await validateExperienceDoc(strapi, params.documentId, params.data, { forPublish: false });
      const blocking = issues.filter((i) => i.severity === 'error');
      if (blocking.length) fail('No se puede guardar la experiencia:', blocking);
      params.data = {
        ...params.data,
        minContractVersion: contract.computeMinContractVersion(draft.modules, registry),
        reviewWarnings: warningsText(issues),
      };
      const result = await next();
      strapi.log.info(`[studio] experience_saved ${params.documentId || result?.documentId || ''}`);
      return result;
    }

    if (uid === EXPERIENCE && action === 'publish') {
      const { issues } = await validateExperienceDoc(strapi, params.documentId, null, { forPublish: true });
      const blocking = issues.filter((i) => i.severity === 'error');
      if (blocking.length) fail('No se puede publicar la experiencia:', blocking);
      const current = await strapi.documents(EXPERIENCE).findOne({ documentId: params.documentId, status: 'draft', fields: ['publishedVersion'] });
      await strapi.documents(EXPERIENCE).update({
        documentId: params.documentId,
        data: { publishedVersion: Number(current?.publishedVersion || 0) + 1 },
      });
      const result = await next();
      strapi.log.info(`[studio] experience_published ${params.documentId} v${Number(current?.publishedVersion || 0) + 1}`);
      await notifyResolver(strapi, { event: 'entry.publish', model: 'experience', documentId: params.documentId });
      return result;
    }

    if (uid === EXPERIENCE && (action === 'unpublish' || action === 'delete')) {
      const result = await next();
      await notifyResolver(strapi, { event: `entry.${action}`, model: 'experience', documentId: params.documentId });
      return result;
    }

    // ───────────── Audiencias ─────────────
    if (uid === AUDIENCE && (action === 'create' || action === 'update') && params.data && 'rule' in params.data) {
      let rule = params.data.rule;
      if (typeof rule === 'string') {
        try {
          rule = JSON.parse(rule);
        } catch {
          fail('La regla no es JSON válido:', [{ rule: 'MOD', path: 'rule', message: 'Revisa comas y comillas.' }]);
        }
      }
      const ruleIssues = contract.validateRule(rule);
      if (ruleIssues.length) fail('La regla de audiencia tiene errores:', ruleIssues.map((i) => ({ ...i, rule: 'MOD' })));
      params.data = { ...params.data, rule, ruleSummary: contract.describeRule(rule) };
    }

    // ───────────── Registro de componentes ─────────────
    if (uid === REGISTRY && (action === 'create' || action === 'update') && params.data) {
      const d = params.data;
      const hasReplace = d.replaceWith && (d.replaceWith.connect ? d.replaceWith.connect.length : true);
      if (d.fallbackBehavior === 'replace_with' && !hasReplace && action === 'create') {
        fail('Registro incompleto:', [{ rule: 'MOD', path: 'replaceWith', message: 'Con "replace_with" indica por qué componente se reemplaza.' }]);
      }
    }

    if ([AUDIENCE, REGISTRY, SEGMENT].includes(uid) && ['create', 'update', 'delete'].includes(action)) {
      const before =
        uid === REGISTRY && action === 'update' && params.documentId
          ? await strapi.documents(REGISTRY).findOne({ documentId: params.documentId, fields: ['type', 'killSwitch'] })
          : null;
      const result = await next();
      if (before && params.data && 'killSwitch' in params.data && Boolean(params.data.killSwitch) !== Boolean(before.killSwitch)) {
        strapi.log.warn(`[studio] kill_switch_toggled type=${before.type} on=${Boolean(params.data.killSwitch)}`);
      }
      await notifyResolver(strapi, { event: `entry.${action}`, model: uid.split('.').pop(), documentId: params.documentId || result?.documentId });
      return result;
    }

    return next();
  });
}

module.exports = { register };
