/** Comparación semver mínima (major.minor.patch). Suficiente para versiones de app y de componente. */
export function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isSemver(v: unknown): v is string {
  return typeof v === 'string' && parseSemver(v) !== null;
}

/** -1 si a < b, 0 si iguales, 1 si a > b. Versiones inválidas se tratan como 0.0.0. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a) ?? [0, 0, 0];
  const pb = parseSemver(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const x = pa[i] as number;
    const y = pb[i] as number;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export function maxSemver(versions: string[]): string {
  return versions.reduce((acc, v) => (compareSemver(v, acc) > 0 ? v : acc), '0.0.0');
}

export function semverMajor(v: string): number {
  return parseSemver(v)?.[0] ?? 0;
}
