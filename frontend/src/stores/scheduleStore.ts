import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { planAllocation } from '../utils/allocation';
import { bumpStockVersion } from '../utils/stockSync';
import type { PrepSchedule, ScheduleItem, ScheduleAllocation } from '../types/schedule';
import type { SupplyLot, SupplyMovement } from '../types/supply';

/** 确认时材料不足：整份排程保持原样，由调用方列出缺口 */
export class ScheduleStockError extends Error {
  shortages: ReturnType<typeof planAllocation>['shortages'];
  skippedExpired: SupplyLot[];
  constructor(shortages: ReturnType<typeof planAllocation>['shortages'], skippedExpired: SupplyLot[]) {
    super('材料不足，排程未做任何变更');
    this.name = 'ScheduleStockError';
    this.shortages = shortages;
    this.skippedExpired = skippedExpired;
  }
}

/** 重复确认 / 取消等非法状态流转：不产生第二次库存变化 */
export class ScheduleStateError extends Error {}

export interface ScheduleDraftInput {
  items: ScheduleItem[];
  operator: string;
  remark?: string;
}

interface ScheduleState2 {
  items: PrepSchedule[];
  loaded: boolean;
  load: () => Promise<void>;
  saveDraft: (id: string | undefined, input: ScheduleDraftInput) => Promise<PrepSchedule>;
  confirm: (id: string, operator: string, specimenNoOf: (sid: string) => string) => Promise<PrepSchedule>;
  issue: (id: string, operator: string) => Promise<PrepSchedule>;
  cancel: (id: string, operator: string) => Promise<PrepSchedule>;
  removeDraft: (id: string) => Promise<void>;
}

function scheduleSeqNo(count: number): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `PS-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${String(count + 1).padStart(3, '0')}`;
}

/** 给每个批次片段写定一条预占流水，并回写批次预占量（事务内执行） */
function buildReserve(args: {
  schedule: PrepSchedule;
  lotsById: Map<string, SupplyLot>;
  plan: ReturnType<typeof planAllocation>;
  operator: string;
}) {
  const { schedule, lotsById, plan, operator } = args;
  const now = Date.now();
  const allocations: ScheduleAllocation[] = [];
  const touchedLots: SupplyLot[] = [];

  for (const grouped of plan.allocations) {
    for (const slice of grouped.slices) {
      const lot = lotsById.get(slice.lotId);
      if (!lot) continue;
      const refId = newId('mov');
      const specimenNos = [...new Set(grouped.rows.map((r) => r.specimenNo))].join('、');
      const movement: SupplyMovement = {
        id: refId,
        kind: 'reserve',
        qty: slice.qty,
        operator,
        at: now,
        scheduleId: schedule.id,
        scheduleNo: schedule.scheduleNo,
        specimenNo: specimenNos,
        refId,
        note: `预占：${schedule.scheduleNo}`,
      };
      lot.reservedQty = Math.round((lot.reservedQty + slice.qty) * 1000) / 1000;
      lot.movements = [movement, ...lot.movements];
      touchedLots.push(lot);

      allocations.push({
        lotId: lot.id,
        lotNo: lot.lotNo,
        name: lot.name,
        unit: lot.unit,
        qty: slice.qty,
        refId,
        issuedQty: 0,
        returnedQty: 0,
      });
    }
  }

  return { allocations, touchedLots };
}

export const useScheduleStore = create<ScheduleState2>((set, get) => ({
  items: [],
  loaded: false,

  async load() {
    const items = await db.schedules.toArray();
    items.sort((a, b) => b.createdAt - a.createdAt);
    set({ items, loaded: true });
  },

  async saveDraft(id, input) {
    const existing = id ? await db.schedules.get(id) : undefined;
    if (existing && existing.state !== 'draft') {
      throw new ScheduleStateError('只有草稿排程可以编辑保存');
    }
    let record: PrepSchedule;
    if (existing) {
      record = { ...existing, ...input, state: 'draft' };
    } else {
      const count = await db.schedules.count();
      record = {
        id: newId('sch'),
        scheduleNo: scheduleSeqNo(count),
        state: 'draft',
        items: input.items,
        allocations: [],
        operator: input.operator,
        remark: input.remark,
        createdAt: Date.now(),
      };
    }
    // 草稿：只写排程表，绝不触碰库存
    await db.schedules.put(record);
    set({ items: [record, ...get().items.filter((it) => it.id !== record.id)] });
    return record;
  },

  async confirm(id, operator, specimenNoOf) {
    const { result, changed } = await db.transaction('rw', db.schedules, db.supplies, async () => {
      // 事务内重读，保证与库存写入原子且基于最新数据
      const schedule = await db.schedules.get(id);
      if (!schedule) throw new ScheduleStateError('排程不存在');
      if (schedule.state === 'confirmed' || schedule.state === 'issued') {
        // 重复确认：幂等返回，不产生第二次库存变化
        return { result: schedule, changed: false };
      }
      if (schedule.state !== 'draft') {
        throw new ScheduleStateError('当前排程状态不可确认');
      }

      const lots = await db.supplies.toArray();
      const plan = planAllocation(schedule.items, lots, specimenNoOf);
      if (!plan.ok) {
        // 材料不足：抛错使整个事务回滚，整份排程（含库存）保持原样
        throw new ScheduleStockError(plan.shortages, plan.skippedExpired);
      }

      const lotsById = new Map(lots.map((l) => [l.id, l]));
      const { allocations, touchedLots } = buildReserve({
        schedule,
        lotsById,
        plan,
        operator,
      });

      const next: PrepSchedule = {
        ...schedule,
        state: 'confirmed',
        allocations,
        operator: operator || schedule.operator,
        confirmedAt: Date.now(),
        skippedLotIds: plan.skippedExpired.map((l) => l.id),
      };
      await db.schedules.put(next);
      await Promise.all(touchedLots.map((lot) => db.supplies.put(lot)));
      return { result: next, changed: true };
    });

    if (changed) bumpStockVersion(`确认排程 ${result.scheduleNo}（预占）`, operator);
    await get().load();
    return result;
  },

  async issue(id, operator) {
    const { result, changed } = await db.transaction('rw', db.schedules, db.supplies, async () => {
      const schedule = await db.schedules.get(id);
      if (!schedule) throw new ScheduleStateError('排程不存在');
      if (schedule.state === 'issued') return { result: schedule, changed: false }; // 幂等
      if (schedule.state !== 'confirmed') throw new ScheduleStateError('只有已确认排程可以领用');

      const now = Date.now();
      const lotsById = new Map((await db.supplies.toArray()).map((l) => [l.id, l]));
      const allocations: ScheduleAllocation[] = [];
      const specimenNos = [...new Set(schedule.items.map((i) => i.specimenId))];

      for (const alloc of schedule.allocations) {
        const lot = lotsById.get(alloc.lotId);
        if (!lot) throw new ScheduleStateError(`批次 ${alloc.lotNo} 已不存在`);
        const remain = Math.round((alloc.qty - alloc.issuedQty - alloc.returnedQty) * 1000) / 1000;
        if (remain <= 0) {
          allocations.push(alloc);
          continue;
        }
        // 预占转领用：实物在库与预占量同步扣减，可用量不变
        lot.qty = Math.round((lot.qty - remain) * 1000) / 1000;
        lot.reservedQty = Math.round((lot.reservedQty - remain) * 1000) / 1000;
        const movement: SupplyMovement = {
          id: newId('mov'),
          kind: 'issue',
          qty: remain,
          operator,
          at: now,
          scheduleId: schedule.id,
          scheduleNo: schedule.scheduleNo,
          specimenNo: specimenNos.join('、') || '排程领用',
          refId: alloc.refId,
          note: `领用：${schedule.scheduleNo}（原预占批次 ${lot.lotNo}）`,
        };
        lot.movements = [movement, ...lot.movements];
        // 旧手填视图兼容
        lot.issues = [
          { id: newId('iss'), qty: remain, operator, specimenNo: movement.specimenNo, issuedAt: now },
          ...lot.issues,
        ];
        await db.supplies.put(lot);
        allocations.push({ ...alloc, issuedQty: Math.round((alloc.issuedQty + remain) * 1000) / 1000 });
      }

      const next: PrepSchedule = { ...schedule, state: 'issued', allocations, issuedAt: now };
      await db.schedules.put(next);
      return { result: next, changed: true };
    });

    if (changed) bumpStockVersion(`排程 ${result.scheduleNo} 领用`, operator);
    await get().load();
    return result;
  },

  async cancel(id, operator) {
    const { result, changed } = await db.transaction('rw', db.schedules, db.supplies, async () => {
      const schedule = await db.schedules.get(id);
      if (!schedule) throw new ScheduleStateError('排程不存在');
      if (schedule.state === 'cancelled') return { result: schedule, changed: false }; // 重复取消：幂等，库存不再变动
      if (schedule.state === 'draft') {
        // 草稿从未占用库存：直接取消，无任何库存变化
        const next: PrepSchedule = { ...schedule, state: 'cancelled', cancelledAt: Date.now() };
        await db.schedules.put(next);
        return { result: next, changed: false };
      }

      const now = Date.now();
      const lotsById = new Map((await db.supplies.toArray()).map((l) => [l.id, l]));
      const allocations: ScheduleAllocation[] = [];

      for (const alloc of schedule.allocations) {
        const lot = lotsById.get(alloc.lotId);
        if (!lot) throw new ScheduleStateError(`批次 ${alloc.lotNo} 已不存在`);
        const reservedRemain = Math.round((alloc.qty - alloc.issuedQty - alloc.returnedQty) * 1000) / 1000;
        const movements: SupplyMovement[] = [];

        // 1) 仍处于预占、尚未领用的部分：解除预占（实物未离库，在库量不变）
        if (reservedRemain > 0) {
          lot.reservedQty = Math.round((lot.reservedQty - reservedRemain) * 1000) / 1000;
          movements.push({
            id: newId('mov'),
            kind: 'release',
            qty: reservedRemain,
            operator,
            at: now,
            scheduleId: schedule.id,
            scheduleNo: schedule.scheduleNo,
            specimenNo: '排程取消',
            refId: alloc.refId,
            note: `取消排程 ${schedule.scheduleNo}：解除原批次 ${lot.lotNo} 的预占`,
          });
        }

        // 2) 已经领用的部分：按原批次实物退回，在库量回升
        let nextAlloc = alloc;
        if (alloc.issuedQty - alloc.returnedQty > 0) {
          const back = Math.round((alloc.issuedQty - alloc.returnedQty) * 1000) / 1000;
          lot.qty = Math.round((lot.qty + back) * 1000) / 1000;
          movements.push({
            id: newId('mov'),
            kind: 'return',
            qty: back,
            operator,
            at: now,
            scheduleId: schedule.id,
            scheduleNo: schedule.scheduleNo,
            specimenNo: '排程取消退回',
            refId: alloc.refId,
            note: `取消排程 ${schedule.scheduleNo}：按原批次 ${lot.lotNo} 退回`,
          });
          nextAlloc = { ...alloc, returnedQty: Math.round((alloc.returnedQty + back) * 1000) / 1000 };
        }
        allocations.push(nextAlloc);

        if (movements.length) {
          lot.movements = [...movements, ...lot.movements];
          await db.supplies.put(lot);
        }
      }

      const next: PrepSchedule = { ...schedule, state: 'cancelled', allocations, cancelledAt: now };
      await db.schedules.put(next);
      return { result: next, changed: true };
    });

    // 只有真正发生过退回/解除才广播；草稿取消与重复取消不重复记账
    if (changed) bumpStockVersion(`取消排程 ${result.scheduleNo}（按原批次退回）`, operator);
    await get().load();
    return result;
  },

  async removeDraft(id) {
    const schedule = await db.schedules.get(id);
    if (schedule && schedule.state !== 'draft') {
      throw new ScheduleStateError('只有草稿排程可以删除');
    }
    await db.schedules.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
}));
