/**
 * Elegibilidad de experiencias: qué Home le toca a este cliente, en esta tienda,
 * con esta modalidad, ahora. Pura y determinista: fácil de probar (§5.2).
 */
import { MODALITY_LABELS, evaluateRule, type CustomerContext, type Experience, type Modality } from '@chedraui-xp/contract';

export interface SelectionInput {
  experiences: Experience[];
  customer: CustomerContext;
  storeId: string | null;
  modality: Modality | null;
  now: Date;
}

export interface Candidate {
  experience: Experience;
  eligible: boolean;
  reason: string;
}

export interface Selection {
  experience: Experience;
  reason: string;
  candidates: Candidate[];
}

const DATE = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Mexico_City' });
const fmt = (iso: string) => DATE.format(new Date(iso));

function check(e: Experience, input: SelectionInput): { eligible: boolean; reason: string } {
  const t = input.now.getTime();
  if (e.screen !== 'home') return { eligible: false, reason: 'Otra pantalla' };
  if (e.startsAt && Date.parse(e.startsAt) > t) return { eligible: false, reason: `Empieza el ${fmt(e.startsAt)}` };
  if (e.endsAt && Date.parse(e.endsAt) <= t) return { eligible: false, reason: `Terminó el ${fmt(e.endsAt)}` };
  if (e.storeScope.length > 0) {
    if (!input.storeId) return { eligible: false, reason: 'Es por tienda y el cliente no ha elegido tienda' };
    if (!e.storeScope.some((s) => s.stores.includes(input.storeId as string))) {
      return { eligible: false, reason: `No aplica en la tienda ${input.storeId} (${e.storeScope.map((s) => s.name).join(', ')})` };
    }
  }
  const mods = e.modalities;
  if (mods.length > 0 && !mods.includes('todas') && (!input.modality || !mods.includes(input.modality))) {
    return { eligible: false, reason: `Solo para ${mods.map((m) => MODALITY_LABELS[m as Modality] ?? m).join(', ')}` };
  }
  if (!evaluateRule(e.audience.rule, input.customer)) {
    return { eligible: false, reason: `El cliente no está en "${e.audience.name}"` };
  }
  return { eligible: true, reason: `Cliente en "${e.audience.name}"` };
}

/**
 * Gana la de mayor `priority`; si empatan, la publicada más recientemente (§10).
 * Si ninguna aplica, la experiencia base (`isFallback`). Si tampoco hay base, null:
 * la app usará su caché o la Home embebida.
 */
export function selectExperience(input: SelectionInput): Selection | null {
  const candidates: Candidate[] = input.experiences.map((experience) => ({ experience, ...check(experience, input) }));
  const eligible = candidates
    .filter((c) => c.eligible)
    .sort(
      (a, b) =>
        b.experience.priority - a.experience.priority ||
        Date.parse(b.experience.publishedAt) - Date.parse(a.experience.publishedAt),
    );
  const winner = eligible[0];
  if (winner) {
    const tie = eligible[1] && eligible[1].experience.priority === winner.experience.priority;
    return {
      experience: winner.experience,
      reason: `Prioridad ${winner.experience.priority}${tie ? ' (empate: gana la publicada más reciente)' : ''} · ${winner.reason}`,
      candidates,
    };
  }
  const base = input.experiences.find((e) => e.isFallback && e.screen === 'home');
  if (!base) return null;
  return { experience: base, reason: 'Ninguna experiencia aplica: se usa la base nacional', candidates };
}

/**
 * Próximo instante en que la selección puede cambiar (fin de la actual o inicio de otra).
 * Sirve para que el TTL de caché nunca sobreviva a una campaña.
 */
export function nextBoundary(experiences: Experience[], current: Experience, now: Date): number | null {
  const t = now.getTime();
  const points = [
    current.endsAt ? Date.parse(current.endsAt) : null,
    ...experiences.map((e) => (e.startsAt ? Date.parse(e.startsAt) : null)),
    ...experiences.map((e) => (e.endsAt ? Date.parse(e.endsAt) : null)),
  ].filter((p): p is number => p !== null && p > t);
  return points.length ? Math.min(...points) : null;
}
