/**
 * Reglas de audiencia (PRD §6.4).
 *
 * El editor nunca ve ni escribe la expresión: la construye Growth/Data con
 * Atributo · Condición · Valor, y el sistema genera la descripción en español.
 * Este módulo es la única implementación: la usan Strapi (validar y describir)
 * y el Resolver (evaluar).
 */
import { MODALITIES, MODALITY_LABELS, PLATFORMS, type Modality, type Platform } from './tokens.ts';
import { compareSemver, isSemver } from './semver.ts';

/** Lo que el Resolver sabe del cliente en el momento de resolver. */
export interface CustomerContext {
  /** null = sesión anónima */
  customerId: string | null;
  orderCount: number | null;
  daysSinceLastOrder: number | null;
  loyaltyMember: boolean | null;
  platform: Platform;
  appVersion: string;
  preferredModality: Modality | null;
  hasActiveOrder?: boolean;
  shoppingListCount?: number;
}

type NumberOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
type EnumOp = 'in' | 'not_in';
type BoolOp = 'is';
type SemverOp = 'gte' | 'lt';
export type Operator = NumberOp | EnumOp | BoolOp | SemverOp;

interface AttributeDef {
  label: string;
  kind: 'number' | 'boolean' | 'enum' | 'semver';
  operators: readonly Operator[];
  options?: readonly string[];
  optionLabels?: Record<string, string>;
  /** Cómo nombrar al cliente cuando la condición se cumple, para la descripción. */
  unit?: string;
}

/** Atributos permitidos. Agregar uno nuevo = cambio de contrato revisado por Data. */
export const ATTRIBUTES = {
  orderCount: {
    label: 'Número de pedidos',
    kind: 'number',
    operators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
    unit: 'pedidos',
  },
  daysSinceLastOrder: {
    label: 'Días desde su último pedido',
    kind: 'number',
    operators: ['gt', 'gte', 'lt', 'lte'],
    unit: 'días',
  },
  loyaltyMember: {
    label: 'Socio del programa de lealtad',
    kind: 'boolean',
    operators: ['is'],
  },
  platform: {
    label: 'Plataforma',
    kind: 'enum',
    operators: ['in', 'not_in'],
    options: PLATFORMS,
    optionLabels: { ios: 'iOS', android: 'Android' },
  },
  appVersion: {
    label: 'Versión de la app',
    kind: 'semver',
    operators: ['gte', 'lt'],
  },
  preferredModality: {
    label: 'Modalidad preferida',
    kind: 'enum',
    operators: ['in', 'not_in'],
    options: MODALITIES,
    optionLabels: MODALITY_LABELS,
  },
} as const satisfies Record<string, AttributeDef>;

export type Attribute = keyof typeof ATTRIBUTES;

export const OPERATOR_LABELS: Record<Operator, string> = {
  eq: 'es igual a',
  neq: 'es distinto de',
  gt: 'es mayor que',
  gte: 'es mayor o igual a',
  lt: 'es menor que',
  lte: 'es menor o igual a',
  in: 'es alguna de',
  not_in: 'no es ninguna de',
  is: 'es',
};

export interface Condition {
  attribute: Attribute;
  operator: Operator;
  value: number | boolean | string | string[];
}

/** `match: all` = Y lógico, `match: any` = O lógico. Sin condiciones = todos los clientes. */
export interface AudienceRule {
  match: 'all' | 'any';
  conditions: Condition[];
}

export const EVERYONE: AudienceRule = { match: 'all', conditions: [] };

export interface RuleIssue {
  path: string;
  message: string;
}

/** Valida forma y tipos. Devuelve mensajes en español para mostrar en Strapi. */
export function validateRule(input: unknown): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return [{ path: 'rule', message: 'La regla debe ser un objeto con "match" y "conditions".' }];
  }
  const rule = input as Partial<AudienceRule>;
  if (rule.match !== 'all' && rule.match !== 'any') {
    issues.push({ path: 'rule.match', message: 'Indica si se deben cumplir todas ("all") o alguna ("any") de las condiciones.' });
  }
  if (!Array.isArray(rule.conditions)) {
    issues.push({ path: 'rule.conditions', message: 'Las condiciones deben ser una lista (vacía = todos los clientes).' });
    return issues;
  }
  rule.conditions.forEach((c, i) => {
    const path = `rule.conditions[${i}]`;
    const def = c && (ATTRIBUTES as Record<string, AttributeDef>)[c.attribute];
    if (!def) {
      issues.push({ path, message: `Atributo no permitido: "${c?.attribute}". Usa uno de: ${Object.keys(ATTRIBUTES).join(', ')}.` });
      return;
    }
    if (!def.operators.includes(c.operator)) {
      issues.push({ path, message: `"${def.label}" no admite la condición "${c.operator}".` });
      return;
    }
    const v = c.value;
    switch (def.kind) {
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) issues.push({ path, message: `"${def.label}" necesita un número mayor o igual a 0.` });
        break;
      case 'boolean':
        if (typeof v !== 'boolean') issues.push({ path, message: `"${def.label}" necesita sí o no.` });
        break;
      case 'semver':
        if (!isSemver(v)) issues.push({ path, message: `"${def.label}" necesita una versión con formato 7.2.0.` });
        break;
      case 'enum': {
        const values = Array.isArray(v) ? v : [];
        if (values.length === 0 || values.some((x) => !def.options?.includes(x))) {
          issues.push({ path, message: `"${def.label}" necesita uno o más valores de: ${def.options?.join(', ')}.` });
        }
        break;
      }
    }
  });
  return issues;
}

function evaluateCondition(c: Condition, ctx: CustomerContext): boolean {
  const actual = ctx[c.attribute];
  // Dato desconocido (p. ej. cliente anónimo) = la condición NO se cumple.
  // Preferimos no mostrar un módulo segmentado a mostrarlo a quien no aplica.
  if (actual === null || actual === undefined) return false;
  switch (c.operator) {
    case 'eq': return actual === c.value;
    case 'neq': return actual !== c.value;
    case 'is': return actual === c.value;
    case 'in': return Array.isArray(c.value) && c.value.includes(String(actual));
    case 'not_in': return Array.isArray(c.value) && !c.value.includes(String(actual));
    case 'gt': return typeof actual === 'number' && actual > (c.value as number);
    case 'lt':
      if (c.attribute === 'appVersion') return compareSemver(String(actual), String(c.value)) < 0;
      return typeof actual === 'number' && actual < (c.value as number);
    case 'gte':
      if (c.attribute === 'appVersion') return compareSemver(String(actual), String(c.value)) >= 0;
      return typeof actual === 'number' && actual >= (c.value as number);
    case 'lte': return typeof actual === 'number' && actual <= (c.value as number);
  }
}

export function evaluateRule(rule: AudienceRule | null | undefined, ctx: CustomerContext): boolean {
  if (!rule || rule.conditions.length === 0) return true;
  return rule.match === 'all'
    ? rule.conditions.every((c) => evaluateCondition(c, ctx))
    : rule.conditions.some((c) => evaluateCondition(c, ctx));
}

function describeCondition(c: Condition): string {
  const def = ATTRIBUTES[c.attribute] as AttributeDef;
  const label = (x: string) => def.optionLabels?.[x] ?? x;
  switch (c.attribute) {
    case 'orderCount':
      if (c.operator === 'eq' && c.value === 0) return 'sin pedidos';
      if (c.operator === 'gte' && c.value === 1) return 'con al menos 1 pedido';
      break;
    case 'loyaltyMember':
      return c.value ? 'socios del programa de lealtad' : 'que no son socios del programa de lealtad';
    case 'daysSinceLastOrder':
      if (c.operator === 'gt' || c.operator === 'gte') return `que no compran hace ${c.operator === 'gt' ? 'más de' : 'al menos'} ${c.value} días`;
      return `que compraron en los últimos ${c.value} días`;
  }
  if (def.kind === 'enum') {
    const values = (c.value as string[]).map(label).join(' o ');
    return c.operator === 'in' ? `con ${def.label.toLowerCase()} ${values}` : `con ${def.label.toLowerCase()} distinta de ${values}`;
  }
  if (def.kind === 'semver') {
    return c.operator === 'gte' ? `con la app ${c.value} o más reciente` : `con una versión de app anterior a ${c.value}`;
  }
  return `con ${def.label.toLowerCase()} que ${OPERATOR_LABELS[c.operator]} ${String(c.value)}${def.unit ? ` ${def.unit}` : ''}`;
}

/**
 * Descripción legible, en español, generada desde la regla.
 * Ej.: "Clientes sin pedidos y socios del programa de lealtad".
 * Se guarda en Strapi como `ruleSummary` (solo lectura) para que la descripción
 * nunca contradiga a la regla real.
 */
export function describeRule(rule: AudienceRule | null | undefined): string {
  if (!rule || rule.conditions.length === 0) return 'Todos los clientes';
  const parts = rule.conditions.map(describeCondition);
  const joiner = rule.match === 'all' ? ' y ' : ' o ';
  return `Clientes ${parts.join(joiner)}`;
}
