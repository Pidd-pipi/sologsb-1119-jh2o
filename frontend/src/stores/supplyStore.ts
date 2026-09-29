import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { bumpStockVersion } from '../utils/stockSync';
import { lotAvailable, type SupplyIssue, type SupplyLot, type SupplyLotDraft } from '../types/supply';

export class SupplyIssueError extends Error {}

interface SupplyState {
  items: SupplyLot[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: SupplyLotDraft) => Promise<SupplyLot>;
  /** 手填领用：只能领用可用量（实物 - 已预占），不得占用其它排程的预占 */
  issue: (id: string, payload: Omit<SupplyIssue, 'id' | 'issuedAt'>) => Promise<void>;
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
    const record: SupplyLot = { ...draft, id: newId('sup'), reservedQty: 0, movements: [], issues: [] };
    await db.supplies.put(record);
    set({ items: [...get().items, record] });
    bumpStockVersion(`登记批次 ${record.name}（${record.lotNo}）`, '');
    return record;
  },
  async issue(id, payload) {
    await db.transaction('rw', db.supplies, async () => {
      const target = await db.supplies.get(id);
      if (!target) return;
      const available = lotAvailable(target);
      if (payload.qty <= 0 || payload.qty > available) {
        throw new SupplyIssueError(`可领用量仅 ${available} ${target.unit}（已预占 ${target.reservedQty ?? 0}）`);
      }
      const now = Date.now();
      const issue: SupplyIssue = { ...payload, id: newId('iss'), issuedAt: now };
      const next: SupplyLot = {
        ...target,
        qty: Math.round((target.qty - payload.qty) * 1000) / 1000,
        issues: [issue, ...target.issues],
        movements: [
          {
            id: newId('mov'),
            kind: 'issue',
            qty: payload.qty,
            operator: payload.operator,
            at: now,
            specimenNo: payload.specimenNo,
            note: '手填领用',
          },
          ...(target.movements ?? []),
        ],
      };
      await db.supplies.put(next);
      set({ items: get().items.map((it) => (it.id === id ? next : it)) });
    });
    bumpStockVersion('手填领用', payload.operator);
  },
  trace(lotNo) {
    if (!lotNo) return get().items;
    return get().items.filter((it) => it.lotNo.includes(lotNo) || it.name.includes(lotNo));
  },
}));
