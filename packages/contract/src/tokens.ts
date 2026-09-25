/**
 * Nombres de tokens del DS permitidos en contenido.
 * Los VALORES viven en el repo del DS (Omnicanal + capa Next Gen) y llegan a la app
 * vía Style Dictionary. Strapi solo guarda nombres (PRD §5.3).
 */

/** Escala de espaciado vertical entre módulos (8/16/24). Reemplaza Spacer/Divider. */
export const SPACING_PX = { none: 0, s: 8, m: 16, l: 24 } as const;
export type Spacing = keyof typeof SPACING_PX;
export const SPACING_NAMES = Object.keys(SPACING_PX) as Spacing[];

export const SURFACES = ['primary', 'secondary'] as const;
export type Surface = (typeof SURFACES)[number];

export const MODALITIES = ['super_veloz', 'pickup', 'envio_programado'] as const;
export type Modality = (typeof MODALITIES)[number];
/** En el editor existe además `todas`, que equivale a no restringir. */
export const MODALITY_SCOPE = [...MODALITIES, 'todas'] as const;
export type ModalityScope = (typeof MODALITY_SCOPE)[number];

export const MODALITY_LABELS: Record<Modality, string> = {
  super_veloz: 'Súper Veloz',
  pickup: 'Pickup',
  envio_programado: 'Envío programado',
};

export const PLATFORMS = ['ios', 'android'] as const;
export type Platform = (typeof PLATFORMS)[number];
