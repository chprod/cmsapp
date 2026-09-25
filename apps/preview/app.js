/**
 * Simulador de Home. Se comporta como la app:
 *  - pide la Home al Resolver con timeout de 1.5 s;
 *  - si falla, usa la última respuesta válida (≤ 24 h y campaña vigente) o la Home embebida;
 *  - pinta solo tipos que conoce y reporta el resto;
 *  - emite los eventos de §15.
 * Además muestra el porqué de cada decisión (diagnostics del Resolver).
 */
import { RENDERERS, SKELETON_HEIGHT, esc } from './renderers.js';
import { EMBEDDED_HOME } from './embedded-home.js';

const APP_TIMEOUT_MS = 1500;
const CACHE_MAX_AGE_MS = 24 * 3600 * 1000;
const MODALITY = { super_veloz: 'Súper Veloz', pickup: 'Pickup', envio_programado: 'Envío programado' };

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const radio = (name) => document.querySelector(`input[name=${name}]:checked`)?.value;

let options = null;
let current = null;
let loadSeq = 0;
const eventLog = [];
let outbox = [];
let impressionObserver = null;

// ───────────────────────── Storage (tolerante a fallos) ─────────────────────────

const store = {
  get(k) {
    try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin storage: la app sigue */ }
  },
};

// ───────────────────────── Eventos (§15) ─────────────────────────

function emit(name, props) {
  eventLog.unshift({ name, props, at: new Date().toLocaleTimeString('es-MX') });
  eventLog.length = Math.min(eventLog.length, 200);
  outbox.push({ name, props });
  renderEvents();
}

setInterval(() => {
  if (!outbox.length || $('#offline').checked) return;
  const events = outbox.splice(0, 100);
  fetch('/v1/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events }) }).catch(() => {
    outbox = events.concat(outbox);
  });
}, 2000);

function renderEvents() {
  const el = $('#events');
  if (!el || el.hidden) return;
  el.innerHTML = eventLog.length
    ? eventLog.map((e) => `<div class="ev"><b>${esc(e.name)}</b> <small>${esc(e.at)}</small><br>${esc(JSON.stringify(e.props))}</div>`).join('')
    : '<p class="empty">Todavía no hay eventos. Desplázate por la Home o toca un módulo.</p>';
}

// ───────────────────────── Contexto ─────────────────────────

function context() {
  const atValue = $('#at').value;
  const now = atValue ? new Date(atValue) : new Date();
  return {
    customerId: $('#customer').value || null,
    storeId: $('#store').value || null,
    modality: radio('modality'),
    platform: radio('platform'),
    appVersion: $('#appVersion').value,
    now,
    fail: $$('[data-fail]:checked').map((i) => i.dataset.fail),
    resolverDown: $('#resolverDown').checked,
    offline: $('#offline').checked,
  };
}

const cacheKey = (c) => `home:${c.customerId}|${c.storeId}|${c.modality}|${c.platform}|${c.appVersion}`;

function setLocalDefault() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  $('#at').value = d.toISOString().slice(0, 16);
}

// ───────────────────────── Carga (como la app) ─────────────────────────

async function fetchHome(c) {
  if (c.offline || c.resolverDown) {
    // Simula la espera hasta el timeout sin bloquear la UI de la herramienta.
    await new Promise((r) => setTimeout(r, c.offline ? 150 : 600));
    throw new Error(c.offline ? 'offline' : 'timeout');
  }
  const q = new URLSearchParams({
    platform: c.platform,
    appVersion: c.appVersion,
    debug: '1',
    at: c.now.toISOString(),
  });
  if (c.customerId) q.set('customerId', c.customerId);
  if (c.storeId) q.set('storeId', c.storeId);
  if (c.modality) q.set('modality', c.modality);
  if (c.fail.length) q.set('fail', c.fail.join(','));
  const res = await fetch(`/v1/home?${q}`, { signal: AbortSignal.timeout(APP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.json();
}

function skeleton() {
  $('#feed').innerHTML = ['hero-banner', 'category-rail', 'product-carousel']
    .map((t) => `<div class="m sp-m"><div class="skeleton" style="height:${SKELETON_HEIGHT[t]}px"></div></div>`)
    .join('');
}

async function load() {
  const seq = ++loadSeq;
  const c = context();
  skeleton();
  const t0 = performance.now();
  let response;
  let source;
  let savedAt = null;
  let failure = null;
  try {
    response = await fetchHome(c);
    source = 'network';
    store.set(cacheKey(c), { response: stripDebug(response), savedAt: Date.now() });
  } catch (err) {
    failure = err.message;
    const cached = store.get(cacheKey(c));
    const fresh = cached && Date.now() - cached.savedAt < CACHE_MAX_AGE_MS;
    const endsAt = cached?.response?.experience?.endsAt;
    const stillValid = !endsAt || Date.parse(endsAt) > c.now.getTime();
    if (fresh && stillValid) {
      response = cached.response;
      source = 'cache';
      savedAt = cached.savedAt;
    } else {
      response = EMBEDDED_HOME;
      source = 'embedded';
    }
  }
  if (seq !== loadSeq) return; // hubo otra carga más reciente
  const latency = Math.round(performance.now() - t0);
  current = { response, source, context: c, savedAt, failure };
  render(current);
  emit('home_experience_loaded', {
    experience_version: response.tracking.experienceVersion,
    source,
    latency_ms: latency,
    store_id: response.experience.resolvedFor?.storeId ?? c.storeId,
    modality: response.experience.resolvedFor?.modality ?? c.modality,
    app_version: c.appVersion,
  });
  renderSource(source, latency, response, savedAt, failure);
}

function stripDebug(r) {
  const { diagnostics, ...rest } = r;
  return rest;
}

// ───────────────────────── Render ─────────────────────────

function render({ response, context: c, source }) {
  const app = $('#app');
  app.style.setProperty('--font-scale', radio('fontScale'));
  $('#phone').style.setProperty('--w', `${radio('width')}px`);
  $('#offlineBanner').hidden = !c.offline;

  const rf = response.experience.resolvedFor ?? {};
  const storeObj = options.stores.find((s) => s.id === (rf.storeId ?? c.storeId));
  const mod = rf.modality ?? c.modality;
  $('#where').innerHTML = storeObj
    ? `${esc(MODALITY[mod] ?? '')} · <b>${esc(storeObj.name)}</b> ▾`
    : '<b>Elige tu tienda</b> para ver precios reales ▾';

  const toast = $('#toast');
  if (rf.modalityAdjusted && storeObj) {
    toast.textContent = `${MODALITY[rf.requestedModality]} no está disponible en ${storeObj.name}. Te mostramos ${MODALITY[rf.modality]}.`;
    toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (toast.hidden = true), 6000);
  } else {
    toast.hidden = true;
  }

  const ctx = { offline: c.offline || source !== 'network', now: c.now.getTime() };
  const html = [];
  for (const m of response.modules) {
    const r = RENDERERS[m.type];
    if (!r) {
      emit('module_unsupported', { type: m.type, version: m.version, app_version: c.appVersion });
      continue;
    }
    try {
      html.push(r(m, ctx));
    } catch (err) {
      emit('module_render_error', { type: m.type, version: m.version, error_code: err.message });
    }
  }
  const feed = $('#feed');
  feed.innerHTML = html.join('') || '<p class="empty" style="padding:24px">No hay módulos para mostrar.</p>';
  feed.scrollTop = 0;
  observeImpressions(response);
  renderWhy();
  $('#json').textContent = JSON.stringify(response, null, 2);
}

function observeImpressions(response) {
  impressionObserver?.disconnect();
  const seen = new Set();
  const positions = new Map(response.modules.map((m, i) => [m.moduleKey, i + 1]));
  impressionObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const key = e.target.dataset.moduleKey;
        if (!e.isIntersecting || seen.has(key)) continue;
        seen.add(key);
        const m = response.modules.find((x) => x.moduleKey === key);
        emit('module_impression', {
          module_key: key,
          type: m?.type,
          version: m?.version,
          position: positions.get(key),
          experience_version: response.tracking.experienceVersion,
          audience: response.experience.audience,
        });
      }
    },
    { root: $('#feed'), threshold: 0.5 },
  );
  $$('#feed [data-module-key]').forEach((el) => impressionObserver.observe(el));
}

function renderSource(source, latency, response, savedAt, failure) {
  const v = response.tracking.experienceVersion;
  const txt = {
    network: `<b>Red</b> · ${latency} ms · ${esc(v)} · TTL ${response.ttlSeconds} s`,
    cache: `<b>Caché</b> · guardada hace ${Math.max(1, Math.round((Date.now() - savedAt) / 60000))} min · ${esc(v)} · motivo: ${esc(failure)}`,
    embedded: `<b>Home embebida</b> · sin red ni caché válida · motivo: ${esc(failure)}`,
  }[source];
  $('#source').innerHTML = txt;
}

function icon(outcome) {
  return { shown: '<span class="i-shown" aria-label="Se muestra">●</span>', hidden: '<span class="i-hidden" aria-label="Oculto">○</span>', replaced: '<span class="i-replaced" aria-label="Reemplazado">◐</span>' }[outcome] ?? '·';
}

function renderWhy() {
  const el = $('#why');
  if (!current) return;
  const { response, source } = current;
  const d = response.diagnostics;
  if (source !== 'network' || !d) {
    el.innerHTML = `<div class="exp"><h3>${source === 'cache' ? 'Se muestra la última Home guardada' : 'Se muestra la Home embebida'}</h3>
      <p>${source === 'cache'
        ? 'El Resolver no respondió a tiempo. La app usa la última respuesta válida (máx. 24 h) y respeta la fecha de fin de la campaña.'
        : 'No hay red ni una respuesta guardada válida. La app pinta la Home que viaja dentro del binario: sin precios ni productos que puedan estar desactualizados.'}</p></div>`;
    return;
  }
  const exp = options.experiences.find((e) => e.id === response.experience.id);
  el.innerHTML = `
    <div class="exp">
      <h3>${esc(d.selected.name)}</h3>
      <p>${esc(d.selected.reason)}</p>
      ${exp ? `<p>Audiencia: ${esc(exp.audienceDescription)}</p>` : ''}
    </div>
    <div class="sec">Módulos</div>
    <ul class="dlist">${d.modules
      .map((m) => `<li data-key="${esc(m.moduleKey)}">${icon(m.outcome)}<div><span class="k">${esc(m.moduleKey)}</span> <small>${esc(m.type)}</small><span class="e">${esc(m.explanation)}</span></div></li>`)
      .join('')}</ul>
    <div class="sec">Otras experiencias</div>
    <ul class="dlist">${d.candidates
      .filter((c) => c.id !== d.selected.id)
      .map((c) => `<li>${c.eligible ? '<span class="i-replaced" aria-label="Aplica pero pierde">◐</span>' : '<span class="i-no" aria-label="No aplica">○</span>'}<div><span class="k">${esc(c.name)}</span> <small>prioridad ${c.priority}</small><span class="e">${esc(c.eligible ? `Aplica, pero tiene menor prioridad. ${c.reason}` : c.reason)}</span></div></li>`)
      .join('')}</ul>
    <div class="sec">Resolver</div>
    <p class="empty">${d.latencyMs} ms · caché de segmento: ${d.cache === 'hit' ? 'sí' : 'no'}${d.events.length ? ` · ${d.events.length} evento(s) de servidor` : ''}</p>`;

  $$('#why [data-key]').forEach((li) => {
    const target = () => document.querySelector(`#feed [data-module-key="${CSS.escape(li.dataset.key)}"]`);
    li.addEventListener('mouseenter', () => {
      const t = target();
      if (!t) return;
      t.setAttribute('data-flash', '');
      t.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    li.addEventListener('mouseleave', () => target()?.removeAttribute('data-flash'));
  });
}

// ───────────────────────── Interacción en la Home ─────────────────────────

$('#feed').addEventListener('click', (e) => {
  const moduleEl = e.target.closest('[data-module-key]');
  if (!moduleEl || !current) return;
  e.preventDefault();
  const exp = current.response.tracking.experienceVersion;
  const add = e.target.closest('[data-add]');
  if (add) {
    emit('add_to_cart', { sku: add.dataset.add, source_module_key: moduleEl.dataset.moduleKey, experience_version: exp });
    add.textContent = 'Agregado ✓';
    return;
  }
  const target = e.target.closest('[data-target]');
  if (!target) return;
  const m = current.response.modules.find((x) => x.moduleKey === moduleEl.dataset.moduleKey);
  emit('module_click', {
    module_key: m?.moduleKey,
    type: m?.type,
    version: m?.version,
    position: current.response.modules.indexOf(m) + 1,
    experience_version: exp,
    audience: current.response.experience.audience,
    target: target.dataset.sku ?? target.dataset.target,
  });
});

// ───────────────────────── Controles ─────────────────────────

async function init() {
  options = await (await fetch('/v1/simulator/options')).json();
  $('#customer').innerHTML =
    '<option value="">Sin sesión · primera visita</option>' +
    options.customers.map((c) => `<option value="${esc(c.id)}">${esc(c.persona ?? c.id)}</option>`).join('');
  $('#customer').value = 'c_recurrente';
  $('#store').innerHTML =
    '<option value="">Sin tienda elegida</option>' +
    options.stores
      .map((s) => `<option value="${esc(s.id)}">${esc(s.name)} · ${esc(s.city)}${s.modalities.includes('super_veloz') ? '' : ' (sin Súper Veloz)'}</option>`)
      .join('');
  $('#store').value = '0231';
  renderKillSwitches();
  setLocalDefault();

  document.querySelectorAll('.controls input, .controls select').forEach((el) => {
    if (el.closest('#killSwitches')) return;
    el.addEventListener('change', load);
  });
  $$('.chip').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.at === 'now') setLocalDefault();
      else $('#at').value = b.dataset.at;
      load();
    }),
  );
  $('#where').addEventListener('click', () => $('#store').focus());
  $$('.tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      $$('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      $$('.tabpanel').forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.tab));
      renderEvents();
    }),
  );

  const health = await (await fetch('/health')).json();
  $('#status').textContent = `Contenido: ${health.source === 'strapi' ? 'Strapi' : 'fixtures locales'} · ${options.experiences.length} experiencias publicadas`;
  await load();
}

function renderKillSwitches() {
  $('#killSwitches').innerHTML = options.registry
    .map((r) => `<label class="ks"><code>${esc(r.type)}</code><input type="checkbox" data-ks="${esc(r.type)}" ${r.killSwitch ? 'checked' : ''} aria-label="Apagar ${esc(r.type)}" /></label>`)
    .join('');
  $$('[data-ks]').forEach((el) =>
    el.addEventListener('change', async () => {
      await fetch('/v1/simulator/kill-switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: el.dataset.ks, on: el.checked }),
      });
      load();
    }),
  );
}

init().catch((err) => {
  $('#status').textContent = `No se pudo iniciar el simulador: ${err.message}`;
});
