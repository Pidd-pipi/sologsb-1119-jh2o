import { availableQty, isExpired, type SupplyLot } from '../types/supply';
import type { ReservationAllocation, ReservationShortage } from '../types/reservation';

export interface DemandLine {
  name: string;
  kind: string;
  unit: string;
  qty: number;
}

export interface SkippedLot {
  lotId: string;
  lotNo: string;
  name: string;
  /** 跳过原因：expired=已过期；empty=无在库；reserved=可用已被预占 */
  reason: 'expired' | 'empty' | 'reserved';
}

export interface AllocationResult {
  ok: boolean;
  /** 实际分配（仅 ok 时有值；不足时整份不动） */
  allocations: ReservationAllocation[];
  /** 缺口清单 */
  shortages: ReservationShortage[];
  /** 分配时跳过的批次（过期/无货/已被预占） */
  skipped: SkippedLot[];
}

function expiryOf(lot: SupplyLot): number {
  return lot.openedAt + lot.shelfLifeMonths * 30 * 24 * 3600 * 1000;
}

/**
 * 按「临期优先（FEFO）」自动分配批次：
 * - 仅在未过期批次中分配，过期批次直接跳过；
 * - 同一材料按到期日先后排序，先到期的先出；
 * - 可用量 = 在库 - 预占；
 * - 任一材料不足则整份不分配（all-or-nothing），库存保持原样，仅返回缺口。
 */
export function allocateMaterials(lots: SupplyLot[], demand: DemandLine[], now = Date.now()): AllocationResult {
  const allocations: ReservationAllocation[] = [];
  const shortages: ReservationShortage[] = [];
  const skipped: SkippedLot[] = [];

  for (const line of demand) {
    // 同名批次（kind 一致更精确），按到期日升序：临期批次优先
    const candidates = lots
      .filter((l) => l.name === line.name && (line.kind ? l.kind === line.kind : true))
      .sort((a, b) => expiryOf(a) - expiryOf(b) || a.lotNo.localeCompare(b.lotNo));

    let availableTotal = 0;
    let fulfilled = 0;
    for (const lot of candidates) {
      if (isExpired(lot, now)) {
        skipped.push({ lotId: lot.id, lotNo: lot.lotNo, name: lot.name, reason: 'expired' });
        continue;
      }
      const avail = availableQty(lot);
      if (avail <= 0) {
        skipped.push({
          lotId: lot.id,
          lotNo: lot.lotNo,
          name: lot.name,
          reason: lot.qty <= 0 ? 'empty' : 'reserved',
        });
        continue;
      }
      availableTotal += avail;
      if (fulfilled < line.qty) {
        const take = Math.min(avail, line.qty - fulfilled);
        allocations.push({ lotId: lot.id, lotNo: lot.lotNo, name: lot.name, unit: lot.unit, qty: take });
        fulfilled += take;
      }
    }

    if (fulfilled < line.qty) {
      shortages.push({
        name: line.name,
        kind: line.kind as ReservationShortage['kind'],
        unit: line.unit,
        need: line.qty,
        available: availableTotal,
        missing: line.qty - fulfilled,
      });
    }
  }

  // 整份排程保持原样：任一材料不足则不动库存
  return { ok: shortages.length === 0, allocations: shortages.length === 0 ? allocations : [], shortages, skipped };
}

/** 汇总排程需求：把各计划工序的耗材按名称聚合 */
export function aggregateDemand(
  items: { consumables: { name: string; kind: string; unit: string; qty: number }[] }[],
): DemandLine[] {
  const map = new Map<string, DemandLine>();
  for (const item of items) {
    for (const c of item.consumables) {
      const key = `${c.name}__${c.unit}`;
      const cur = map.get(key);
      if (cur) {
        cur.qty += c.qty;
      } else {
        map.set(key, { name: c.name, kind: c.kind, unit: c.unit, qty: c.qty });
      }
    }
  }
  return Array.from(map.values());
}
