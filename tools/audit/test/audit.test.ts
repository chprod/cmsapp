import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audit, parseCsv, type Request } from '../src/audit.ts';

function gen(n: number, opts: { slotsShare: number; releaseShare?: number; leadDays: number }): Request[] {
  const start = Date.parse('2026-06-01');
  return Array.from({ length: n }, (_, i) => {
    const requestedAt = new Date(start + Math.floor((i / n) * 90) * 86_400_000);
    return {
      id: `R${i}`,
      requestedAt,
      releasedAt: new Date(requestedAt.getTime() + opts.leadDays * 86_400_000),
      type: 'orden_modulos',
      neededRelease: i / n < (opts.releaseShare ?? 1),
      fitsFixedSlots: i / n < opts.slotsShare,
    };
  });
}

test('> 70% cabe en slots → slots fijos (§1.4)', () => {
  assert.equal(audit(gen(40, { slotsShare: 0.8, leadDays: 15 })).verdict, 'slots');
});

test('demanda alta, lento y > 70% fuera de slots → go', () => {
  assert.equal(audit(gen(40, { slotsShare: 0.2, leadDays: 15 })).verdict, 'go');
});

test('poca demanda → no-go', () => {
  assert.equal(audit(gen(20, { slotsShare: 0.1, leadDays: 15 })).verdict, 'no_go');
});

test('rápido (lead time bajo) → no-go', () => {
  assert.equal(audit(gen(40, { slotsShare: 0.1, leadDays: 4 })).verdict, 'no_go');
});

test('entre 30% y 70% fuera de slots → zona gris explícita (hueco entre §1.4 y §17)', () => {
  const r = audit(gen(40, { slotsShare: 0.5, leadDays: 15 }));
  assert.equal(r.verdict, 'zona_gris');
  assert.match(r.reasons.at(-1)!, /no define esta zona/);
});

test('menos de 3 meses de historia → datos insuficientes', () => {
  assert.equal(audit(gen(5, { slotsShare: 0.1, leadDays: 15 })).verdict, 'datos_insuficientes');
});

test('parseCsv: comillas, tipo desconocido e inferencia de slot', () => {
  const csv = 'id,fecha_solicitud,fecha_produccion,tipo,requirio_release,notas\nA,2026-06-01,2026-06-10,banner,si,"Hero, Día del Padre"\nB,2026-06-02,,raro,no,';
  const { requests, warnings } = parseCsv(csv);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.fitsFixedSlots, true);
  assert.equal(requests[1]!.type, 'otro');
  assert.equal(requests[1]!.releasedAt, null);
  assert.ok(warnings.some((w) => w.includes('desconocido')));
});

test('parseCsv exige columnas mínimas', () => {
  assert.throws(() => parseCsv('id,tipo\n1,banner'), /Faltan columnas/);
});
