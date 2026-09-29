import type { ProcedureConsumable, StepType } from './procedure';
import type { SupplyKind } from './supply';

/** 排程状态：草稿不动库存；已确认=已预占；已取消=已退回 */
export type ReservationStatus = 'draft' | 'confirmed' | 'cancelled';

export const RESERVATION_STATUS_LABEL: Record<ReservationStatus, string> = {
  draft: '草稿',
  confirmed: '已确认',
  cancelled: '已取消',
};

export const RESERVATION_STATUS_COLOR: Record<ReservationStatus, 'default' | 'primary' | 'success' | 'warning' | 'error'> = {
  draft: 'default',
  confirmed: 'primary',
  cancelled: 'warning',
};

/** 排程中的一条计划工序（挂在某标本下） */
export interface ReservationItem {
  id: string;
  specimenId: string;
  /** 标本号（冗余，便于台账展示） */
  specimenNo: string;
  stepType: StepType;
  /** 计划节点名（可空，展示时回退为工序类型） */
  nodeName: string;
  /** 该计划工序的耗材需求（默认用量，可调整） */
  consumables: ProcedureConsumable[];
}

/** 预占分配：从哪个批次出多少（取消时按此原批次退回） */
export interface ReservationAllocation {
  lotId: string;
  lotNo: string;
  name: string;
  unit: string;
  qty: number;
}

/** 缺口行：材料不足时整份排程保持原样，仅列出缺口 */
export interface ReservationShortage {
  name: string;
  kind: SupplyKind;
  unit: string;
  need: number;
  available: number;
  missing: number;
}

/** 修复排程（按修复批次预留材料） */
export interface Reservation {
  id: string;
  /** 排程单号 */
  code: string;
  status: ReservationStatus;
  operator: string;
  createdAt: number;
  updatedAt: number;
  items: ReservationItem[];
  /** 确认时的实际批次分配（退回按此原批次） */
  allocations: ReservationAllocation[];
  /** 缺口清单（材料不足时记录，库存不动） */
  shortages: ReservationShortage[];
  note?: string;
}

export type ReservationDraft = Omit<
  Reservation,
  'id' | 'code' | 'status' | 'createdAt' | 'updatedAt' | 'allocations' | 'shortages'
>;
