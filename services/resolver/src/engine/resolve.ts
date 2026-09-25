/**
 * Motor del Experience Resolver.
 *
 * 1. Arma el contexto del cliente (degradando a anónimo si el perfil falla).
 * 2. Resuelve tienda y modalidad (§10: tienda sin Súper Veloz).
 * 3. Elige la experiencia (prioridad, fechas, alcance, audiencia).
 * 4. Por cada módulo aplica, en orden: kill switch → certificación → regla de
 *    visibilidad → versión de app (R9) → elegibilidad por tipo → hidratación con
 *    timeout → disponibilidad → deduplicación (R8) → mínimo de items (R7).
 * 5. Devuelve el contrato §7 y, en modo debug, el porqué de cada decisión.
 */
import {
  CONTRACT_VERSION,
  LIMITS,
  compareSemver,
  evaluateRule,
  type CustomerContext,
  type DecisionOutcome,
  type Diagnostics,
  type EditorialModule,
  type Experience,
  type HomeResponse,
  type Modality,
  type ModuleDecision,
  type ModuleType,
  type ProductItem,
  type RegistryEntry,
  type ResolveRequest,
  type ResolvedModule,
} from '@chedraui-xp/contract';
import type { Connectors, CustomerProfile, Placement, Store } from '../connectors/types.ts';
import type { ContentSnapshot } from '../content/source.ts';
import type { TtlCache } from './cache.ts';
import { nextBoundary, selectExperience } from './select.ts';

export interface ResolverDeps {
  connectors: Connectors;
  content: () => ContentSnapshot;
  cache: TtlCache<unknown>;
  connectorTimeoutMs?: number;
  ttlSeconds?: number;
  /** Eventos del lado servidor (module_data_error, fallback aplicado…). */
  emit?: (name: string, props: Record<string, unknown>) => void;
}

const MODALITY_FALLBACK_ORDER: Modality[] = ['pickup', 'envio_programado', 'super_veloz'];

const MECHANIC_LABELS: Record<string, (v?: number) => string> = {
  '2x1': () => '2x1',
  '3x2': () => '3x2',
  'segundo_al_%': (v) => `2º al ${v ?? 50}%`,
  '%_descuento': (v) => (v ? `-${v}%` : 'Con descuento'),
  precio_especial: () => 'Precio especial',
};

/** Tipos cuyo contenido depende solo de tienda × modalidad (cacheables por segmento). */
function isSegmentCacheable(m: EditorialModule): boolean {
  if (m.type === 'product-carousel') return m.props.source !== 'recommendation';
  return m.type === 'category-rail' || m.type === 'promo-mechanic' || m.type === 'sponsored-carousel';
}

const PRODUCT_TYPES = new Set<string>(['product-carousel', 'buy-again', 'promo-mechanic', 'sponsored-carousel']);

/** Adaptadores para fallbackBehavior = replace_with. Sin adaptador = se oculta. */
const REPLACEMENTS: Partial<Record<ModuleType, Partial<Record<ModuleType, (m: EditorialModule) => EditorialModule>>>> = {
  'promo-mechanic': {
    'product-carousel': (m) => {
      const p = m.props as { title: string; collectionId: string; maxItems?: number };
      return { ...m, type: 'product-carousel', props: { title: p.title, source: 'collection', collectionId: p.collectionId, maxItems: p.maxItems } };
    },
  },
  // sponsored-carousel NO tiene reemplazo: un carrusel sin etiqueta "Patrocinado" sería publicidad no declarada.
};

class Hidden extends Error {
  readonly code: string;
  readonly explanation: string;

  constructor(code: string, explanation: string) {
    super(code);
    this.code = code;
    this.explanation = explanation;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function anonymousContext(req: ResolveRequest): CustomerContext {
  // Sin cuenta = 0 pedidos conocidos: califica como "nuevo cliente".
  return {
    customerId: null,
    orderCount: 0,
    daysSinceLastOrder: null,
    loyaltyMember: false,
    platform: req.platform,
    appVersion: req.appVersion,
    preferredModality: null,
    hasActiveOrder: false,
    shoppingListCount: 0,
  };
}

function toContext(req: ResolveRequest, p: CustomerProfile): CustomerContext {
  return {
    customerId: p.id,
    orderCount: p.orderCount,
    daysSinceLastOrder: p.daysSinceLastOrder,
    loyaltyMember: p.loyaltyMember,
    platform: req.platform,
    appVersion: req.appVersion,
    preferredModality: p.preferredModality,
    hasActiveOrder: Boolean(p.activeOrder),
    shoppingListCount: p.lists.length,
  };
}

export function resolveModality(
  store: Store | null,
  requested: Modality | null,
  preferred: Modality | null,
): { modality: Modality | null; adjusted: boolean } {
  const desired = requested ?? preferred;
  if (!store) return { modality: desired, adjusted: false };
  if (desired && store.modalities.includes(desired)) return { modality: desired, adjusted: false };
  const alt = MODALITY_FALLBACK_ORDER.find((m) => store.modalities.includes(m)) ?? null;
  return { modality: alt, adjusted: Boolean(requested) && alt !== requested };
}

function minAppVersion(entry: RegistryEntry, platform: 'ios' | 'android'): string {
  return platform === 'ios' ? entry.minAppVersionIOS : entry.minAppVersionAndroid;
}

export async function resolveHome(
  req: ResolveRequest,
  deps: ResolverDeps,
  opts: { debug?: boolean } = {},
): Promise<HomeResponse | null> {
  const started = performance.now();
  const now = req.now ?? new Date();
  const timeout = deps.connectorTimeoutMs ?? LIMITS.connectorTimeoutMs;
  const snapshot = deps.content();
  const registry = new Map(snapshot.registry.map((r) => [r.type, r]));
  const serverEvents: Diagnostics['events'] = [];
  const emit = (name: string, props: Record<string, unknown>) => {
    serverEvents.push({ name, props });
    deps.emit?.(name, props);
  };

  // 1 · Cliente
  let profile: CustomerProfile | null = null;
  if (req.customerId) {
    try {
      profile = await withTimeout(deps.connectors.customers.get(req.customerId), timeout, 'customers');
    } catch (err) {
      emit('customer_data_error', { error_code: (err as Error).message });
    }
  }
  const customer = profile ? toContext(req, profile) : anonymousContext(req);

  // 2 · Tienda y modalidad
  const store = req.storeId ? await deps.connectors.stores.get(req.storeId) : null;
  const { modality, adjusted } = resolveModality(store, req.modality, customer.preferredModality);
  const at: Placement = { storeId: store?.id ?? null, modality };

  // 3 · Experiencia
  const selection = selectExperience({ experiences: snapshot.experiences, customer, storeId: at.storeId, modality, now });
  if (!selection) return null;
  const exp = selection.experience;

  // 4 · Módulos
  const decisions: ModuleDecision[] = [];
  const decide = (m: { moduleKey: string; type: string }, outcome: DecisionOutcome, reason: string, explanation: string) =>
    decisions.push({ moduleKey: m.moduleKey, type: m.type, outcome, reason, explanation });

  const shownSkus = new Set<string>();
  const out: ResolvedModule[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;

  if (!at.storeId) {
    out.push({
      moduleKey: 'selector_tienda',
      type: 'store-selector',
      version: '1.0.0',
      spacingTop: 'none',
      props: {
        title: '¿Dónde vas a comprar?',
        subtitle: 'Elige tu tienda para ver precios y disponibilidad reales.',
        cta: { label: 'Elegir tienda', deeplink: 'chedraui://tienda' },
      },
    });
    decide({ moduleKey: 'selector_tienda', type: 'store-selector' }, 'shown', 'no_store', 'El cliente no ha elegido tienda: se agrega el selector arriba.');
  }

  for (const original of exp.modules) {
    let m: EditorialModule = original;
    let entry = registry.get(m.type);
    let outcome: DecisionOutcome = 'shown';
    let replacedNote = '';

    try {
      if (!entry) throw new Hidden('not_registered', 'El componente no está en el registro.');
      if (entry.killSwitch) throw new Hidden('kill_switch', 'DS apagó este componente (kill switch).');
      if (entry.status !== 'certified' && !(entry.status === 'beta' && exp.audience.isTestAudience)) {
        throw new Hidden('not_certified', `El componente está en estado "${entry.status}".`);
      }
      if (m.visibilityRule && !evaluateRule(m.visibilityRule.rule, customer)) {
        throw new Hidden('visibility_rule', `Solo para "${m.visibilityRule.name}" (${m.visibilityRule.description}).`);
      }

      // R9 · versión mínima de app
      const min = minAppVersion(entry, req.platform);
      if (compareSemver(req.appVersion, min) < 0) {
        const note = `La app ${req.appVersion} no soporta ${m.type} (mín. ${min} en ${req.platform}).`;
        emit('fallback_applied', { module_key: m.moduleKey, type: m.type, behavior: entry.fallbackBehavior, app_version: req.appVersion });
        if (entry.fallbackBehavior === 'replace_with' && entry.replaceWith) {
          const target = registry.get(entry.replaceWith);
          const adapt = REPLACEMENTS[m.type]?.[entry.replaceWith];
          const targetOk = target && !target.killSwitch && target.status === 'certified' && compareSemver(req.appVersion, minAppVersion(target, req.platform)) >= 0;
          if (!adapt || !targetOk) throw new Hidden('app_version_unsupported', `${note} No hay reemplazo compatible.`);
          m = adapt(m);
          entry = target;
          outcome = 'replaced';
          replacedNote = `${note} Se reemplazó por ${m.type}.`;
        } else if (entry.fallbackBehavior === 'static_image' && m.fallbackImage?.url) {
          out.push({
            moduleKey: m.moduleKey,
            type: 'static-image',
            version: '1.0.0',
            spacingTop: m.spacingTop,
            trackingLabel: m.trackingLabel,
            props: { image: m.fallbackImage, deeplink: (m.props as { cta?: { deeplink: string } }).cta?.deeplink ?? null },
          });
          decide(m, 'replaced', 'static_image', `${note} Se muestra la imagen de respaldo.`);
          continue;
        } else {
          throw new Hidden('app_version_unsupported', `${note} Se oculta.`);
        }
      }

      // Elegibilidad por tipo
      const props = await hydrate(m, { customer, profile, at, now, deps, timeout, onCache: (hit) => (hit ? cacheHits++ : cacheMisses++) });

      // R7 / R8 · productos
      if (PRODUCT_TYPES.has(m.type)) {
        const all = (props.items as ProductItem[]) ?? [];
        const available = all.filter((i) => i.available);
        const unique = available.filter((i) => !shownSkus.has(i.sku));
        const maxItems = Number((m.props as { maxItems?: number }).maxItems ?? 12);
        const items = unique.slice(0, maxItems);
        const minItems = entry.minAvailableItems ?? LIMITS.minAvailableItems;
        if (items.length < minItems) {
          const dup = available.length - unique.length;
          throw new Hidden(
            'min_available_items',
            `Solo ${items.length} productos disponibles${dup ? ` (${dup} ya aparecen más arriba)` : ''} en ${at.storeId ?? 'ninguna tienda'} / ${at.modality ?? 'sin modalidad'}; se necesitan ${minItems}.`,
          );
        }
        items.forEach((i) => shownSkus.add(i.sku));
        props.items = items;
      }

      out.push({
        moduleKey: m.moduleKey,
        type: m.type,
        version: entry.version,
        spacingTop: out.length === 0 ? 'none' : m.spacingTop,
        ...(m.trackingLabel ? { trackingLabel: m.trackingLabel } : {}),
        props,
      });
      decide(
        { moduleKey: m.moduleKey, type: outcome === 'replaced' ? `${original.type} → ${m.type}` : m.type },
        outcome,
        outcome === 'replaced' ? 'replaced' : 'eligible',
        replacedNote || 'Cumple todas las reglas.',
      );
    } catch (err) {
      if (err instanceof Hidden) {
        decide(original, 'hidden', err.code, err.explanation);
      } else {
        // Conector caído o timeout: el módulo se oculta, el resto se pinta (§10).
        const code = (err as Error).message;
        emit('module_data_error', { module_key: original.moduleKey, type: original.type, error_code: code });
        decide(original, 'hidden', 'data_error', `No se pudieron obtener los datos (${code}).`);
      }
    }
  }

  // 5 · Respuesta
  const boundary = nextBoundary(snapshot.experiences, exp, now);
  const maxTtl = deps.ttlSeconds ?? LIMITS.responseTtlSeconds;
  const ttlSeconds = boundary ? Math.max(30, Math.min(maxTtl, Math.floor((boundary - now.getTime()) / 1000))) : maxTtl;

  const response: HomeResponse = {
    contractVersion: CONTRACT_VERSION,
    experience: {
      id: exp.id,
      version: exp.version,
      audience: exp.audience.name,
      resolvedFor: {
        storeId: at.storeId,
        modality: at.modality,
        platform: req.platform,
        appVersion: req.appVersion,
        ...(adjusted ? { modalityAdjusted: true, requestedModality: req.modality } : {}),
      },
      endsAt: exp.endsAt ?? null,
    },
    ttlSeconds,
    modules: out,
    tracking: { experienceVersion: `${exp.id}@${exp.version}` },
  };

  if (opts.debug) {
    response.diagnostics = {
      candidates: selection.candidates.map((c) => ({
        id: c.experience.id,
        name: c.experience.name,
        eligible: c.eligible,
        reason: c.reason,
        priority: c.experience.priority,
      })),
      selected: { id: exp.id, name: exp.name, reason: selection.reason },
      modules: decisions,
      events: serverEvents,
      latencyMs: Math.round(performance.now() - started),
      cache: cacheMisses === 0 && cacheHits > 0 ? 'hit' : 'miss',
    };
  }
  return response;
}

interface HydrateCtx {
  customer: CustomerContext;
  profile: CustomerProfile | null;
  at: Placement;
  now: Date;
  deps: ResolverDeps;
  timeout: number;
  onCache: (hit: boolean) => void;
}

async function cached<T>(m: EditorialModule, ctx: HydrateCtx, load: () => Promise<T>): Promise<T> {
  if (!isSegmentCacheable(m)) return load();
  const key = `${m.type}|${JSON.stringify(m.props)}|${ctx.at.storeId}|${ctx.at.modality}`;
  const hit = ctx.deps.cache.get(key) as T | undefined;
  ctx.onCache(hit !== undefined);
  if (hit !== undefined) return structuredClone(hit);
  const value = await load();
  ctx.deps.cache.set(key, structuredClone(value));
  return value;
}

async function hydrate(m: EditorialModule, ctx: HydrateCtx): Promise<Record<string, unknown>> {
  const { connectors } = ctx.deps;
  const t = <T>(p: Promise<T>, label: string) => withTimeout(p, ctx.timeout, label);

  switch (m.type) {
    case 'hero-banner':
      return { ...m.props };

    case 'promo-banner': {
      if (m.props.validUntil && Date.parse(m.props.validUntil) <= ctx.now.getTime()) {
        throw new Hidden('expired', `La promoción venció el ${m.props.validUntil}.`);
      }
      return { ...m.props };
    }

    case 'product-carousel': {
      const p = m.props;
      const items = await cached(m, ctx, () => {
        if (p.source === 'recommendation') return t(connectors.recommendations.slot(p.recommendationSlot ?? '', ctx.customer.customerId, ctx.at), 'recommendations');
        if (p.source === 'collection') return t(connectors.catalog.collection(p.collectionId ?? '', ctx.at), 'catalog');
        return Promise.reject(new Error('rule_source_not_implemented'));
      });
      return { title: p.title, ...(p.cta ? { cta: p.cta } : {}), items };
    }

    case 'promo-mechanic': {
      const p = m.props;
      const items = await cached(m, ctx, () => t(connectors.catalog.collection(p.collectionId, ctx.at), 'catalog'));
      const label = MECHANIC_LABELS[p.mechanic]?.(p.mechanicValue) ?? p.mechanic;
      return { title: p.title, mechanic: p.mechanic, mechanicLabel: label, items };
    }

    case 'sponsored-carousel': {
      const p = m.props;
      const items = await cached(m, ctx, () => t(connectors.catalog.collection(p.collectionId, ctx.at), 'catalog'));
      // La etiqueta es fija: el editor no puede quitarla ni cambiarla.
      return { title: p.title, advertiser: p.advertiser, sponsoredLabel: 'Patrocinado', items };
    }

    case 'buy-again': {
      if (!ctx.profile || ctx.profile.orderCount < 1) throw new Hidden('no_orders', 'Solo para clientes con al menos 1 pedido.');
      const items = await t(connectors.orders.buyAgain(ctx.profile.id, ctx.at), 'orders');
      return { title: m.props.title, items };
    }

    case 'order-status': {
      if (!ctx.profile?.activeOrder) throw new Hidden('no_active_order', 'Solo con un pedido en curso.');
      const o = ctx.profile.activeOrder;
      return { orderId: o.id, status: o.status, title: o.statusLabel, eta: o.eta, cta: { label: 'Ver pedido', deeplink: `chedraui://pedido/${o.id}` } };
    }

    case 'shopping-lists': {
      if (!ctx.profile || ctx.profile.lists.length === 0) throw new Hidden('no_lists', 'Solo si el cliente tiene al menos 1 lista.');
      return { title: m.props.title, lists: ctx.profile.lists.map((l) => ({ ...l, deeplink: `chedraui://lista/${l.id}` })) };
    }

    case 'category-rail': {
      const categories = await cached(m, ctx, () => t(connectors.catalog.categories(m.props.categoryIds), 'catalog'));
      return {
        ...(m.props.title ? { title: m.props.title } : {}),
        categories: categories.map((c) => ({ ...c, deeplink: `chedraui://categoria/${c.id}` })),
      };
    }

    case 'loyalty': {
      const member = Boolean(ctx.profile?.loyaltyMember);
      return member
        ? { variant: 'member', title: m.props.memberTitle ?? 'Tus puntos', points: ctx.profile?.loyaltyPoints ?? 0, cta: { label: 'Ver mis puntos', deeplink: 'chedraui://lealtad' } }
        : { variant: 'non_member', title: m.props.nonMemberTitle ?? 'Gana puntos en cada compra', ...(m.props.cta ? { cta: m.props.cta } : {}) };
    }
  }
}

export type { Experience };
