/**
 * Fuente de contenido editorial. El Resolver lee de Strapi (o de archivo en local),
 * normaliza a los tipos del contrato y guarda un snapshot en memoria.
 * La app NUNCA consulta Strapi directo (§5.1).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_REGISTRY,
  describeRule,
  type AudienceRef,
  type AudienceRule,
  type EditorialModule,
  type Modality,
  type Experience,
  type RegistryEntry,
  type StoreSegment,
} from '@chedraui-xp/contract';

export interface ContentSnapshot {
  experiences: Experience[];
  registry: RegistryEntry[];
  segments: StoreSegment[];
  audiences: AudienceRef[];
  loadedAt: string;
  source: 'file' | 'strapi';
}

export interface ContentSource {
  load(): Promise<ContentSnapshot>;
}

// ─────────────────────────────── Archivo ───────────────────────────────

interface RawAudience {
  id: string;
  name: string;
  rule: AudienceRule;
  isTestAudience?: boolean;
}
type RawModule = Omit<EditorialModule, 'visibilityRule'> & { visibilityRule?: string | null };
interface RawExperience extends Omit<Experience, 'audience' | 'storeScope' | 'modules'> {
  audience: string;
  storeScope: string[];
  modules: RawModule[];
}

export function toAudienceRef(a: RawAudience): AudienceRef {
  return { id: a.id, name: a.name, rule: a.rule, description: describeRule(a.rule), isTestAudience: a.isTestAudience ?? false };
}

export class FileContentSource implements ContentSource {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async load(): Promise<ContentSnapshot> {
    const raw = JSON.parse(readFileSync(join(this.dir, 'content.json'), 'utf8')) as {
      audiences: RawAudience[];
      experiences: RawExperience[];
      registry?: RegistryEntry[];
    };
    const stores = JSON.parse(readFileSync(join(this.dir, 'stores.json'), 'utf8')) as { segments: StoreSegment[] };
    const audiences = new Map(raw.audiences.map((a) => [a.id, toAudienceRef(a)]));
    const segments = new Map(stores.segments.map((s) => [s.id, s]));
    const need = <T>(map: Map<string, T>, id: string, what: string): T => {
      const v = map.get(id);
      if (!v) throw new Error(`content.json: ${what} "${id}" no existe`);
      return v;
    };
    const experiences: Experience[] = raw.experiences.map((e) => ({
      ...e,
      audience: need(audiences, e.audience, 'audiencia'),
      storeScope: e.storeScope.map((id) => need(segments, id, 'segmento')),
      modules: e.modules.map((m) => ({
        ...m,
        visibilityRule: m.visibilityRule ? need(audiences, m.visibilityRule, 'audiencia') : null,
      })) as EditorialModule[],
    }));
    return {
      experiences,
      registry: raw.registry ?? structuredClone(DEFAULT_REGISTRY),
      segments: [...segments.values()],
      audiences: [...audiences.values()],
      loadedAt: new Date().toISOString(),
      source: 'file',
    };
  }
}

// ─────────────────────────────── Strapi v5 ───────────────────────────────

/** Campos de cada componente de la Dynamic Zone que necesitan populate (media y componentes anidados). */
const MODULE_POPULATE: Record<string, string[]> = {
  'hero-banner': ['image', 'cta'],
  'promo-banner': ['image', 'cta'],
  'promo-mechanic': [],
  'product-carousel': ['cta'],
  'buy-again': [],
  'order-status': [],
  'shopping-lists': [],
  'category-rail': [],
  loyalty: ['cta'],
  'sponsored-carousel': [],
};

function modulePopulate(): string[] {
  return Object.entries(MODULE_POPULATE).flatMap(([type, fields]) => {
    const p = `populate[modules][on][module.${type}][populate]`;
    return [`${p}[base][populate]=*`, ...fields.map((f) => `${p}[${f}]=true`)];
  });
}

interface StrapiList<T> {
  data: T[];
  meta?: { pagination?: { page: number; pageCount: number } };
}

type StrapiDoc = Record<string, unknown> & { documentId: string; publishedAt?: string; updatedAt?: string };

/**
 * Lee contenido publicado vía REST API de Strapi v5 con un API token de solo lectura.
 * Formato plano de v5 (sin `attributes`).
 */
export class StrapiContentSource implements ContentSource {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private async getAll(path: string, populate: string): Promise<StrapiDoc[]> {
    const out: StrapiDoc[] = [];
    for (let page = 1; ; page++) {
      const url = `${this.baseUrl.replace(/\/$/, '')}/api/${path}?status=published&pagination[page]=${page}&pagination[pageSize]=100&${populate}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
      if (!res.ok) throw new Error(`Strapi ${path}: HTTP ${res.status}`);
      const body = (await res.json()) as StrapiList<StrapiDoc>;
      out.push(...body.data);
      const p = body.meta?.pagination;
      if (!p || p.page >= p.pageCount) break;
    }
    return out;
  }

  async load(): Promise<ContentSnapshot> {
    const [audRaw, segRaw, regRaw, expRaw] = await Promise.all([
      this.getAll('audiences', ''),
      this.getAll('store-segments', ''),
      this.getAll('component-registries', 'populate[replaceWith]=true'),
      this.getAll(
        'experiences',
        ['populate[audience]=true', 'populate[storeScope]=true', ...modulePopulate()].join('&'),
      ),
    ]);

    const audiences = audRaw.map((a) =>
      toAudienceRef({ id: a.documentId, name: String(a.name), rule: a.rule as AudienceRule, isTestAudience: Boolean(a.isTestAudience) }),
    );
    const audById = new Map(audiences.map((a) => [a.id, a]));
    const segments: StoreSegment[] = segRaw.map((s) => ({
      id: s.documentId,
      name: String(s.name),
      zone: String(s.zone ?? ''),
      stores: Array.isArray(s.stores) ? (s.stores as string[]) : [],
    }));
    const segById = new Map(segments.map((s) => [s.id, s]));
    const registry: RegistryEntry[] = regRaw.map((r) => ({
      type: r.type as RegistryEntry['type'],
      version: String(r.version),
      status: r.status as RegistryEntry['status'],
      minAppVersionIOS: String(r.minAppVersionIOS ?? '0.0.0'),
      minAppVersionAndroid: String(r.minAppVersionAndroid ?? '0.0.0'),
      fallbackBehavior: (r.fallbackBehavior ?? 'hide') as RegistryEntry['fallbackBehavior'],
      replaceWith: ((r.replaceWith as { type?: string } | null)?.type ?? null) as RegistryEntry['replaceWith'],
      minAvailableItems: (r.minAvailableItems as number | null) ?? null,
      tokensUsed: Array.isArray(r.tokensUsed) ? (r.tokensUsed as string[]) : [],
      killSwitch: Boolean(r.killSwitch),
    }));

    const experiences: Experience[] = expRaw.map((e) => {
      const aud = e.audience as StrapiDoc | null;
      return {
        id: String(e.slug ?? e.documentId),
        version: Number(e.publishedVersion ?? 1),
        name: String(e.name),
        screen: 'home',
        audience: (aud && audById.get(aud.documentId)) || audiences[0]!,
        storeScope: ((e.storeScope as StrapiDoc[] | null) ?? []).flatMap((s) => {
          const seg = segById.get(s.documentId);
          return seg ? [seg] : [];
        }),
        modalities: strapiModalities(e),
        priority: Number(e.priority ?? 0),
        modules: ((e.modules as Record<string, unknown>[] | null) ?? []).map((m) => strapiModule(m, audById)),
        startsAt: (e.startsAt as string | null) ?? null,
        endsAt: (e.endsAt as string | null) ?? null,
        isFallback: Boolean(e.isFallback),
        publishedAt: String(e.publishedAt ?? e.updatedAt),
        updatedAt: String(e.updatedAt),
      };
    });

    return { experiences, registry, segments, audiences, loadedAt: new Date().toISOString(), source: 'strapi' };
  }
}

/** En Strapi la modalidad son tres casillas (más claro para el editor que un JSON). */
function strapiModalities(e: StrapiDoc): Experience['modalities'] {
  const flags: [unknown, Modality][] = [
    [e.modalitySuperVeloz, 'super_veloz'],
    [e.modalityPickup, 'pickup'],
    [e.modalityEnvioProgramado, 'envio_programado'],
  ];
  const on = flags.filter(([v]) => v !== false).map(([, m]) => m);
  return on.length === flags.length ? ['todas'] : on;
}

/** Convierte un componente de Dynamic Zone (`__component: module.hero-banner`) al módulo del contrato. */
function strapiModule(raw: Record<string, unknown>, audById: Map<string, AudienceRef>): EditorialModule {
  const type = String(raw.__component).replace(/^module\./, '');
  const base = (raw.base ?? {}) as Record<string, unknown>;
  const { __component: _c, id: _id, base: _b, ...fields } = raw;
  const media = (m: unknown, alt: unknown) => {
    const f = m as { url?: string; alternativeText?: string } | null;
    return f?.url ? { url: f.url, alt: String(alt ?? f.alternativeText ?? '') } : undefined;
  };
  const props: Record<string, unknown> = { ...fields };
  if ('image' in fields) props.image = media(fields.image, fields.imageAlt);
  delete props.imageAlt;
  if (fields.cta) {
    const { id: _ctaId, ...cta } = fields.cta as Record<string, unknown>;
    props.cta = cta;
  }
  if (type === 'category-rail' && typeof fields.categoryIds === 'string') {
    props.categoryIds = String(fields.categoryIds).split(',').map((s) => s.trim()).filter(Boolean);
  }
  const vis = base.visibilityRule as StrapiDoc | null | undefined;
  return {
    type,
    moduleKey: String(base.moduleKey ?? ''),
    spacingTop: (base.spacingTop ?? 'm') as EditorialModule['spacingTop'],
    trackingLabel: base.trackingLabel as string | undefined,
    visibilityRule: vis ? audById.get(vis.documentId) ?? null : null,
    fallbackImage: media(base.fallbackImage, base.fallbackImageAlt) ?? null,
    props,
  } as EditorialModule;
}
