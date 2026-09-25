/** Límites del sistema (PRD §3.2, §9, §14). Un solo lugar para cambiarlos. */
export const LIMITS = {
  /** R1 */
  maxVisibleModules: 8,
  /** R2 */
  maxSponsoredModules: 1,
  /** R11 */
  maxCtaLength: 24,
  /** R11 */
  maxTitleLength: 40,
  /** R7 · default si el registro no define otro valor por tipo */
  minAvailableItems: 4,
  /** module.category-rail */
  maxCategories: 10,
  /** §7 · caché de la app */
  appCacheMaxAgeHours: 24,
  /** §14 · timeout en app antes de caer a caché */
  appTimeoutMs: 1500,
  /** Timeout por conector dentro del Resolver (propuesta alfa) */
  connectorTimeoutMs: 400,
  /** §7 · ttl que el Resolver sugiere a la app/CDN */
  responseTtlSeconds: 300,
} as const;

/** Versión del contrato de respuesta del Resolver (§7). */
export const CONTRACT_VERSION = '1.0.0';
