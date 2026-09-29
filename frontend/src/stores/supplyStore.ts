import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { broadcastStockChanged } from '../utils/crossTab';
import type { StockMovement, SupplyLot, SupplyLotDraft } from '../types/supply';

interface SupplyState {
  items: SupplyLot[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: SupplyLotDraft) => Promise<SupplyLot>;
  /** 手工领用登记（在库减少，记一笔「领用」变动） */
  issue: (
    id: string,
    payload: { qty: number; operator: string; specimenNo?: string; note?: string },
  ) => Promise<void>;
  trace: (lotNo: string) => SupplyLot[];
}

export const useSupplyStore = create<SupplyState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = await db.supplies.toArray();
    items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    set({ items, loaded: true });
  },
  async add(draft) {
    const record: SupplyLot = { ...draft, id: newId('sup'), reservedQty: 0, movements: [] };
    await db.supplies.put(record);
    set({ items: [...get().items, record] });
    broadcastStockChanged();
    return record;
  },
  async issue(id, payload) {
    const target = get().items.find((it) => it.id === id);
    if (!target) return;
    const movement: StockMovement = {
      id: newId('mv'),
      type: 'issue',
      qty: payload.qty,
      operator: payload.operator,
      at: Date.now(),
      specimenNo: payload.specimenNo,
      note: payload.note,
    };
    const next: SupplyLot = {
      ...target,
      qty: Math.max(0, target.qty - payload.qty),
      movements: [movement, ...target.movements],
    };
    await db.supplies.put(next);
    set({ items: get().items.map((it) => (it.id === id ? next : it)) });
    broadcastStockChanged();
  },
  trace(lotNo) {
    if (!lotNo) return get().items;
    return get().items.filter((it) => it.lotNo.includes(lotNo) || it.name.includes(lotNo));
  },
}));
