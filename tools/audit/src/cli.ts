#!/usr/bin/env node
/**
 * Uso: npm run audit:fase0 -- ruta/solicitudes.csv [--json]
 * Plantilla: tools/audit/solicitudes-plantilla.csv
 */
import { readFileSync } from 'node:fs';
import { audit, parseCsv } from './audit.ts';

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error('Uso: npm run audit:fase0 -- solicitudes.csv [--json]');
  process.exit(1);
}
const { requests, warnings } = parseCsv(readFileSync(file, 'utf8'));
const r = audit(requests, undefined, warnings);

if (flags.includes('--json')) {
  console.log(JSON.stringify(r, null, 2));
} else {
  const LABEL = { go: 'GO (condicionado a H3)', slots: 'SLOTS FIJOS', zona_gris: 'ZONA GRIS · decisión del equipo', no_go: 'NO-GO', datos_insuficientes: 'DATOS INSUFICIENTES' } as const;
  console.log(`\nAuditoría de solicitudes de Home · ${r.total} solicitudes en ${r.months} meses\n`);
  console.log(`  Cambios con release por mes   ${r.releaseChangesPerMonth}`);
  console.log(`  Lead time (días) p50/p75/p90  ${r.leadTimeDays.median ?? '—'} / ${r.leadTimeDays.p75 ?? '—'} / ${r.leadTimeDays.p90 ?? '—'}`);
  console.log(`  Nunca salieron                ${r.leadTimeDays.neverShipped}`);
  console.log(`  Caben en slots fijos          ${Math.round(r.shareFitsSlots * 100)}%`);
  console.log(`  Por tipo                      ${Object.entries(r.byType).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`\n  Recomendación: ${LABEL[r.verdict]}`);
  r.reasons.forEach((x) => console.log(`   - ${x}`));
  if (r.warnings.length) {
    console.log('\n  Avisos');
    r.warnings.slice(0, 10).forEach((x) => console.log(`   ! ${x}`));
    if (r.warnings.length > 10) console.log(`   … y ${r.warnings.length - 10} más`);
  }
  console.log('');
}
