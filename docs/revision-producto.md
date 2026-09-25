# Revisión de producto · lo que aprendimos al construir la alfa

**Para:** Producto, Ingeniería Móvil, Backend, Marketing Digital, DS · **Fecha:** 25 sep 2026 · **Base:** [PRD v0.1](PRD.md)

## Para decidir en 30 segundos

1. **La arquitectura del PRD se sostiene.** Strapi → Resolver → app funcionó de punta a punta con el mismo resultado leyendo de Strapi o de archivo. La separación de responsabilidades (§5.1) se pudo implementar tal cual.
2. **El PRD tiene un hueco en la regla de decisión de Fase 0** (A1). Si no se cierra antes de la auditoría, la decisión de la semana 4 se tomará por omisión.
3. **Seis supuestos del PRD cambiaron o se precisaron** al implementarlos (A2–A7). Ninguno cambia la arquitectura, pero todos cambian lo que ve un editor o un cliente. Hay que aprobarlos o rechazarlos en §23.

---

## 1. Hallazgos en el PRD

| # | Hallazgo | Por qué importa | Propuesta de la alfa | Decide |
| --- | --- | --- | --- | --- |
| **A1** | §1.4 dice "si > 70% cabe en slots → slots". §17 dice "Go requiere > 70% **fuera** de slots". Entre 30% y 70% fuera de slots ninguna regla aplica. | Es el caso más probable. Sin regla, gana quien tenga más ganas de construir. | `tools/audit` devuelve **zona gris** de forma explícita y sugiere un camino intermedio: slots fijos ahora + Resolver con elegibilidad por tienda/modalidad; renderer genérico después. | Producto, antes de la semana 1 |
| **A2** | "Base" significa tres cosas: la experiencia sin `endsAt` (§6.1), la que tiene `isFallback` (§6.1) y la excepción de R5. | Un editor no sabrá si "Home Recurrente" sin fechas es válida. | Tres términos: **Base nacional** (`isFallback`, única, sin tiendas ni fechas · R12 nueva), **Home por audiencia** (sin fechas, permitida), **Campaña** (con `startsAt`; `endsAt` obligatorio). | Producto + Marketing |
| **A3** | No se define qué pasa con clientes **sin sesión** en las reglas de audiencia. | Afecta al segmento más grande de primera visita. | Anónimo = 0 pedidos (califica como "nuevo"). Un dato desconocido **nunca** cumple una condición: preferimos no mostrar un módulo segmentado a mostrárselo a quien no aplica. | Data |
| **A4** | R4 permite `beta` "en audiencias de prueba", pero la audiencia no tiene cómo marcarse como de prueba. | R4 no se puede implementar. | Campo `isTestAudience` en `audience`. | DS + Growth |
| **A5** | `replace_with` supone que el componente destino entiende las props del original. | Sin adaptador, el reemplazo pinta basura o nada. | Adaptador explícito por par (hoy: `promo-mechanic → product-carousel`). Sin adaptador, se oculta. **El carrusel patrocinado nunca se reemplaza**: sin la etiqueta sería publicidad no declarada. | DS + Legal/Comercial |
| **A6** | Con TTL de 300 s, una campaña puede seguir viéndose hasta 5 min después de `endsAt`. | Precios o promos vencidas en pantalla. | El Resolver acota el TTL al siguiente cambio de calendario (fin de la actual o inicio de otra). La app además respeta `endsAt` en caché. | Arquitectura |
| **A7** | Al 200% de texto (§11), el Hero ocupa toda la pantalla y empuja el resto fuera de vista. | Cumple "no truncar", pero rompe la Home para quien más necesita texto grande. | DS define variante del Hero para escalas ≥ 150%: imagen colapsada, título a 3 líneas máx., sin subtítulo. Hallazgo del simulador. | DS |
| A8 | `minAvailableItems` solo está definido para el carrusel. | Volver a comprar con 2 productos es útil; un carrusel curado con 2 no. | Por tipo, en el registro: carrusel 4, patrocinado 4, mecánica 4, volver a comprar 3. Validar con datos. | Producto + Data |
| A9 | `audience.description` es texto libre obligatorio "en lenguaje humano". | Puede contradecir a la regla real y nadie lo notaría. | `ruleSummary` se **genera** desde la regla ("Clientes sin pedidos y socios del programa de lealtad"). `description` queda para el *porqué* de la audiencia. | Growth |
| A10 | Modalidades como enum múltiple en JSON. | Carga cognitiva innecesaria para un perfil de nivel técnico bajo. | Tres casillas: Súper Veloz, Pickup, Envío programado. Las tres = todas. | Marketing |
| A11 | Category Rail como "relación ordenada" a categorías. | Las categorías viven en VTEX, no en Strapi. | Alfa: IDs separados por coma con validación. Fase 1: custom field con búsqueda en catálogo. | Backend |
| A12 | Valores de enum `2x1`, `segundo_al_%`, `%_descuento`. | Strapi no los acepta como enumeración. | `dos_por_uno`, `tres_por_dos`, `segundo_al_porcentaje`, `porcentaje_descuento`, `precio_especial`. La etiqueta visible ("2x1") la arma el Resolver. | — (técnico) |
| A13 | HU-04 (rollback) y la prueba de usabilidad de §17 dependen de Content History y Releases, que son **Growth**. | En Community no se puede probar rollback con editores reales. | Pedir licencia de prueba Growth para la semana 3, o sacar rollback de la prueba y validarlo en Fase 1. | Producto + TI |
| A14 | El selector de tienda (§10) aparece como "módulo", pero no está en la lista de módulos. | La app necesita saber pintarlo. | Tipo de sistema `store-selector` (el Resolver lo inserta; el editor no lo usa), igual que `static-image` para fallbacks. | Móvil |
| A15 | §15 mide lo que se muestra, no **lo que se ocultó y por qué**. | Si "Volver a comprar" se oculta en 40% de las sesiones de una tienda, es un problema de inventario, no de diseño. | El Resolver cuenta decisiones por motivo (`min_available_items`, `data_error`, `kill_switch`…) en `/v1/metrics`. Llevarlo al dashboard de Salud. | Data |

---

## 2. Decisiones tomadas en la alfa (para §23)

| Decisión | Razón | Estado |
| --- | --- | --- |
| Una sola implementación de reglas (`packages/contract`) usada por Strapi y el Resolver | Lo que Strapi deja guardar y lo que el Resolver sirve no pueden divergir | Propuesta alfa |
| Validaciones como middleware del Document Service, no como custom fields | Menos superficie que se rompa en upgrades de Strapi (§13) | Propuesta alfa |
| El Resolver explica cada decisión (`?debug=1`) | Es el preview que pide §8.1 y el diff que pide §8.3, en lenguaje del editor | Propuesta alfa |
| Timeout por conector (400 ms) dentro del presupuesto de 1.5 s de la app | Un conector lento no puede tumbar la Home entera | Propuesta alfa |
| Perfil de cliente caído → cliente anónimo, nunca error | "Siempre hay una Home" (§4) | Propuesta alfa |
| R12: base nacional única, sin tiendas ni fecha de fin | Cierra A2 | Propuesta alfa |

---

## 3. Cómo usar la alfa en Fase 0

| Semana | Actividad del PRD | Con qué de la alfa |
| --- | --- | --- |
| 1 | Auditoría de solicitudes (H1) | `npm run audit:fase0 -- solicitudes.csv`. Cerrar A1 **antes** de correrla. |
| 1–3 | Spike de renderers nativos (H3) | El contrato de `GET /v1/home` y los fixtures son la entrada del spike. Criterio: los mismos 3 escenarios del simulador (recurrente CDMX, app 7.1.0, Resolver caído) se ven igual en la app. |
| 2 | Instrumentar la Home actual | La pestaña **Eventos** del simulador es la especificación ejecutable de §15. |
| 3 | Usabilidad con 5 editores | Strapi con semilla + simulador. Tareas: programar una campaña, ocultar un módulo para clientes nuevos, entender por qué un cliente no ve un módulo. Rollback depende de A13. |
| 4 | Decisión | Salida de la auditoría + resultado del spike + tasa de éxito de la prueba. |

### Prueba de usabilidad · guion mínimo

| Tarea | Éxito | Qué observar |
| --- | --- | --- |
| "Haz que la campaña de frutas termine el domingo" | Guarda con `endsAt` correcto sin ayuda | ¿Entiende la zona horaria? ¿Lee el error de R5 si se equivoca? |
| "Que los clientes nuevos no vean Volver a comprar" | Usa la regla de visibilidad del módulo | ¿Busca la regla en el módulo o en la experiencia? |
| "Un cliente de Xalapa dice que no ve el carrusel de ofertas. ¿Por qué?" | Encuentra la razón en el simulador | ¿Confía en la explicación? ¿Qué palabra usaría él? |
| "Publica esta experiencia" (como Editor) | Descubre que no puede y a quién pedírselo | ¿El bloqueo se entiende o frustra? |

---

## 4. Qué medir

| Pregunta | Métrica | Fuente | Umbral |
| --- | --- | --- | --- |
| ¿La Home llega? | % de `home_experience_loaded` con `source = network` | App | ≥ 98% |
| ¿Es rápida? | p95 del Resolver (hit / miss) | `/v1/metrics` → APM | < 150 / 600 ms |
| ¿Se rompe? | `module_render_error` + `module_unsupported` / impresiones | App | < 0.1% |
| ¿El inventario sabotea la Home? | % de módulos ocultos por `min_available_items`, por tienda | Resolver | Alerta si > 20% en una tienda |
| ¿Vende? | Add-to-cart por 1,000 impresiones por `module_key`, posición y audiencia | App | Baseline en semana 2 |
| ¿El Studio acelera? | Lead time solicitud → `experience_published` | Studio + Jira | −70% vs auditoría |

### Experimento para H2 (propuesta)

- **Unidad:** cliente (no sesión), para evitar que alguien vea dos Homes distintas.
- **Brazos:** Home base nacional vs. Home segmentada (audiencia + tienda + modalidad).
- **Métrica primaria:** add-to-cart por sesión que inicia en Home.
- **Guardrails:** conversión total, tiempo a primer contenido, crash rate (§16: pausa si alguno empeora > 2%).
- **Tamaño:** falta el baseline. Con la tasa real de la semana 2 se calcula el tamaño de muestra para detectar +5% relativo con 80% de potencia; si el tráfico no alcanza en 4 semanas, subir el efecto mínimo o alargar, no bajar el rigor.
- **Integración:** `experience_version` ya viaja en todos los eventos; falta Q3 (herramienta de experimentación).

---

## 5. Preguntas nuevas

| # | Pregunta | Dueño | Bloquea |
| --- | --- | --- | --- |
| Q8 | ¿Cómo se cierra la zona gris de A1? | Producto | Decisión de semana 4 |
| Q9 | ¿Un cliente sin sesión cuenta como "nuevo"? (A3) | Data | Audiencias |
| Q10 | ¿Legal permite ocultar un patrocinado ya vendido cuando la app no lo soporta? ¿Se compensa al anunciante? (A5) | Comercial | Retail Media futuro |
| Q11 | ¿Hay licencia Growth de prueba para la semana 3? (A13) | TI | Prueba de usabilidad |
| Q12 | ¿En qué zona horaria piensan los editores las fechas de campaña? México tiene 4. | Marketing | R5, HU-01 |

---

## 6. Hacia dónde va esto (3 años)

- **El editor define qué es elegible; un modelo decide el orden.** Las reglas R1–R12 se vuelven restricciones de un optimizador que ordena módulos por cliente con la señal de add-to-cart por impresión. Fase 3 del PRD ya apunta ahí; la alfa deja listo el insumo (decisiones explicadas + eventos atribuibles).
- **Menos Homes hechas a mano.** Hoy cada combinación audiencia × tienda × modalidad es una experiencia. Mañana: pocas plantillas + elegibilidad automática. Menos contenido que mantener, menos riesgo de R6.
- **IA para el trabajo repetitivo del editor**, con los límites del sistema: proponer títulos que cumplan R11, generar alt text para revisión humana, avisar "esta campaña va a ocultarse en 12 tiendas por falta de inventario" antes de publicar.
- **Qué eliminar:** el diff manual. Si el Resolver ya explica qué verá cada segmento, el aprobador revisa **impacto** ("cambia la Home de 1.2 M de clientes recurrentes en CDMX"), no campos.
