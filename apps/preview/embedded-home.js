/**
 * Home embebida: viaja dentro del binario de la app. Último recurso cuando no hay red
 * ni caché válida (§4 "Siempre hay una Home"). Sin productos ni precios: nada que
 * pueda estar desactualizado.
 */
export const EMBEDDED_HOME = {
  contractVersion: '1.0.0',
  experience: { id: 'embedded', version: 0, audience: 'Todos', resolvedFor: {}, endsAt: null },
  ttlSeconds: 0,
  modules: [
    {
      moduleKey: 'embedded_hero',
      type: 'hero-banner',
      version: '1.0.0',
      spacingTop: 'none',
      props: {
        image: { url: '', alt: 'Canasta con despensa' },
        title: 'Tu súper, como siempre',
        subtitle: 'Busca lo que necesitas o explora por categoría.',
        cta: { label: 'Buscar productos', deeplink: 'chedraui://busqueda' },
      },
    },
    {
      moduleKey: 'embedded_categorias',
      type: 'category-rail',
      version: '1.0.0',
      spacingTop: 'l',
      props: {
        title: 'Categorías',
        categories: [
          { id: 'fyv', name: 'Frutas y verduras', emoji: '🥑', deeplink: 'chedraui://categoria/fyv' },
          { id: 'lacteos', name: 'Lácteos', emoji: '🥛', deeplink: 'chedraui://categoria/lacteos' },
          { id: 'basicos', name: 'Básicos', emoji: '🌾', deeplink: 'chedraui://categoria/basicos' },
          { id: 'despensa', name: 'Despensa', emoji: '🥫', deeplink: 'chedraui://categoria/despensa' },
          { id: 'bebidas', name: 'Bebidas', emoji: '🥤', deeplink: 'chedraui://categoria/bebidas' },
          { id: 'hogar', name: 'Limpieza y hogar', emoji: '🧽', deeplink: 'chedraui://categoria/hogar' },
        ],
      },
    },
  ],
  tracking: { experienceVersion: 'embedded@0' },
};
