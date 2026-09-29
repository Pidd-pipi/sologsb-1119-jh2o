/** 工序类型 */
export type StepType = '清修' | '加固' | '粘接' | '补配' | '翻模';

export const STEP_TYPES: StepType[] = ['清修', '加固', '粘接', '补配', '翻模'];

/** 耗材明细来源：default=升级补全的默认用量（可追溯）；manual=按实填写 */
export type ConsumableSource = 'default' | 'manual';

/**
 * 工序耗材明细。
 * 老版本工序没有耗材明细，升级时按工序类型补出默认用量并标记 source='default'，
 * 便于追溯「这笔材料是按默认用量补的」；新工序保存时同样按类型带出。
 */
export interface ProcedureConsumable {
  /** 材料名称（对应 SupplyLot.name，排程自动分配按名称匹配批次） */
  name: string;
  kind: import('./supply').SupplyKind;
  unit: string;
  /** 默认/计划用量 */
  qty: number;
  source: ConsumableSource;
}

/** 各工序类型的默认耗材用量（升级补全与排程需求计算用，均可追溯） */
export const DEFAULT_CONSUMABLES: Record<StepType, ProcedureConsumable[]> = {
  清修: [
    { name: '碳化硅磨料', kind: '磨料', unit: '袋', qty: 1, source: 'default' },
    { name: '气动笔针头', kind: '耗材', unit: '支', qty: 1, source: 'default' },
  ],
  加固: [{ name: 'Paraloid B-72', kind: '胶种', unit: '瓶', qty: 0.1, source: 'default' }],
  粘接: [{ name: '氰基丙烯酸酯', kind: '胶种', unit: '瓶', qty: 0.1, source: 'default' }],
  补配: [{ name: '环氧树脂 E44', kind: '胶种', unit: '组', qty: 0.2, source: 'default' }],
  翻模: [{ name: '硅橡胶', kind: '胶种', unit: '套', qty: 0.2, source: 'default' }],
};

/** 各工序类型适用的工具、磨料、胶种候选（表单动态字段用） */
export const STEP_FIELD_MAP: Record<
  StepType,
  { tools: string[]; abrasives: string[]; adhesives: string[]; needConc: boolean }
> = {
  清修: {
    tools: ['气动笔', '剔针', '超声波清洗机', '软毛刷'],
    abrasives: ['400 目', '800 目', '1200 目'],
    adhesives: [],
    needConc: false,
  },
  加固: {
    tools: ['渗透滴管', '真空浸渗罐', '加热台'],
    abrasives: [],
    adhesives: ['Paraloid B-72', '氰基丙烯酸酯', '环氧树脂 E44'],
    needConc: true,
  },
  粘接: {
    tools: ['点胶针', '夹持架', '热风枪'],
    abrasives: [],
    adhesives: ['Paraloid B-72', '氰基丙烯酸酯', '动物胶'],
    needConc: true,
  },
  补配: {
    tools: ['刮刀', '雕刻刀', '石膏模'],
    abrasives: ['600 目', '1000 目'],
    adhesives: ['环氧树脂 E44', 'Paraloid B-72'],
    needConc: true,
  },
  翻模: {
    tools: ['硅胶模具', '真空脱泡机', '石膏桶'],
    abrasives: [],
    adhesives: ['硅橡胶', '石膏浆料'],
    needConc: false,
  },
};

/** 工序节点状态 */
export type ProcedureState = 'pending' | 'done' | 'rolledback';

/** 修复工序 */
export interface PrepProcedure {
  id: string;
  specimenId: string;
  stepType: StepType;
  /** 节点名称 */
  nodeName: string;
  /** 序号，不得跳号 */
  seq: number;
  /** 工具 */
  tools: string[];
  /** 磨料目数 */
  abrasive: string;
  /** 胶种 */
  adhesive: string;
  /** 胶液浓度 % */
  adhesiveConc: number;
  /** 耗材明细（升级补全默认用量，可追溯） */
  consumables: ProcedureConsumable[];
  /** 耗时 min */
  durationMin: number;
  /** 环境温度 ℃ */
  tempC: number;
  /** 相对湿度 % */
  rh: number;
  photoBeforeIds: string[];
  photoAfterIds: string[];
  operator: string;
  startedAt: number;
  state: ProcedureState;
  finishedAt?: number;
}

export type PrepProcedureDraft = Omit<PrepProcedure, 'id'>;
