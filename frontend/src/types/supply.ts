/** 工具材料种类 */
export type SupplyKind = '工具' | '磨料' | '胶种' | '耗材';

export const SUPPLY_KINDS: SupplyKind[] = ['工具', '磨料', '胶种', '耗材'];

/** 库存变动类型：预占 / 领用 / 退回 */
export type StockMovementType = 'reserve' | 'issue' | 'return';

export const STOCK_MOVEMENT_LABEL: Record<StockMovementType, string> = {
  reserve: '预占',
  issue: '领用',
  return: '退回',
};

export const STOCK_MOVEMENT_COLOR: Record<StockMovementType, 'info' | 'warning' | 'default'> = {
  reserve: 'info',
  issue: 'warning',
  return: 'default',
};

/**
 * 库存变动明细。
 * 预占=排程确认时占用批次库存（在库不变、可用减少）；
 * 领用=技师手工登记出库（在库减少）；
 * 退回=排程取消时按原批次释放预占（可用恢复）。
 * 三类变动均记录操作者，台账与排程详情都据此展示。
 */
export interface StockMovement {
  id: string;
  type: StockMovementType;
  /** 变动数量（均为正数） */
  qty: number;
  operator: string;
  at: number;
  /** 关联标本号 */
  specimenNo?: string;
  /** 关联排程单号 */
  reservationId?: string;
  note?: string;
}

/** 工具材料批次 */
export interface SupplyLot {
  id: string;
  name: string;
  kind: SupplyKind;
  /** 规格 */
  spec: string;
  /** 批号 */
  lotNo: string;
  /** 在库数量（物理库存） */
  qty: number;
  unit: string;
  /** 已预占未领用数量 */
  reservedQty: number;
  /** 库存变动明细（预占/领用/退回，含操作者） */
  movements: StockMovement[];
  /** 开封时间 */
  openedAt: number;
  /** 保质期（月） */
  shelfLifeMonths: number;
  /** 低量阈值 */
  lowThreshold: number;
}

export type SupplyLotDraft = Omit<SupplyLot, 'id' | 'reservedQty' | 'movements'>;

/** 可用数量 = 在库 - 预占 */
export function availableQty(lot: SupplyLot): number {
  return Math.max(0, lot.qty - lot.reservedQty);
}

/** 是否低量（按物理在库计） */
export function isLowStock(lot: SupplyLot): boolean {
  return lot.qty <= lot.lowThreshold;
}

/** 剩余保质期天数（负数表示已过期） */
export function shelfLifeLeftDays(lot: SupplyLot, now = Date.now()): number {
  const expireAt = lot.openedAt + lot.shelfLifeMonths * 30 * 24 * 3600 * 1000;
  return Math.floor((expireAt - now) / (24 * 3600 * 1000));
}

/** 是否已过保质期（过期批次不参与排程自动分配） */
export function isExpired(lot: SupplyLot, now = Date.now()): boolean {
  return shelfLifeLeftDays(lot, now) < 0;
}
