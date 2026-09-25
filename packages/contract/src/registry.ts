/**
 * Registro de componentes por defecto (semilla del Component Registry, §6.3).
 * En producción la fuente es Strapi (solo DS Admin la edita). Este archivo sirve
 * para arrancar entornos locales y para tests.
 */
import type { RegistryEntry } from './types.ts';

const base = {
  status: 'certified',
  minAppVersionIOS: '7.0.0',
  minAppVersionAndroid: '7.0.0',
  fallbackBehavior: 'hide',
  killSwitch: false,
  owner: 'ds-admin',
} as const;

export const DEFAULT_REGISTRY: RegistryEntry[] = [
  { ...base, type: 'hero-banner', version: '1.4.0', tokensUsed: ['surface.primary', 'radius.l', 'type.title-l', 'color.on-primary'] },
  { ...base, type: 'promo-banner', version: '1.2.0', tokensUsed: ['surface.secondary', 'radius.m', 'type.title-m'] },
  {
    ...base,
    type: 'promo-mechanic',
    version: '1.0.0',
    minAppVersionIOS: '7.3.0',
    minAppVersionAndroid: '7.3.0',
    fallbackBehavior: 'replace_with',
    replaceWith: 'product-carousel',
    tokensUsed: ['color.promo', 'type.price', 'type.unit-price'],
  },
  { ...base, type: 'product-carousel', version: '1.5.0', minAvailableItems: 4, tokensUsed: ['surface.primary', 'type.price', 'type.body-s'] },
  { ...base, type: 'buy-again', version: '1.5.0', minAvailableItems: 3, tokensUsed: ['surface.primary', 'type.price'] },
  { ...base, type: 'order-status', version: '1.1.0', tokensUsed: ['surface.secondary', 'color.success'] },
  {
    ...base,
    type: 'shopping-lists',
    version: '1.0.0',
    minAppVersionIOS: '7.2.0',
    minAppVersionAndroid: '7.2.0',
    tokensUsed: ['surface.secondary'],
  },
  { ...base, type: 'category-rail', version: '1.3.0', tokensUsed: ['radius.full', 'type.body-s'] },
  { ...base, type: 'loyalty', version: '1.0.0', fallbackBehavior: 'static_image', tokensUsed: ['surface.brand'] },
  { ...base, type: 'sponsored-carousel', version: '1.0.0', minAvailableItems: 4, tokensUsed: ['surface.primary', 'type.caption-s'] },
];
