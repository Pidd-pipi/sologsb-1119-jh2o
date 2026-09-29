import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { broadcastStockChanged } from '../utils/crossTab';
import { allocateMaterials, aggregateDemand } from '../utils/allocate';
import type { Reservation, ReservationItem, ReservationShortage } from '../types/reservation';
import type { SupplyLot } from '../types/supply';
import { useSupplyStore } from './supplyStore';

export interface ReservationInput {
  operator: string;
  items: Omit<ReservationItem, 'id'>[];
  note?: string;
}

export interface ConfirmResult {
  ok: boolean;
  /** 材料不足时的缺口清单（整份不动） */
  shortages?: ReservationShortage[];
  /** 重复确认已确认排程时返回 true，不重复记账 */
  alreadyConfirmed?: boolean;
}

interface ReservationState {
  items: Reservation[];
  loaded: boolean;
  load: () => Promise<void>;
  /** 保存草稿：不动库存 */
  saveDraft: (input: ReservationInput) => Promise<Reservation>;
  /** 确认排程：按临期优先分配批次并预占；材料不足整份不动、仅列缺口 */
  confirm: (id: string) => Promise<ConfirmResult>;
  /** 取消已确认排程：按原批次退回预占；重复取消只记一次 */
  cancel: (id: string) => Promise<void>;
  /** 删除草稿（已确认/已取消排程保留作追溯，不可删） */
  remove: (id: string) => Promise<void>;
}

function genCode(existing: Reservation[]): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const seq = existing.filter((r) => r.code.includes(stamp)).length + 1;
  return `RES-${stamp}-${p(seq)}`;
}

export const useReservationStore = create<ReservationState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = await db.reservations.toArray();
    items.sort((a, b) => b.createdAt - a.createdAt);
    set({ items, loaded: true });
  },
  async saveDraft(input) {
    const now = Date.now();
    const record: Reservation = {
      id: newId('res'),
      code: genCode(get().items),
      status: 'draft',
      operator: input.operator.trim(),
      createdAt: now,
      updatedAt: now,
      items: input.items.map((it) => ({ ...it, id: newId('rit') })),
      allocations: [],
      shortages: [],
      note: input.note?.trim() || undefined,
    };
    await db.reservations.put(record);
    set({ items: [record, ...get().items] });
    return record;
  },
  async confirm(id) {
    const reservation = await db.reservations.get(id);
    if (!reservation) return { ok: false };
    // 幂等：已确认排程重复确认不重复记账
    if (reservation.status === 'confirmed') return { ok: true, alreadyConfirmed: true };
    if (reservation.status === 'cancelled') return { ok: false };

    const lots = await db.supplies.toArray();
    const demand = aggregateDemand(reservation.items);
    const result = allocateMaterials(lots, demand);

    if (!result.ok) {
      // 材料不足：整份排程保持原样（库存不动），仅把缺口记到排程单上
      const updated: Reservation = { ...reservation, updatedAt: Date.now(), shortages: result.shortages };
      await db.reservations.put(updated);
      set({ items: get().items.map((it) => (it.id === id ? updated : it)) });
      return { ok: false, shortages: result.shortages };
    }

    const now = Date.now();
    const lotById = new Map(lots.map((l) => [l.id, l]));
    await db.transaction('rw', db.supplies, db.reservations, async () => {
      for (const alloc of result.allocations) {
        const lot = lotById.get(alloc.lotId);
        if (!lot) continue;
        const updatedLot: SupplyLot = {
          ...lot,
          reservedQty: lot.reservedQty + alloc.qty,
          movements: [
            {
              id: newId('mv'),
              type: 'reserve',
              qty: alloc.qty,
              operator: reservation.operator,
              at: now,
              reservationId: reservation.id,
              specimenNo: reservation.items.map((i) => i.specimenNo).join('、'),
              note: `排程 ${reservation.code} 预占`,
            },
            ...lot.movements,
          ],
        };
        await db.supplies.put(updatedLot);
        lotById.set(alloc.lotId, updatedLot);
      }
      const updated: Reservation = {
        ...reservation,
        status: 'confirmed',
        updatedAt: now,
        allocations: result.allocations,
        shortages: [],
      };
      await db.reservations.put(updated);
    });

    const updated = await db.reservations.get(id);
    set({ items: get().items.map((it) => (it.id === id ? updated! : it)) });
    await useSupplyStore.getState().load();
    broadcastStockChanged();
    return { ok: true };
  },
  async cancel(id) {
    const reservation = await db.reservations.get(id);
    if (!reservation) return;
    // 幂等：仅已确认排程需要退回；草稿/已取消直接返回，不重复记账
    if (reservation.status !== 'confirmed') return;

    const now = Date.now();
    const lots = await db.supplies.toArray();
    const lotById = new Map(lots.map((l) => [l.id, l]));
    await db.transaction('rw', db.supplies, db.reservations, async () => {
      for (const alloc of reservation.allocations) {
        const lot = lotById.get(alloc.lotId);
        if (!lot) continue;
        const updatedLot: SupplyLot = {
          ...lot,
          reservedQty: Math.max(0, lot.reservedQty - alloc.qty),
          movements: [
            {
              id: newId('mv'),
              type: 'return',
              qty: alloc.qty,
              operator: reservation.operator,
              at: now,
              reservationId: reservation.id,
              note: `排程 ${reservation.code} 取消退回`,
            },
            ...lot.movements,
          ],
        };
        await db.supplies.put(updatedLot);
        lotById.set(alloc.lotId, updatedLot);
      }
      const updated: Reservation = { ...reservation, status: 'cancelled', updatedAt: now };
      await db.reservations.put(updated);
    });

    const updated = await db.reservations.get(id);
    set({ items: get().items.map((it) => (it.id === id ? updated! : it)) });
    await useSupplyStore.getState().load();
    broadcastStockChanged();
  },
  async remove(id) {
    const reservation = await db.reservations.get(id);
    // 仅草稿可删；已确认/已取消排程保留作库存追溯
    if (!reservation || reservation.status !== 'draft') return;
    await db.reservations.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
}));
