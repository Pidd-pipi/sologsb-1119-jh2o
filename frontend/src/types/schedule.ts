import type { ProcedureMaterial } from './procedure';

/** 排程状态：草稿（不动库存）/ 已确认（已预占）/ 已领用 / 已取消（已退回） */
export type ScheduleState = 'draft' | 'confirmed' | 'issued' | 'cancelled';

export const SCHEDULE_STATE_LABEL: Record<ScheduleState, string> = {
  draft: '草稿',
  confirmed: '已确认',
  issued: '已领用',
  cancelled: '已取消',
};

export const SCHEDULE_STATE_COLOR: Record<ScheduleState, 'default' | 'info' | 'success' | 'error'> = {
  draft: 'default',
  confirmed: 'info',
  issued: 'success',
  cancelled: 'error',
};

/** 排程中的一个计划项：可挂接已有工序，也可是临时增补项 */
export interface ScheduleItem {
  /** 行内临时 id */
  rowId: string;
  specimenId: string;
  /** 挂接的计划工序（可空，表示临时增补） */
  procedureId?: string;
  stepType: string;
  nodeName: string;
  materials: ProcedureMaterial[];
}

/** 某批次在该排程上的分配（确认时按原批次写定，取消据此退回） */
export interface ScheduleAllocation {
  lotId: string;
  lotNo: string;
  name: string;
  unit: string;
  /** 预占数量 */
  qty: number;
  /** 预占流水 id，领用/退回共享（保证一批只对应一次预占变化） */
  refId: string;
  /** 已领用数量 */
  issuedQty: number;
  /** 已退回数量 */
  returnedQty: number;
}

/** 修复批次排程 */
export interface PrepSchedule {
  id: string;
  /** 排程单号，如 PS-20260929-001 */
  scheduleNo: string;
  state: ScheduleState;
  items: ScheduleItem[];
  /** 确认时生成的批次分配，按材料聚合，FEFO 临期优先 */
  allocations: ScheduleAllocation[];
  operator: string;
  remark?: string;
  createdAt: number;
  confirmedAt?: number;
  issuedAt?: number;
  cancelledAt?: number;
  /** 确认时跳过的过期批次，仅供说明，不参与占用 */
  skippedLotIds?: string[];
}

/** 分配计算的单条需求 */
export interface MaterialNeed {
  name: string;
  qty: number;
  unit: string;
  /** 需求来源行，便于回显缺口落在哪个标本/工序 */
  rows: Array<{ specimenNo: string; nodeName: string; qty: number }>;
}
