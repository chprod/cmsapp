/**
 * Arranque del Resolver.
 *
 *   CONTENT_SOURCE=file (default) | strapi
 *   STRAPI_URL, STRAPI_TOKEN        si CONTENT_SOURCE=strapi
 *   FIXTURES_DIR                    default ../../fixtures
 *   WEBHOOK_SECRET                  secreto compartido con Strapi
 *   SIMULATOR_ENABLED               default true fuera de producción
 *   PORT                            default 4000
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '@chedraui-xp/contract';
import { createFixtureConnectors, type FaultInjection } from './connectors/fixtures.ts';
import { FileContentSource, StrapiContentSource, type ContentSource } from './content/source.ts';
import { TtlCache } from './engine/cache.ts';
import { createResolverServer } from './server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const fixturesDir = resolve(env.FIXTURES_DIR ?? resolve(here, '../../../fixtures'));
const isProd = env.NODE_ENV === 'production';
const port = Number(env.PORT ?? 4000);

const faults: FaultInjection = {};
const { connectors, storeFile, customerFile } = createFixtureConnectors(fixturesDir, () => faults);

let source: ContentSource;
if (env.CONTENT_SOURCE === 'strapi') {
  if (!env.STRAPI_URL || !env.STRAPI_TOKEN) throw new Error('CONTENT_SOURCE=strapi requiere STRAPI_URL y STRAPI_TOKEN');
  source = new StrapiContentSource(env.STRAPI_URL, env.STRAPI_TOKEN);
} else {
  source = new FileContentSource(fixturesDir);
}

const { server } = await createResolverServer({
  source,
  webhookSecret: env.WEBHOOK_SECRET ?? (isProd ? '' : 'dev-secret'),
  deps: {
    connectors,
    cache: new TtlCache(LIMITS.responseTtlSeconds * 1000),
    emit: (name, props) => console.log(JSON.stringify({ level: 'info', event: name, ...props })),
  },
  simulator: {
    enabled: env.SIMULATOR_ENABLED ? env.SIMULATOR_ENABLED === 'true' : !isProd,
    previewDir: resolve(here, '../../../apps/preview'),
    storeFile,
    customers: customerFile.customers.map((c) => ({ id: c.id, persona: c.persona })),
    faults,
  },
});

server.listen(port, () => {
  console.log(`Experience Resolver en http://localhost:${port}  (contenido: ${env.CONTENT_SOURCE ?? 'file'})`);
  console.log(`Simulador:            http://localhost:${port}/preview/`);
});
