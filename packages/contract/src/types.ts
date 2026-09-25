/**
 * Modelo editorial (lo que guarda Strapi, normalizado) y contrato de respuesta
 * del Resolver (lo que consume la app). PRD §6 y §7.
 */
import type { AudienceRule } from './audience.ts';
import type { Modality, ModalityScope, Platform, Spacing } from './tokens.ts';

// ───────────────────────────── Tipos de módulo ─────────────────────────────

export const MODULE_TYPES = [
  'hero-banner',
  'promo-banner',
  'promo-mechanic',
  'product-carousel',
  'buy-again',
  'order-status',
  'shopping-lists',
  'category-rail',
  'loyalty',
  'sponsored-carousel',
] as const;
export type ModuleType = (typeof MODULE_TYPES)[number];

/** Tipos que no son editables pero el Resolver puede emitir como fallback. */
export const SYSTEM_MODULE_TYPES = ['static-image', 'store-selector'] as const;
export type SystemModuleType = (typeof SYSTEM_MODULE_TYPES)[number];

export type AnyModuleType = ModuleType | SystemModuleType;

export interface Image {
  url: string;
  /** Obligatorio (R3). Describe la imagen, no la repite. */
  alt: string;
}

export interface Cta {
  /** ≤ 24 caracteres (R11) */
  label: string;
  /** chedraui://<ruta>/<id> (R10) */
  deeplink: string;
}

export const PROMO_MECHANICS = ['2x1', '3x2', 'segundo_al_%', '%_descuento', 'precio_especial'] as const;
export type PromoMechanicKind = (typeof PROMO_MECHANICS)[number];

export const PRODUCT_SOURCES = ['collection', 'rule', 'recommendation'] as const;
export type ProductSource = (typeof PRODUCT_SOURCES)[number];

/** Props editoriales por tipo (input en Strapi). */
export interface EditorialPropsByType {
  'hero-banner': { image: Image; title: string; subtitle?: string; cta?: Cta };
  'promo-banner': { image: Image; title: string; mechanicLabel?: string; validUntil?: string; cta?: Cta };
  'promo-mechanic': { title: string; mechanic: PromoMechanicKind; mechanicValue?: number; collectionId: string; maxItems?: number };
  'product-carousel': { title: string; source: ProductSource; collectionId?: string; ruleId?: string; recommendationSlot?: string; maxItems?: number; cta?: Cta };
  'buy-again': { title: string; maxItems?: number };
  'order-status': Record<string, never>;
  'shopping-lists': { title: string };
  'category-rail': { title?: string; categoryIds: string[] };
  'loyalty': { memberTitle?: string; nonMemberTitle?: string; cta?: Cta };
  'sponsored-carousel': { title: string; advertiser: string; collectionId: string; maxItems?: number };
}

/** Campos comunes a todo módulo (componente `shared.module-base`). */
export interface ModuleBase {
  /** Estable entre versiones; es la llave en analytics. */
  moduleKey: string;
  /** Regla adicional a la audiencia de la experiencia. */
  visibilityRule?: AudienceRef | null;
  spacingTop: Spacing;
  /** Nombre legible en dashboards. */
  trackingLabel?: string;
  /** Solo se usa si el registro define fallbackBehavior = static_image. */
  fallbackImage?: Image | null;
}

export type EditorialModule = {
  [T in ModuleType]: ModuleBase & { type: T; props: EditorialPropsByType[T] };
}[ModuleType];

// ─────────────────────────── Colecciones de Strapi ───────────────────────────

export interface AudienceRef {
  id: string;
  name: string;
  /** Descripción humana generada de la regla. Lo único que ve el editor. */
  description: string;
  rule: AudienceRule;
  /** Permite usar componentes `beta` (R4). */
  isTestAudience?: boolean;
  estimatedReach?: number | null;
}

export interface StoreSegment {
  id: string;
  name: string;
  zone: string;
  stores: string[];
}

export type ComponentStatus = 'draft' | 'beta' | 'certified' | 'deprecated';
export type FallbackBehavior = 'hide' | 'replace_with' | 'static_image';

export interface RegistryEntry {
  type: ModuleType;
  version: string;
  status: ComponentStatus;
  minAppVersionIOS: string;
  minAppVersionAndroid: string;
  fallbackBehavior: FallbackBehavior;
  /** Solo con fallbackBehavior = replace_with. El tipo destino debe aceptar las mismas props base. */
  replaceWith?: ModuleType | null;
  /** Override de R7 por tipo. */
  minAvailableItems?: number | null;
  tokensUsed: string[];
  owner?: string;
  killSwitch: boolean;
}

export interface Experience {
  id: string;
  /** Se incrementa en cada publicación (lo usa analytics como experience_version). */
  version: number;
  name: string;
  screen: 'home';
  audience: AudienceRef;
  /** Vacío = nacional. */
  storeScope: StoreSegment[];
  modalities: ModalityScope[];
  priority: number;
  modules: EditorialModule[];
  minContractVersion?: string;
  startsAt?: string | null;
  endsAt?: string | null;
  isFallback: boolean;
  notes?: string;
  publishedAt: string;
  updatedAt: string;
}

// ─────────────────────────── Contrato de respuesta ───────────────────────────

export interface Price {
  amount: number;
  currency: 'MXN';
  /** Precio por unidad de medida, ya formateado es-MX. Ej. "$32.50 / L" */
  unitPrice?: string;
  listAmount?: number;
}

export interface ProductItem {
  sku: string;
  name: string;
  image: Image;
  available: boolean;
  price: Price;
  deeplink: string;
  badge?: string;
}

export interface ResolvedModule {
  moduleKey: string;
  type: AnyModuleType;
  version: string;
  spacingTop: Spacing;
  trackingLabel?: string;
  props: Record<string, unknown>;
}

export interface ResolveRequest {
  storeId: string | null;
  modality: Modality | null;
  platform: Platform;
  appVersion: string;
  customerId: string | null;
  /** Solo para preview/QA: simular otra fecha. */
  now?: Date;
}

export interface HomeResponse {
  contractVersion: string;
  experience: {
    id: string;
    version: number;
    audience: string;
    resolvedFor: {
      storeId: string | null;
      modality: Modality | null;
      platform: Platform;
      appVersion: string;
      /** true si la modalidad pedida no existe en la tienda y se resolvió con otra. */
      modalityAdjusted?: boolean;
      requestedModality?: Modality | null;
    };
    /** La app debe respetar endsAt aunque la respuesta venga de caché (§10). */
    endsAt: string | null;
  };
  ttlSeconds: number;
  modules: ResolvedModule[];
  tracking: { experienceVersion: string };
  /** Solo con ?debug=1. Explica cada decisión del Resolver. */
  diagnostics?: Diagnostics;
}

export type DecisionOutcome = 'shown' | 'hidden' | 'replaced';

export interface ModuleDecision {
  moduleKey: string;
  type: string;
  outcome: DecisionOutcome;
  /** Código estable para dashboards. */
  reason: string;
  /** Explicación en español para el editor. */
  explanation: string;
}

export interface Diagnostics {
  candidates: { id: string; name: string; eligible: boolean; reason: string; priority: number }[];
  selected: { id: string; name: string; reason: string };
  modules: ModuleDecision[];
  events: { name: string; props: Record<string, unknown> }[];
  latencyMs: number;
  cache: 'hit' | 'miss';
}
