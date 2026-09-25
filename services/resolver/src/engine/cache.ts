/**
 * Caché en memoria con TTL para la parte NO personalizada (catálogo por tienda × modalidad).
 * En producción esta capa es CDN + Redis por segmento (§5.1); la interfaz es la misma.
 */
export class TtlCache<V> {
  private readonly store = new Map<string, { value: V; expires: number }>();
  hits = 0;
  misses = 0;

  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs: number, maxEntries = 5000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string, now = Date.now()): V | undefined {
    const e = this.store.get(key);
    if (!e || e.expires <= now) {
      if (e) this.store.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return e.value;
  }

  set(key: string, value: V, now = Date.now()): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expires: now + this.ttlMs });
  }

  clear(): number {
    const n = this.store.size;
    this.store.clear();
    return n;
  }

  get size(): number {
    return this.store.size;
  }
}
