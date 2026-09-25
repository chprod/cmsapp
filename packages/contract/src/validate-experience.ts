/**
 * Validaciones de edición (PRD §9). Corren al guardar en Strapi y en CI de contenido.
 * Mensajes en español, orientados a la acción: qué está mal y cómo arreglarlo.
 */
import { LIMITS } from './limits.ts';
import { deeplinkError, parseDeeplink, type DestinationChecker } from './deeplink.ts';
import { maxSemver } from './semver.ts';
import type { ModalityScope } from './tokens.ts';
import type { RegistryEntry } from './types.ts';

export type RuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R10' | 'R11' | 'R12' | 'MOD';

export interface ValidationIssue {
  rule: RuleId;
  severity: 'error' | 'warning';
  /** Ruta del campo, p. ej. modules[2].props.cta.label */
  path: string;
  message: string;
}

export interface DraftModule {
  type: string;
  moduleKey?: string;
  props?: Record<string, unknown>;
  fallbackImage?: { url?: string; alt?: string } | null;
}

/** Forma tolerante: el editor puede guardar borradores incompletos. */
export interface ExperienceDraft {
  id?: string;
  name?: string;
  screen?: string;
  audience?: { id: string; isTestAudience?: boolean } | null;
  storeScope?: { id: string }[];
  modalities?: ModalityScope[];
  priority?: number;
  modules?: DraftModule[];
  startsAt?: string | null;
  endsAt?: string | null;
  isFallback?: boolean;
}

export interface ValidationContext {
  registry: RegistryEntry[];
  /** Otras experiencias publicadas o programadas (para R6 y R12). */
  others?: ExperienceDraft[];
}

const REQUIRED_PROPS: Record<string, string[]> = {
  'hero-banner': ['image', 'title'],
  'promo-banner': ['image', 'title'],
  'promo-mechanic': ['title', 'mechanic', 'collectionId'],
  'product-carousel': ['title', 'source'],
  'buy-again': ['title'],
  'order-status': [],
  'shopping-lists': ['title'],
  'category-rail': ['categoryIds'],
  loyalty: [],
  'sponsored-carousel': ['title', 'advertiser', 'collectionId'],
};

const TITLE_FIELDS = ['title', 'memberTitle', 'nonMemberTitle'];

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function time(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function overlaps(a: ExperienceDraft, b: ExperienceDraft): boolean {
  const aStart = time(a.startsAt) ?? -Infinity;
  const aEnd = time(a.endsAt) ?? Infinity;
  const bStart = time(b.startsAt) ?? -Infinity;
  const bEnd = time(b.endsAt) ?? Infinity;
  return aStart < bEnd && bStart < aEnd;
}

function sameSet(a: string[] = [], b: string[] = []): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

function modalitiesOverlap(a: ModalityScope[] = ['todas'], b: ModalityScope[] = ['todas']): boolean {
  const all = (m: ModalityScope[]) => m.length === 0 || m.includes('todas');
  if (all(a) || all(b)) return true;
  return a.some((m) => b.includes(m));
}

function checkImage(
  issues: ValidationIssue[],
  image: unknown,
  path: string,
  required: boolean,
): void {
  const img = image as { url?: string; alt?: string } | null | undefined;
  if (!img || isEmpty(img.url)) {
    if (required) issues.push({ rule: 'MOD', severity: 'error', path, message: 'Falta la imagen.' });
    return;
  }
  if (isEmpty(img.alt?.trim())) {
    issues.push({
      rule: 'R3',
      severity: 'error',
      path: `${path}.alt`,
      message: 'Agrega un texto alternativo que describa la imagen. Lo leen los lectores de pantalla.',
    });
  }
}

export function validateExperience(exp: ExperienceDraft, ctx: ValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const modules = exp.modules ?? [];
  const registry = new Map(ctx.registry.map((r) => [r.type, r]));

  // R1 · máximo de módulos
  if (modules.length > LIMITS.maxVisibleModules) {
    issues.push({
      rule: 'R1',
      severity: 'error',
      path: 'modules',
      message: `La Home tiene ${modules.length} módulos. El máximo es ${LIMITS.maxVisibleModules}: quita ${modules.length - LIMITS.maxVisibleModules} para guardar.`,
    });
  }

  // R2 · patrocinado
  const sponsoredIdx = modules.flatMap((m, i) => (m.type === 'sponsored-carousel' ? [i] : []));
  if (sponsoredIdx.length > LIMITS.maxSponsoredModules) {
    issues.push({ rule: 'R2', severity: 'error', path: 'modules', message: 'Solo puede haber un carrusel patrocinado por Home.' });
  }
  if (sponsoredIdx.includes(0)) {
    issues.push({ rule: 'R2', severity: 'error', path: 'modules[0]', message: 'El carrusel patrocinado no puede ir en la primera posición. Muévelo más abajo.' });
  }

  const keys = new Set<string>();
  modules.forEach((m, i) => {
    const base = `modules[${i}]`;
    const props = m.props ?? {};
    const entry = registry.get(m.type as RegistryEntry['type']);

    // R4 · solo componentes certificados (beta en audiencias de prueba)
    if (!entry) {
      issues.push({ rule: 'R4', severity: 'error', path: base, message: `El componente "${m.type}" no está en el registro. Pide a DS que lo registre.` });
    } else if (entry.status === 'beta' && !exp.audience?.isTestAudience) {
      issues.push({ rule: 'R4', severity: 'error', path: base, message: `"${m.type}" está en beta: solo se puede usar con una audiencia de prueba.` });
    } else if (entry.status === 'draft' || entry.status === 'deprecated') {
      const why = entry.status === 'draft' ? 'todavía no está certificado' : 'está descontinuado';
      issues.push({ rule: 'R4', severity: 'error', path: base, message: `"${m.type}" ${why}. Usa otro componente.` });
    } else if (entry.killSwitch) {
      issues.push({ rule: 'R4', severity: 'warning', path: base, message: `"${m.type}" está apagado por DS (kill switch). No se mostrará hasta que lo reactiven.` });
    }

    // moduleKey único: es la llave de analytics
    if (m.moduleKey) {
      if (keys.has(m.moduleKey)) {
        issues.push({ rule: 'MOD', severity: 'error', path: `${base}.moduleKey`, message: `La clave "${m.moduleKey}" se repite. Cada módulo necesita una clave única.` });
      }
      keys.add(m.moduleKey);
    } else {
      issues.push({ rule: 'MOD', severity: 'error', path: `${base}.moduleKey`, message: 'Falta la clave del módulo (se usa para medirlo).' });
    }

    for (const field of REQUIRED_PROPS[m.type] ?? []) {
      if (field === 'image') continue; // se valida en checkImage
      if (isEmpty(props[field])) {
        issues.push({ rule: 'MOD', severity: 'error', path: `${base}.props.${field}`, message: `Falta el campo "${field}".` });
      }
    }

    // R3 · alt obligatorio
    if ('image' in props || REQUIRED_PROPS[m.type]?.includes('image')) {
      checkImage(issues, props.image, `${base}.props.image`, REQUIRED_PROPS[m.type]?.includes('image') ?? false);
    }
    if (m.fallbackImage) checkImage(issues, m.fallbackImage, `${base}.fallbackImage`, false);

    // R11 · longitudes
    for (const f of TITLE_FIELDS) {
      const v = props[f];
      if (typeof v === 'string' && v.length > LIMITS.maxTitleLength) {
        issues.push({
          rule: 'R11',
          severity: 'error',
          path: `${base}.props.${f}`,
          message: `El título tiene ${v.length} caracteres. Máximo ${LIMITS.maxTitleLength}: recórtalo para que no se trunque en pantalla.`,
        });
      }
    }
    const cta = props.cta as { label?: string; deeplink?: string } | undefined;
    if (cta && (cta.label || cta.deeplink)) {
      if (isEmpty(cta.label)) {
        issues.push({ rule: 'R11', severity: 'error', path: `${base}.props.cta.label`, message: 'El botón necesita un texto.' });
      } else if ((cta.label as string).length > LIMITS.maxCtaLength) {
        issues.push({
          rule: 'R11',
          severity: 'error',
          path: `${base}.props.cta.label`,
          message: `El texto del botón tiene ${(cta.label as string).length} caracteres. Máximo ${LIMITS.maxCtaLength}.`,
        });
      }
      // R10 · deeplink válido
      const err = deeplinkError(cta.deeplink);
      if (err) issues.push({ rule: 'R10', severity: 'error', path: `${base}.props.cta.deeplink`, message: err });
    }

    if (m.type === 'category-rail' && Array.isArray(props.categoryIds) && props.categoryIds.length > LIMITS.maxCategories) {
      issues.push({ rule: 'MOD', severity: 'error', path: `${base}.props.categoryIds`, message: `Máximo ${LIMITS.maxCategories} categorías.` });
    }
    if (m.type === 'product-carousel') {
      const src = props.source;
      const needs = src === 'collection' ? 'collectionId' : src === 'rule' ? 'ruleId' : src === 'recommendation' ? 'recommendationSlot' : null;
      if (needs && isEmpty(props[needs])) {
        issues.push({ rule: 'MOD', severity: 'error', path: `${base}.props.${needs}`, message: `Con la fuente "${String(src)}" necesitas indicar "${needs}".` });
      }
    }
  });

  // R5 · fechas
  const start = time(exp.startsAt);
  const end = time(exp.endsAt);
  if (exp.startsAt && start === null) issues.push({ rule: 'R5', severity: 'error', path: 'startsAt', message: 'La fecha de inicio no es válida.' });
  if (exp.endsAt && end === null) issues.push({ rule: 'R5', severity: 'error', path: 'endsAt', message: 'La fecha de fin no es válida.' });
  if (start !== null && end !== null && end <= start) {
    issues.push({ rule: 'R5', severity: 'error', path: 'endsAt', message: 'La campaña termina antes de empezar. La fecha de fin debe ser posterior al inicio.' });
  }
  if (start !== null && end === null && !exp.isFallback) {
    issues.push({ rule: 'R5', severity: 'error', path: 'endsAt', message: 'Una campaña necesita fecha de fin. Solo la experiencia base puede no tenerla.' });
  }

  // R12 (propuesta alfa) · la base nacional es única y siempre vigente
  if (exp.isFallback) {
    if ((exp.storeScope ?? []).length > 0) {
      issues.push({ rule: 'R12', severity: 'error', path: 'storeScope', message: 'La experiencia base debe ser nacional: deja vacío el alcance de tiendas.' });
    }
    if (exp.endsAt) {
      issues.push({ rule: 'R12', severity: 'error', path: 'endsAt', message: 'La experiencia base no puede tener fecha de fin: es lo que ve el cliente cuando nada más aplica.' });
    }
    const other = (ctx.others ?? []).find((o) => o.isFallback && o.id !== exp.id && (o.screen ?? 'home') === (exp.screen ?? 'home'));
    if (other) {
      issues.push({ rule: 'R12', severity: 'error', path: 'isFallback', message: `Ya existe una experiencia base ("${other.name ?? other.id}"). Solo puede haber una.` });
    }
  }

  // R6 · empate de prioridad (advertencia)
  for (const o of ctx.others ?? []) {
    if (o.id === exp.id || !exp.audience || !o.audience) continue;
    if (o.audience.id !== exp.audience.id) continue;
    if ((o.priority ?? 0) !== (exp.priority ?? 0)) continue;
    if (!sameSet((o.storeScope ?? []).map((s) => s.id), (exp.storeScope ?? []).map((s) => s.id))) continue;
    if (!modalitiesOverlap(o.modalities, exp.modalities)) continue;
    if (!overlaps(o, exp)) continue;
    issues.push({
      rule: 'R6',
      severity: 'warning',
      path: 'priority',
      message: `"${o.name ?? o.id}" tiene la misma audiencia, alcance y prioridad en fechas que se cruzan. Ganará la publicada más recientemente; sube la prioridad de la que deba ganar.`,
    });
  }

  return issues;
}

/** R10 · parte asíncrona: que el destino del deeplink exista (colección, SKU, categoría). */
export async function validateDeeplinkDestinations(
  exp: ExperienceDraft,
  checker: DestinationChecker,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const modules = exp.modules ?? [];
  for (let i = 0; i < modules.length; i++) {
    const cta = modules[i]?.props?.cta as { deeplink?: string } | undefined;
    const parsed = cta?.deeplink ? parseDeeplink(cta.deeplink) : null;
    if (parsed && !(await checker(parsed))) {
      issues.push({
        rule: 'R10',
        severity: 'error',
        path: `modules[${i}].props.cta.deeplink`,
        message: `El destino "${cta?.deeplink}" no existe o no está activo. Revisa el ID.`,
      });
    }
  }
  return issues;
}

/** minContractVersion = máximo de las versiones de los componentes usados (§6.1). */
export function computeMinContractVersion(modules: DraftModule[], registry: RegistryEntry[]): string {
  const byType = new Map(registry.map((r) => [r.type as string, r.version]));
  return maxSemver(modules.map((m) => byType.get(m.type) ?? '0.0.0'));
}

export function hasBlockingIssues(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
