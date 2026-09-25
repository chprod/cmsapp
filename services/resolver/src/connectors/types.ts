/**
 * Puertos hacia los sistemas fuente (§5). En la alfa se implementan con fixtures;
 * en Fase 1 se reemplazan por adaptadores a VTEX, OMS, Reco y Lealtad sin tocar el motor.
 */
import type { Modality, ProductItem } from '@chedraui-xp/contract';

export interface CustomerProfile {
  id: string;
  persona?: string;
  orderCount: number;
  daysSinceLastOrder: number | null;
  loyaltyMember: boolean;
  preferredModality: Modality | null;
  activeOrder: { id: string; status: string; statusLabel: string; eta: string } | null;
  lists: { id: string; name: string; items: number }[];
  loyaltyPoints: number;
}

export interface Store {
  id: string;
  name: string;
  city: string;
  zone: string;
  modalities: Modality[];
}

export interface Category {
  id: string;
  name: string;
  emoji?: string;
}

/** storeId null = sin tienda elegida: disponibilidad = disponible en al menos una tienda. */
export interface Placement {
  storeId: string | null;
  modality: Modality | null;
}

export interface Connectors {
  customers: { get(id: string): Promise<CustomerProfile | null> };
  stores: { get(id: string): Promise<Store | null>; list(): Promise<Store[]> };
  catalog: {
    collection(id: string, at: Placement): Promise<ProductItem[]>;
    categories(ids: string[]): Promise<Category[]>;
    /** Existe el destino de un deeplink (R10, lado Studio). */
    exists(kind: 'coleccion' | 'producto' | 'categoria', id: string): Promise<boolean>;
  };
  recommendations: { slot(slot: string, customerId: string | null, at: Placement): Promise<ProductItem[]> };
  orders: { buyAgain(customerId: string, at: Placement): Promise<ProductItem[]> };
}
