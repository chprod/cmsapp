/**
 * Fase 0 · Semana 1 · Auditoría de solicitudes de cambio a la Home (PRD §1.2, §1.4, §17).
 *
 * Entrada: CSV con una fila por solicitud. Salida: métricas y una recomendación
 * Go / Slots fijos / Zona gris / No-go con la regla que la produjo.
 *
 * Nota: el PRD tiene dos umbrales que no coinciden (§1.4 vs §17). Ver `decide()`.
 */

export const REQUEST_TYPES = [
  'banner',
  'fechas_campana',
  'orden_modulos',
  'segmentacion_tienda',
  'segmentacion_audiencia',
  'carrusel_productos',
  'nuevo_modulo',
  'otro',
] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

/** Tipos que un layout fijo con slots administrables (Hero, Promo, Carrusel curado) resuelve. */
const SLOT_FRIENDLY: ReadonlySet<string> = new Set(['banner', 'fechas_campana', 'carrusel_productos']);

export interface Request {
  id: string;
  requestedAt: Date;
  /** null = nunca salió */
  releasedAt: Date | null;
  type: RequestType;
  neededRelease: boolean;
  fitsFixedSlots: boolean;
}

export interface Thresholds {
  /** H1: cambios por mes que requieren release */
  minReleaseChangesPerMonth: number;
  /** H1: lead time mediano en días */
  minMedianLeadTimeDays: number;
  /** §1.4: si más de este % cabe en slots fijos → slots */
  slotsShareToArchive: number;
  /** §17: para Go, más de este % debe quedar FUERA de slots fijos */
  outsideSlotsShareToGo: number;
}

export const PRD_THRESHOLDS: Thresholds = {
  minReleaseChangesPerMonth: 8,
  minMedianLeadTimeDays: 10,
  slotsShareToArchive: 0.7,
  outsideSlotsShareToGo: 0.7,
};

export interface AuditResult {
  total: number;
  months: number;
  releaseChangesPerMonth: number;
  leadTimeDays: { median: number | null; p75: number | null; p90: number | null; neverShipped: number };
  shareFitsSlots: number;
  byType: Record<string, number>;
  verdict: 'go' | 'slots' | 'zona_gris' | 'no_go' | 'datos_insuficientes';
  reasons: string[];
  warnings: string[];
}

const YES = new Set(['si', 'sí', 'yes', 'true', '1', 'x']);

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseCsv(text: string): { requests: Request[]; warnings: string[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = splitCsvLine(lines.shift() ?? '').map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const need = ['id', 'fecha_solicitud', 'fecha_produccion', 'tipo', 'requirio_release'];
  const missing = need.filter((n) => col(n) < 0);
  if (missing.length) throw new Error(`Faltan columnas: ${missing.join(', ')}`);
  const warnings: string[] = [];
  const requests: Request[] = [];
  lines.forEach((line, i) => {
    const c = splitCsvLine(line);
    const get = (n: string) => (col(n) >= 0 ? (c[col(n)] ?? '') : '');
    const requestedAt = new Date(get('fecha_solicitud'));
    if (Number.isNaN(requestedAt.getTime())) {
      warnings.push(`Fila ${i + 2}: fecha_solicitud inválida, se omite.`);
      return;
    }
    const rel = get('fecha_produccion');
    const releasedAt = rel ? new Date(rel) : null;
    let type = get('tipo').toLowerCase() as RequestType;
    if (!REQUEST_TYPES.includes(type)) {
      warnings.push(`Fila ${i + 2}: tipo "${type}" desconocido, se cuenta como "otro".`);
      type = 'otro';
    }
    const slotRaw = get('cabe_en_slot_fijo').toLowerCase();
    requests.push({
      id: get('id') || `fila-${i + 2}`,
      requestedAt,
      releasedAt: releasedAt && !Number.isNaN(releasedAt.getTime()) ? releasedAt : null,
      type,
      neededRelease: YES.has(get('requirio_release').toLowerCase()),
      // Si nadie clasificó la fila, se infiere por tipo (y se avisa).
      fitsFixedSlots: slotRaw ? YES.has(slotRaw) : SLOT_FRIENDLY.has(type),
    });
    if (!slotRaw) warnings.push(`Fila ${i + 2}: sin "cabe_en_slot_fijo"; se infirió por tipo (${type}).`);
  });
  return { requests, warnings };
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return +((sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo)).toFixed(1));
}

export function audit(requests: Request[], t: Thresholds = PRD_THRESHOLDS, extraWarnings: string[] = []): AuditResult {
  const warnings = [...extraWarnings];
  const total = requests.length;
  const times = requests.map((r) => r.requestedAt.getTime());
  const spanDays = total ? (Math.max(...times) - Math.min(...times)) / 86_400_000 : 0;
  const months = Math.max(1, +(spanDays / 30.44).toFixed(1));
  const release = requests.filter((r) => r.neededRelease);
  const lead = release
    .filter((r) => r.releasedAt)
    .map((r) => (r.releasedAt!.getTime() - r.requestedAt.getTime()) / 86_400_000)
    .sort((a, b) => a - b);
  const byType: Record<string, number> = {};
  requests.forEach((r) => (byType[r.type] = (byType[r.type] ?? 0) + 1));

  const result: AuditResult = {
    total,
    months,
    releaseChangesPerMonth: +(release.length / months).toFixed(1),
    leadTimeDays: { median: quantile(lead, 0.5), p75: quantile(lead, 0.75), p90: quantile(lead, 0.9), neverShipped: release.filter((r) => !r.releasedAt).length },
    shareFitsSlots: total ? +(requests.filter((r) => r.fitsFixedSlots).length / total).toFixed(3) : 0,
    byType,
    verdict: 'datos_insuficientes',
    reasons: [],
    warnings,
  };
  if (total < 10 || spanDays < 60) {
    result.reasons.push(`Solo ${total} solicitudes en ${Math.round(spanDays)} días. El PRD pide 3 meses de historia.`);
    return result;
  }
  if (result.leadTimeDays.neverShipped > 0) {
    warnings.push(`${result.leadTimeDays.neverShipped} solicitudes nunca salieron: el lead time real es peor que la mediana.`);
  }
  return decide(result, t);
}

/**
 * Regla de decisión.
 * §1.4: si > 70% cabe en slots fijos → slots.
 * §17: Go requiere > 8 cambios/mes con release Y > 70% FUERA de slots.
 * Entre 30% y 70% fuera de slots ninguna regla del PRD aplica: "zona gris" explícita,
 * para que el equipo la decida con criterio y no por omisión.
 */
export function decide(r: AuditResult, t: Thresholds): AuditResult {
  const outside = 1 - r.shareFitsSlots;
  const demand = r.releaseChangesPerMonth > t.minReleaseChangesPerMonth;
  const slow = (r.leadTimeDays.median ?? 0) > t.minMedianLeadTimeDays;
  r.reasons.push(
    `${r.releaseChangesPerMonth} cambios/mes con release (umbral > ${t.minReleaseChangesPerMonth}): ${demand ? 'cumple' : 'no cumple'}.`,
    `Lead time mediano ${r.leadTimeDays.median ?? '—'} días (umbral > ${t.minMedianLeadTimeDays}): ${slow ? 'cumple' : 'no cumple'}.`,
    `${Math.round(r.shareFitsSlots * 100)}% de las solicitudes cabe en slots fijos.`,
  );
  if (r.shareFitsSlots > t.slotsShareToArchive) {
    r.verdict = 'slots';
    r.reasons.push('Más del 70% cabe en slots fijos → construir slots administrables + Remote Config y archivar el PRD (§1.4).');
  } else if (!demand || !slow) {
    r.verdict = 'no_go';
    r.reasons.push('La demanda o el dolor no alcanzan el umbral de H1: no se justifica un renderer genérico.');
  } else if (outside > t.outsideSlotsShareToGo) {
    r.verdict = 'go';
    r.reasons.push('H1 se cumple. Go condicionado al spike técnico (H3) y a la prueba de usabilidad del Studio.');
  } else {
    r.verdict = 'zona_gris';
    r.reasons.push(
      `H1 se cumple pero solo ${Math.round(outside * 100)}% queda fuera de slots: el PRD no define esta zona (§1.4 vs §17). ` +
        'Opción sugerida: slots fijos ahora + Resolver con elegibilidad por tienda/modalidad, y renderer genérico después.',
    );
  }
  return r;
}
