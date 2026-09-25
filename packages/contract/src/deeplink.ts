/**
 * R10 · Deeplinks válidos.
 * Formato: chedraui://<ruta>[/<id>] con rutas de una lista cerrada.
 * La verificación de "destino existente" (que la colección o SKU exista) requiere
 * catálogo: se inyecta como `DestinationChecker` desde Strapi.
 */
export const DEEPLINK_ROUTES = {
  coleccion: { needsId: true, label: 'Colección' },
  producto: { needsId: true, label: 'Producto' },
  categoria: { needsId: true, label: 'Categoría' },
  promo: { needsId: true, label: 'Promoción' },
  lista: { needsId: false, label: 'Listas' },
  pedidos: { needsId: false, label: 'Mis pedidos' },
  pedido: { needsId: true, label: 'Pedido' },
  tienda: { needsId: false, label: 'Selector de tienda' },
  lealtad: { needsId: false, label: 'Programa de lealtad' },
  busqueda: { needsId: false, label: 'Búsqueda' },
} as const;

export type DeeplinkRoute = keyof typeof DEEPLINK_ROUTES;

export interface ParsedDeeplink {
  route: DeeplinkRoute;
  id: string | null;
}

const PATTERN = /^chedraui:\/\/([a-z]+)(?:\/([A-Za-z0-9_-]+))?\/?(?:\?[A-Za-z0-9_=&%.-]*)?$/;

export function parseDeeplink(link: string): ParsedDeeplink | null {
  const m = PATTERN.exec(link.trim());
  if (!m) return null;
  const route = m[1] as DeeplinkRoute;
  const def = DEEPLINK_ROUTES[route];
  if (!def) return null;
  const id = m[2] ?? null;
  if (def.needsId && !id) return null;
  return { route, id };
}

export function deeplinkError(link: string | undefined | null): string | null {
  if (!link) return 'Falta el deeplink del botón.';
  if (!link.startsWith('chedraui://')) return 'El deeplink debe empezar con chedraui://';
  const parsed = parseDeeplink(link);
  if (!parsed) {
    const routes = Object.keys(DEEPLINK_ROUTES).join(', ');
    return `Deeplink no válido. Usa chedraui://<ruta>/<id> con una ruta de: ${routes}.`;
  }
  return null;
}

/** Devuelve true si el destino existe (colección, SKU, categoría…). */
export type DestinationChecker = (link: ParsedDeeplink) => boolean | Promise<boolean>;
