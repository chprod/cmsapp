/**
 * Renderers por `type` del contrato. Espejo de lo que hará la app nativa:
 * solo pinta; no decide elegibilidad. Un tipo desconocido no rompe la Home:
 * se omite y se reporta `module_unsupported` (§7).
 */

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const EMOJI = [
  [/plátano/i, '🍌'], [/aguacate/i, '🥑'], [/jitomate/i, '🍅'], [/mango/i, '🥭'], [/limón/i, '🍋'], [/papaya|sandía/i, '🍉'],
  [/cebolla/i, '🧅'], [/leche|yoghurt/i, '🥛'], [/huevo/i, '🥚'], [/pan /i, '🍞'], [/café/i, '☕'], [/papel/i, '🧻'],
  [/frijol|arroz|azúcar/i, '🌾'], [/aceite/i, '🫒'], [/atún/i, '🐟'], [/detergente|jabón/i, '🧼'], [/cerveza/i, '🍺'],
  [/refresco|agua|jugo|té /i, '🥤'], [/queso/i, '🧀'], [/tortilla/i, '🫓'], [/galletas/i, '🍪'], [/pañales/i, '🍼'],
];
const emojiFor = (name) => (EMOJI.find(([re]) => re.test(name)) ?? [null, '🛒'])[1];
const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

function wrap(m, inner, extra = '') {
  return `<section class="m sp-${esc(m.spacingTop)}" data-module-key="${esc(m.moduleKey)}" data-type="${esc(m.type)}" ${extra}>${inner}</section>`;
}

function title(text, cta) {
  if (!text && !cta) return '';
  const link = cta ? `<a href="#" data-target="${esc(cta.deeplink)}">${esc(cta.label)}</a>` : '';
  return `<h2 class="m-title"><span>${esc(text ?? '')}</span>${link}</h2>`;
}

function product(p, ctx) {
  const list = p.price.listAmount ? `<s>${money.format(p.price.listAmount)}</s>` : '';
  return `<article class="product" data-target="${esc(p.deeplink)}" data-sku="${esc(p.sku)}" aria-label="${esc(p.name)}, ${money.format(p.price.amount)}">
    <div class="thumb" style="background:hsl(${hue(p.sku)} 60% 92%)" role="img" aria-label="${esc(p.image?.alt ?? p.name)}">${emojiFor(p.name)}${p.badge ? `<span class="badge">${esc(p.badge)}</span>` : ''}</div>
    <div class="name">${esc(p.name)}</div>
    <div class="price">${money.format(p.price.amount)}${list}</div>
    ${p.price.unitPrice ? `<div class="unit">${esc(p.price.unitPrice)}</div>` : ''}
    ${ctx.offline ? '<div class="maybe">El precio puede cambiar</div>' : ''}
    <button class="add" type="button" data-add="${esc(p.sku)}">Agregar</button>
  </article>`;
}

function products(items, ctx) {
  return `<div class="rail">${items.map((p) => product(p, ctx)).join('')}</div>`;
}

export const RENDERERS = {
  'store-selector': (m) =>
    wrap(m, `<div class="store-selector"><h3>${esc(m.props.title)}</h3><p>${esc(m.props.subtitle)}</p>
      <button class="btn" type="button" data-target="${esc(m.props.cta.deeplink)}">${esc(m.props.cta.label)}</button></div>`),

  'hero-banner': (m) => {
    const p = m.props;
    return wrap(m, `<div class="hero">
      <div class="hero-art" role="img" aria-label="${esc(p.image?.alt)}">🧺</div>
      <div class="hero-body"><h3>${esc(p.title)}</h3>${p.subtitle ? `<p>${esc(p.subtitle)}</p>` : ''}
      ${p.cta ? `<button class="btn" type="button" data-target="${esc(p.cta.deeplink)}">${esc(p.cta.label)}</button>` : ''}</div></div>`);
  },

  'promo-banner': (m, ctx) => {
    const p = m.props;
    // La app respeta la vigencia aunque la respuesta venga de caché.
    if (p.validUntil && Date.parse(p.validUntil) <= ctx.now) return '';
    return wrap(m, `<div class="promo" role="group" aria-label="${esc(p.title)}">
      <div><small>${esc(p.mechanicLabel ?? 'Promoción')}</small><div class="m-title" style="margin:2px 0 0">${esc(p.title)}</div></div>
      ${p.cta ? `<button class="btn secondary" type="button" data-target="${esc(p.cta.deeplink)}">${esc(p.cta.label)}</button>` : ''}</div>`);
  },

  'product-carousel': (m, ctx) => wrap(m, title(m.props.title, m.props.cta) + products(m.props.items, ctx)),

  'promo-mechanic': (m, ctx) =>
    wrap(m, `<h2 class="m-title"><span>${esc(m.props.title)}</span><span class="mechanic">${esc(m.props.mechanicLabel)}</span></h2>` + products(m.props.items, ctx)),

  'sponsored-carousel': (m, ctx) =>
    wrap(m, `<h2 class="m-title"><span>${esc(m.props.title)}</span><span class="sponsored-tag">${esc(m.props.sponsoredLabel)} · ${esc(m.props.advertiser)}</span></h2>` + products(m.props.items, ctx)),

  'buy-again': (m, ctx) => wrap(m, title(m.props.title) + products(m.props.items, ctx)),

  'order-status': (m) => {
    const p = m.props;
    return wrap(m, `<div class="order" role="status"><span class="dot" aria-hidden="true"></span>
      <div><b>${esc(p.title)}</b><span>${esc(p.eta)}</span></div>
      <a href="#" data-target="${esc(p.cta.deeplink)}">${esc(p.cta.label)}</a></div>`);
  },

  'shopping-lists': (m) =>
    wrap(m, title(m.props.title) + `<div class="lists">${m.props.lists
      .map((l) => `<div class="list" data-target="${esc(l.deeplink)}"><b>${esc(l.name)}</b><small>${esc(l.items)} productos</small></div>`)
      .join('')}</div>`),

  'category-rail': (m) =>
    wrap(m, title(m.props.title) + `<div class="cats">${m.props.categories
      .map((c) => `<div class="cat" data-target="${esc(c.deeplink)}"><span aria-hidden="true">${esc(c.emoji ?? '🛒')}</span>${esc(c.name)}</div>`)
      .join('')}</div>`),

  loyalty: (m) => {
    const p = m.props;
    const body = p.variant === 'member'
      ? `<div>${esc(p.title)}</div><div class="pts">${Number(p.points).toLocaleString('es-MX')} puntos</div>`
      : `<div class="m-title" style="margin:0;color:#fff">${esc(p.title)}</div><div>Acumula en súper, gasolina y más.</div>`;
    return wrap(m, `<div class="loyalty">${body}${p.cta ? `<button class="btn" type="button" data-target="${esc(p.cta.deeplink)}">${esc(p.cta.label)}</button>` : ''}</div>`);
  },

  'static-image': (m) =>
    wrap(m, `<div class="static-img" role="img" aria-label="${esc(m.props.image.alt)}" ${m.props.deeplink ? `data-target="${esc(m.props.deeplink)}"` : ''}>Imagen de respaldo: ${esc(m.props.image.alt)}</div>`),
};

/** Altura final aproximada por tipo, para skeletons sin saltos de layout (§10). */
export const SKELETON_HEIGHT = {
  'hero-banner': 250, 'promo-banner': 90, 'product-carousel': 260, 'promo-mechanic': 260, 'sponsored-carousel': 260,
  'buy-again': 260, 'order-status': 80, 'shopping-lists': 100, 'category-rail': 200, loyalty: 130, 'static-image': 110, 'store-selector': 140,
};
