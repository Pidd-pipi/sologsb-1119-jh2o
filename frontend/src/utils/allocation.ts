import { lotExpireAt, lotAvailable, type SupplyLot } from '../types/supply';
import type { MaterialNeed, ScheduleItem } from '../types/schedule';

/** 一条候选批次可承担的分配片段 */
export interface AllocationSlice {
  lotId: string;
  lotNo: string;
  name: string;
  unit: string;
  qty: number;
  /** 剩余保质期天数，便于展示 */
  leftDays: number;
  /** 按可用量（qty - reservedQty）参与分配 */
  available: number;
}

export interface AllocationPlanResult {
  needs: MaterialNeed[];
  /** 按材料聚合的完整分配（材料内部临期优先） */
  allocations: Array<MaterialNeed & { slices: AllocationSlice[] }>;
  /** 缺口：需求未被满足的部分 */
  shortages: Array<MaterialNeed & { missingQty: number }>;
  /** 同名但已过期、被跳过的批次（透明提示，不参与占用） */
  skippedExpired: SupplyLot[];
  /** 是否全部满足（无缺口方可确认） */
  ok: boolean;
}

/** 聚合计划项的材料需求：同名同单位合并，数量相加 */
export function aggregateNeeds(items: ScheduleItem[], specimenNoOf: (id: string) => string): MaterialNeed[] {
  const map = new Map<string, MaterialNeed>();
  for (const item of items) {
    const specimenNo = specimenNoOf(item.specimenId) || '未关联标本';
    for (const m of item.materials) {
      if (!m.qty || m.qty <= 0) continue;
      const key = `${m.name}@@${m.unit}`;
      const exist = map.get(key);
      if (exist) {
        exist.qty += m.qty;
        exist.rows.push({ specimenNo, nodeName: item.nodeName, qty: m.qty });
      } else {
        map.set(key, { name: m.name, unit: m.unit, qty: m.qty, rows: [{ specimenNo, nodeName: item.nodeName, qty: m.qty }] });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 计算 FEFO 分配计划：
 * 1. 同名、同单位、未过期的批次，按到期时间从早到晚（临期优先），到期相同按批号；
 * 2. 逐批扣可用量（qty - reservedQty），直到需求满足；
 * 3. 已过期批次整体跳过并单独列出；
 * 4. 任一种材料不足都在 shortages 报缺口，调用方必须整份排程维持原样。
 */
export function planAllocation(items: ScheduleItem[], lots: SupplyLot[], specimenNoOf: (id: string) => string, now = Date.now()): AllocationPlanResult {
  const needs = aggregateNeeds(items, specimenNoOf);
  const allocations: AllocationPlanResult['allocations'] = [];
  const shortages: AllocationPlanResult['shortages'] = [];
  const skippedExpired: SupplyLot[] = [];

  for (const need of needs) {
    const candidates = lots
      .filter((lot) => lot.name === need.name && lot.unit === need.unit)
      .sort((a, b) => lotExpireAt(a) - lotExpireAt(b) || a.lotNo.localeCompare(b.lotNo));

    let remain = need.qty;
    const slices: AllocationSlice[] = [];

    for (const lot of candidates) {
      if (lotExpireAt(lot) < now) {
        if (!skippedExpired.some((s) => s.id === lot.id)) skippedExpired.push(lot);
        continue;
      }
      const available = lotAvailable(lot);
      if (available <= 0) continue;
      if (remain <= 0) break;
      const take = Math.min(available, remain);
      slices.push({
        lotId: lot.id,
        lotNo: lot.lotNo,
        name: lot.name,
        unit: lot.unit,
        qty: take,
        leftDays: Math.floor((lotExpireAt(lot) - now) / (24 * 3600 * 1000)),
        available,
      });
      remain -= take;
    }

    allocations.push({ ...need, slices });
    if (remain > 0.0001) {
      shortages.push({ ...need, missingQty: Math.round(remain * 1000) / 1000 });
    }
  }

  return { needs, allocations, shortages, skippedExpired, ok: shortages.length === 0 };
}
