'use strict';

/**
 * Avisa al Experience Resolver que el contenido cambió, para que recargue e invalide
 * caché de los segmentos afectados. Objetivo de propagación: < 2 min (§8.3, §14).
 * Si el Resolver no responde, no bloquea al editor: el Resolver también recarga por TTL.
 */
async function notifyResolver(strapi, payload) {
  const url = process.env.RESOLVER_WEBHOOK_URL;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': process.env.RESOLVER_WEBHOOK_SECRET || '' },
      body: JSON.stringify({ ...payload, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) strapi.log.warn(`[studio] Resolver respondió ${res.status} al webhook`);
  } catch (err) {
    strapi.log.warn(`[studio] No se pudo avisar al Resolver: ${err.message}`);
  }
}

module.exports = { notifyResolver };
