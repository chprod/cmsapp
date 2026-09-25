/**
 * Conectores en memoria sobre /fixtures. Permiten inyectar latencia y fallas
 * para probar los estados de §10 (conector caído, timeout) sin sistemas reales.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Modality, ProductItem } from '@chedraui-xp/contract';
import type { Category, Connectors, CustomerProfile, Placement, Store } from './types.ts';

interface RawProduct {
  sku: string;
  name: string;
  price: number;
  listPrice?: number;
  unitPrice: string;
  categories: string[];
  availability: Record<string, Modality[]>;
}

interface CatalogFile {
  products: RawProduct[];
  collections: { id: string; name: string; skus: string[] }[];
  categories: Category[];
  recommendations: Record<string, string[]>;
}

interface CustomerFile {
  customers: (CustomerProfile & { purchasedSkus: string[] })[];
}

export interface StoreFile {
  stores: Store[];
  segments: { id: string; name: string; zone: string; stores: string[] }[];
}

export type ConnectorName = 'catalog' | 'recommendations' | 'orders' | 'customers';

export interface FaultInjection {
  /** Conectores que fallan en cada llamada. */
  failing?: Set<ConnectorName>;
  /** Latencia artificial en ms por conector. */
  latencyMs?: Partial<Record<ConnectorName, number>>;
}

function readJson<T>(dir: string, file: string): T {
  return JSON.parse(readFileSync(join(dir, file), 'utf8')) as T;
}

export function isAvailable(p: RawProduct, at: Placement): boolean {
  if (!at.storeId) return Object.values(p.availability).some((m) => m.length > 0);
  const mods = p.availability[at.storeId] ?? [];
  return at.modality ? mods.includes(at.modality) : mods.length > 0;
}

function toItem(p: RawProduct, at: Placement): ProductItem {
  const discount = p.listPrice ? Math.round((1 - p.price / p.listPrice) * 100) : 0;
  return {
    sku: p.sku,
    name: p.name,
    image: { url: `https://cdn.chedraui.example/sku/${p.sku}.webp`, alt: p.name },
    available: isAvailable(p, at),
    price: {
      amount: p.price,
      currency: 'MXN',
      unitPrice: p.unitPrice,
      ...(p.listPrice ? { listAmount: p.listPrice } : {}),
    },
    deeplink: `chedraui://producto/${p.sku}`,
    ...(discount > 0 ? { badge: `-${discount}%` } : {}),
  };
}

export function createFixtureConnectors(dir: string, faults: () => FaultInjection = () => ({})): {
  connectors: Connectors;
  storeFile: StoreFile;
  customerFile: CustomerFile;
  catalogFile: CatalogFile;
} {
  const catalogFile = readJson<CatalogFile>(dir, 'catalog.json');
  const customerFile = readJson<CustomerFile>(dir, 'customers.json');
  const storeFile = readJson<StoreFile>(dir, 'stores.json');
  const bySku = new Map(catalogFile.products.map((p) => [p.sku, p]));

  async function gate(name: ConnectorName): Promise<void> {
    const f = faults();
    const ms = f.latencyMs?.[name] ?? 0;
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    if (f.failing?.has(name)) throw new Error(`${name}_unavailable`);
  }

  const items = (skus: string[], at: Placement) =>
    skus.flatMap((s) => {
      const p = bySku.get(s);
      return p ? [toItem(p, at)] : [];
    });

  const connectors: Connectors = {
    customers: {
      async get(id) {
        await gate('customers');
        const c = customerFile.customers.find((x) => x.id === id);
        if (!c) return null;
        const { purchasedSkus: _omit, ...profile } = c;
        return profile;
      },
    },
    stores: {
      async get(id) {
        return storeFile.stores.find((s) => s.id === id) ?? null;
      },
      async list() {
        return storeFile.stores;
      },
    },
    catalog: {
      async collection(id, at) {
        await gate('catalog');
        const col = catalogFile.collections.find((c) => c.id === id);
        if (!col) throw new Error(`collection_not_found:${id}`);
        return items(col.skus, at);
      },
      async categories(ids) {
        await gate('catalog');
        return ids.flatMap((id) => catalogFile.categories.filter((c) => c.id === id));
      },
      async exists(kind, id) {
        if (kind === 'coleccion') return catalogFile.collections.some((c) => c.id === id);
        if (kind === 'producto') return bySku.has(id);
        return catalogFile.categories.some((c) => c.id === id);
      },
    },
    recommendations: {
      async slot(slot, _customerId, at) {
        await gate('recommendations');
        const skus = catalogFile.recommendations[slot];
        if (!skus) throw new Error(`reco_slot_not_found:${slot}`);
        return items(skus, at);
      },
    },
    orders: {
      async buyAgain(customerId, at) {
        await gate('orders');
        const c = customerFile.customers.find((x) => x.id === customerId);
        return items(c?.purchasedSkus ?? [], at);
      },
    },
  };

  return { connectors, storeFile, customerFile, catalogFile };
}
