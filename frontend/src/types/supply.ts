/** 工具材料种类 */
export type SupplyKind = '工具' | '磨料' | '胶种' | '耗材';

export const SUPPLY_KINDS: SupplyKind[] = ['工具', '磨料', '胶种', '耗材'];

/** 库存流水类型：预占 / 解除预占 / 领用 / 退回 */
export type SupplyMovementKind = 'reserve' | 'release' | 'issue' | 'return';

export const SUPPLY_MOVEMENT_LABEL: Record<SupplyMovementKind, string> = {
  reserve: '预占',
  release: '解除预占',
  issue: '领用',
  return: '退回',
};

/** 单条库存流水（排程占用、领用、退回全部可追溯） */
export interface SupplyMovement {
  id: string;
  kind: SupplyMovementKind;
  /** 数量，恒为正数；方向由 kind 表达 */
  qty: number;
  operator: string;
  at: number;
  /** 关联修复排程（手填领用无此值） */
  scheduleId?: string;
  scheduleNo?: string;
  specimenNo: string;
  /** 同一批预占与其领用/退回共享的关联号（取预占流水 id） */
  refId?: string;
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
  /** 在库数量（实物总量） */
  qty: number;
  /** 已被已确认排程预占、尚未领用的数量 */
  reservedQty: number;
  unit: string;
  /** 开封时间 */
  openedAt: number;
  /** 保质期（月） */
  shelfLifeMonths: number;
  /** 低量阈值 */
  lowThreshold: number;
  /** 库存流水（新） */
  movements: SupplyMovement[];
  /** 最近一次领用记录（旧字段，手填领用继续双写，兼容老视图） */
  issues: SupplyIssue[];
}

/** 领用登记（旧结构，保留用于兼容） */
export interface SupplyIssue {
  id: string;
  qty: number;
  operator: string;
  specimenNo: string;
  issuedAt: number;
}

export type SupplyLotDraft = Omit<SupplyLot, 'id' | 'issues' | 'reservedQty' | 'movements'>;

/** 是否低量（按实物在库判断） */
export function isLowStock(lot: SupplyLot): boolean {
  return lot.qty <= lot.lowThreshold;
}

/** 到期时间戳 */
export function lotExpireAt(lot: SupplyLot): number {
  return lot.openedAt + lot.shelfLifeMonths * 30 * 24 * 3600 * 1000;
}

/** 剩余保质期天数（负数表示已过期） */
export function shelfLifeLeftDays(lot: SupplyLot, now = Date.now()): number {
  return Math.floor((lotExpireAt(lot) - now) / (24 * 3600 * 1000));
}

/** 临期阈值（剩余天数 <= 该值视为临期，优先使用） */
export const NEAR_EXPIRE_DAYS = 30;

/** 是否已过期 */
export function isExpired(lot: SupplyLot, now = Date.now()): boolean {
  return shelfLifeLeftDays(lot, now) < 0;
}

/** 是否临期 */
export function isNearExpire(lot: SupplyLot, now = Date.now()): boolean {
  const left = shelfLifeLeftDays(lot, now);
  return left >= 0 && left <= NEAR_EXPIRE_DAYS;
}

/** 可用数量 = 实物在库 - 已预占 */
export function lotAvailable(lot: SupplyLot): number {
  return Math.max(0, lot.qty - (lot.reservedQty ?? 0));
}
