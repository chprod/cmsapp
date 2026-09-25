# CMS App alfa · Experience Studio

Home server-driven de la app Chedraui (Next Gen). Esta es la **alfa**: no es el MVP del PRD, es el kit de **Fase 0** para responder con evidencia las tres hipótesis antes de comprometer la construcción.

| Hipótesis | Qué trae esta alfa para responderla |
| --- | --- |
| **H1 · demanda**: > 8 cambios/mes requieren release, lead time > 10 días | `tools/audit`: lee el CSV de solicitudes y recomienda Go / Slots fijos / Zona gris / No-go |
| **H2 · valor**: Home segmentada sube add-to-cart | Instrumentación §15 lista (eventos con `experience_version`) y Resolver que ya segmenta por audiencia, tienda y modalidad |
| **H3 · viabilidad**: la app pinta componentes desde JSON sin degradar | Contrato §7 estable, Resolver con fallback por versión y un simulador que se comporta como la app (timeout, caché, Home embebida) |

Además, el simulador sirve para la **prueba de usabilidad** de la semana 3 (§17) y para que el aprobador vea **qué verá cada cliente y por qué** antes de publicar.

PRD completo: [`docs/PRD.md`](docs/PRD.md) · Revisión de producto y decisiones de la alfa: [`docs/revision-producto.md`](docs/revision-producto.md)

---

## Arquitectura

```
apps/studio          Strapi v5 · back-office (qué mostrar y bajo qué reglas)
      │  webhook al publicar
      ▼
services/resolver    Experience Resolver · decide qué ve cada cliente
      │  GET /v1/home        (la app nunca consulta Strapi)
      ▼
apps/preview         Simulador · pinta como la app y explica cada decisión

packages/contract    Una sola fuente de reglas: tipos, tokens, límites, audiencias,
                     validaciones R1–R12. La usan Strapi y el Resolver.
fixtures/            Tiendas, clientes, catálogo y experiencias de ejemplo
tools/audit          Fase 0 · H1
```

La lógica de negocio vive en `packages/contract` y `services/resolver`, no en Strapi. Así un upgrade mayor de Strapi no rompe reglas (§13, riesgo de extensiones).

## Arranque rápido

Requiere Node ≥ 22.18 (ejecuta TypeScript sin compilar).

```bash
npm install
npm start                # Resolver + simulador con fixtures, sin Strapi
# → http://localhost:4000/preview/
npm test                 # 55 pruebas: reglas R1–R12, HU-01…HU-05, API, auditoría
npm run typecheck
```

### Con Strapi (Experience Studio)

```bash
npm run build:contract                 # Strapi consume el contrato compilado
cd apps/studio
cp .env.example .env                   # cambia los secretos
npm install
npm run develop                        # → http://localhost:1337/admin
```

Con `SEED_ON_BOOT=true`, al primer arranque se crean: los 5 roles de §12, el registro de componentes, las audiencias, los segmentos de tiendas y las 5 experiencias de ejemplo (pasan por las mismas validaciones que un editor).

Para que el Resolver lea de Strapi, crea un API token de solo lectura en *Settings → API Tokens* y:

```bash
CONTENT_SOURCE=strapi STRAPI_URL=http://localhost:1337 STRAPI_TOKEN=<token> \
WEBHOOK_SECRET=dev-secret npm start
```

Cada publicación en Strapi avisa al Resolver (`RESOLVER_WEBHOOK_URL`), que recarga contenido e invalida caché.

### Auditoría de Fase 0 (H1)

```bash
npm run audit:fase0 -- tools/audit/solicitudes-plantilla.csv
```

Llena la plantilla con los tickets de los últimos 3 meses. Columnas: `id, fecha_solicitud, fecha_produccion, tipo, requirio_release, cabe_en_slot_fijo, notas`.

---

## Qué probar en el simulador

| Escenario | Cómo | Qué debe pasar |
| --- | --- | --- |
| Campaña programada (HU-01) | Tienda CDMX; fecha "Fin de campaña FyV" | Entra la campaña; al terminar vuelve la Home base sin intervención |
| App vieja (HU-02) | Versión 7.1.0 | Mecánica promocional se reemplaza por carrusel; nunca hay huecos |
| Nunca mostrar lo que no se puede comprar (HU-03) | Mérida + Súper Veloz | La cerveza (solo Pickup) no aparece; ningún SKU se repite |
| Tienda sin Súper Veloz | Xalapa + Súper Veloz | Se resuelve con Pickup y se avisa al cliente |
| Primera visita | Sin sesión, sin tienda | Home de nuevo cliente con selector de tienda arriba |
| Conector caído | Simular fallas → Recomendaciones | Solo ese módulo desaparece |
| Resolver caído | Simular fallas → Resolver caído | Última Home guardada; si no hay, Home embebida |
| Kill switch (§8.5) | Kill switch → `category-rail` | Desaparece en todas las experiencias al instante |
| Accesibilidad | Texto 200%, ancho 360 | Precios y disponibilidad nunca se truncan |

El panel **Por qué ves esto** explica la experiencia elegida, cada módulo mostrado u oculto y por qué perdieron las demás. **Eventos** muestra lo que la app enviaría a Analytics.

---

## API del Resolver

| Método | Ruta | Uso |
| --- | --- | --- |
| GET | `/v1/home?storeId&modality&platform&appVersion&customerId[&debug=1]` | Home resuelta (contrato §7). `debug=1` agrega `diagnostics` |
| POST | `/v1/webhooks/strapi` | Header `x-webhook-secret`. Recarga contenido e invalida caché |
| POST | `/v1/events` | Ingesta de eventos de app (§15) |
| GET | `/v1/metrics` | Latencia p50/p95, caché, decisiones por motivo |
| GET | `/health` | Estado y fuente de contenido |

Solo con `SIMULATOR_ENABLED=true` (por defecto fuera de producción): `/preview/`, `/v1/simulator/*`, `?at=` para simular fecha y `?fail=` para simular conectores caídos.

## Trazabilidad PRD → código

| PRD | Dónde | Prueba |
| --- | --- | --- |
| R1, R2, R3, R4, R5, R6, R10 (formato), R11 | `packages/contract/src/validate-experience.ts` → Strapi `apps/studio/src/studio/guards.js` | `packages/contract/test` |
| R7, R8, R9, kill switch, fallbacks | `services/resolver/src/engine/resolve.ts` | `services/resolver/test` |
| Selección (prioridad, fechas, alcance, audiencia) | `services/resolver/src/engine/select.ts` | HU-01, empate |
| Reglas en lenguaje humano (HU-05) | `packages/contract/src/audience.ts` (`describeRule`) | `describeRule…` |
| Roles §12 | `apps/studio/src/studio/roles.js` | verificado al arrancar Strapi |
| Estados §10 | Resolver + `apps/preview/app.js` | conector caído, timeout, sin tienda |
| Instrumentación §15 | `apps/preview/app.js` (app) · `server.ts` (servidor) | pestaña Eventos |

## Lo que la alfa NO hace (a propósito)

- Renderers nativos iOS/Android: es el spike de H3 y lo hace Ingeniería Móvil con este contrato.
- Conectores reales a VTEX, OMS, Reco y Lealtad: se reemplazan los de `connectors/fixtures.ts` sin tocar el motor.
- Constructor visual de reglas (custom field de Strapi): en la alfa la regla es JSON validado y su resumen en español se genera solo. El editor solo ve nombre y resumen.
- R10 "destino existente": se valida el formato; la existencia requiere catálogo real (`validateDeeplinkDestinations` ya está lista).
- Releases, Content History y Live Preview dependen de la licencia Growth de Strapi.
