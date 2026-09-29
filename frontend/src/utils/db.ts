import Dexie, { type Table } from 'dexie';
import type { Specimen } from '../types/specimen';
import type { PrepProcedure } from '../types/procedure';
import { defaultMaterialsForProcedure } from '../types/procedure';
import type { SupplyLot, SupplyMovement } from '../types/supply';
import type { PrepSchedule } from '../types/schedule';
import type { PrepPhoto } from '../types/photo';
import { makeSketchDataUrl } from '../types/photo';
import { newId } from './id';

/** 当前数据结构版本，写入 localStorage 便于回显 */
export const DB_VERSION = 3;
export const DB_NAME = 'gbfossilprep';
export const LS_VERSION_KEY = 'gbfossilprep:db-version';

class FossilPrepDB extends Dexie {
  specimens!: Table<Specimen, string>;
  procedures!: Table<PrepProcedure, string>;
  supplies!: Table<SupplyLot, string>;
  schedules!: Table<PrepSchedule, string>;
  photos!: Table<PrepPhoto, string>;

  constructor() {
    super(DB_NAME);
    // v1：初版四张业务表
    this.version(1).stores({
      specimens: 'id, specimenNo, taxon, locality, status, createdAt',
      procedures: 'id, specimenId, seq, stepType, state',
      supplies: 'id, kind, lotNo, name',
      photos: 'id, specimenId, procedureId, stage',
    });
    // v2：工序增加 state 索引与 finishedAt；影像增加 stage 索引
    this.version(2)
      .stores({
        specimens: 'id, specimenNo, taxon, locality, status, createdAt',
        procedures: 'id, specimenId, seq, stepType, state, startedAt',
        supplies: 'id, kind, lotNo, name, openedAt',
        photos: 'id, specimenId, procedureId, stage, capturedAt',
      })
      .upgrade(async (tx) => {
        // 老版本记录缺字段，迁移时逐表补齐（用宽松类型，避免升级事务里做多余断言）
        await tx
          .table('procedures')
          .toCollection()
          .modify((row: any) => {
            if (!row.state) row.state = 'pending';
            if (row.tools === undefined) row.tools = [];
            if (row.photoBeforeIds === undefined) row.photoBeforeIds = [];
            if (row.photoAfterIds === undefined) row.photoAfterIds = [];
            if (row.adhesiveConc === undefined) row.adhesiveConc = 0;
          });
        await tx
          .table('supplies')
          .toCollection()
          .modify((row: any) => {
            if (!row.issues) row.issues = [];
            if (row.lowThreshold === undefined) row.lowThreshold = 1;
          });
      });
    // v3：修复批次排程表 + 批次预占量/库存流水 + 工序耗材明细（默认用量可追溯）
    this.version(3)
      .stores({
        specimens: 'id, specimenNo, taxon, locality, status, createdAt',
        procedures: 'id, specimenId, seq, stepType, state, startedAt',
        supplies: 'id, kind, lotNo, name, openedAt',
        schedules: 'id, scheduleNo, state, createdAt, confirmedAt',
        photos: 'id, specimenId, procedureId, stage, capturedAt',
      })
      .upgrade(async (tx) => {
        // 旧工序补出可追溯的默认耗材明细；旧「已完成」工序不改变状态/完成时间
        await tx
          .table('procedures')
          .toCollection()
          .modify((row: any) => {
            if (row.materials === undefined) {
              row.materials = defaultMaterialsForProcedure({
                stepType: row.stepType,
                abrasive: row.abrasive,
                adhesive: row.adhesive,
              });
            }
          });
        // 批次补预占量与流水；旧领用登记迁移成 issue 流水，台账流水不丢历史
        await tx
          .table('supplies')
          .toCollection()
          .modify((row: any) => {
            if (row.reservedQty === undefined) row.reservedQty = 0;
            if (row.movements === undefined) {
              row.movements = (Array.isArray(row.issues) ? row.issues : []).map((iss: any) => ({
                id: newId('mov'),
                kind: 'issue',
                qty: iss.qty,
                operator: iss.operator,
                specimenNo: iss.specimenNo,
                at: iss.issuedAt,
                note: '历史手填领用迁移',
              })) as SupplyMovement[];
            }
          });
      });
  }
}

export const db = new FossilPrepDB();

/** 记录结构版本，迁移完成后回写 */
export async function markDbVersion(): Promise<void> {
  try {
    window.localStorage.setItem(LS_VERSION_KEY, String(DB_VERSION));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function readDbVersion(): number {
  try {
    const raw = window.localStorage.getItem(LS_VERSION_KEY);
    return raw ? Number(raw) : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

/** 首次进入时灌入示范档案，保证页面非空壳 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.specimens.count();
  if (count > 0) return;

  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const specimenId = newId('spm');
  const specimenId2 = newId('spm');

  const specimens: Specimen[] = [
    {
      id: specimenId,
      specimenNo: 'FP-2024-0031',
      taxon: 'Sinokannemeyeria yingchiaoensis（山西肯氏兽）',
      horizon: '中三叠统二马营组',
      locality: '山西武乡',
      lithology: '紫红色粉砂质泥岩',
      matrixHardness: 2.5,
      dimensions: '320×210×150',
      weight: 4820,
      storageBox: 'A 区 3 匣 2 格',
      status: '修复中',
      createdAt: now - 12 * day,
    },
    {
      id: specimenId2,
      specimenNo: 'FP-2024-0058',
      taxon: 'Psittacosaurus sp.（鹦鹉嘴龙）',
      horizon: '下白垩统义县组',
      locality: '辽宁北票',
      lithology: '灰绿色凝灰质砂岩',
      matrixHardness: 4.2,
      dimensions: '180×120×90',
      weight: 1640,
      storageBox: 'B 区 1 匣 4 格',
      status: '待清修',
      createdAt: now - 5 * day,
    },
  ];

  const proc1Id = newId('prc');
  const proc2Id = newId('prc');
  const procedures: PrepProcedure[] = [
    {
      id: proc1Id,
      specimenId,
      stepType: '清修',
      nodeName: '左侧肩胛区粗清',
      seq: 1,
      tools: ['气动笔', '剔针'],
      abrasive: '800 目',
      adhesive: '',
      adhesiveConc: 0,
      materials: defaultMaterialsForProcedure({ stepType: '清修', abrasive: '800 目' }),
      durationMin: 145,
      tempC: 22,
      rh: 48,
      photoBeforeIds: [],
      photoAfterIds: [],
      operator: '林砚秋',
      startedAt: now - 10 * day,
      state: 'done',
      finishedAt: now - 10 * day + 145 * 60000,
    },
    {
      id: proc2Id,
      specimenId,
      stepType: '加固',
      nodeName: '围岩裂隙渗透加固',
      seq: 2,
      tools: ['渗透滴管'],
      abrasive: '',
      adhesive: 'Paraloid B-72',
      adhesiveConc: 5,
      materials: defaultMaterialsForProcedure({ stepType: '加固', adhesive: 'Paraloid B-72' }),
      durationMin: 90,
      tempC: 23,
      rh: 45,
      photoBeforeIds: [],
      photoAfterIds: [],
      operator: '林砚秋',
      startedAt: now - 6 * day,
      state: 'pending',
    },
  ];

  const photos: PrepPhoto[] = [
    {
      id: newId('pho'),
      specimenId,
      procedureId: procedures[0].id,
      stage: 'before',
      caption: '清修前 · 左侧肩胛区围岩包裹',
      dataUrl: makeSketchDataUrl('清修前 · FP-2024-0031', '#6b5844'),
      capturedAt: now - 10 * day,
    },
    {
      id: newId('pho'),
      specimenId,
      procedureId: procedures[0].id,
      stage: 'after',
      caption: '清修后 · 肩胛骨轮廓显露',
      dataUrl: makeSketchDataUrl('清修后 · FP-2024-0031', '#3f5a4a'),
      capturedAt: now - 9 * day,
    },
  ];
  procedures[0].photoBeforeIds = [photos[0].id];
  procedures[0].photoAfterIds = [photos[1].id];

  // B-72 放三个批次：临期（12 天后到期，优先）、正常、已过期（自动跳过），
  // 用于直接演示 FEFO 临期优先 + 过期跳过的分配行为。
  const supplies: SupplyLot[] = [
    {
      id: newId('sup'),
      name: 'Paraloid B-72',
      kind: '胶种',
      spec: '分析纯 500 g（临期）',
      lotNo: 'B72-NEAR-2510',
      qty: 2,
      reservedQty: 0,
      unit: '瓶',
      openedAt: now - (36 * 30 - 12) * day,
      shelfLifeMonths: 36,
      lowThreshold: 1,
      movements: [],
      issues: [],
    },
    {
      id: newId('sup'),
      name: 'Paraloid B-72',
      kind: '胶种',
      spec: '分析纯 500 g',
      lotNo: 'B72-20240312',
      qty: 4,
      reservedQty: 0,
      unit: '瓶',
      openedAt: now - 40 * day,
      shelfLifeMonths: 36,
      lowThreshold: 2,
      movements: [
        {
          id: newId('mov'),
          kind: 'issue',
          qty: 1,
          operator: '林砚秋',
          specimenNo: 'FP-2024-0031',
          at: now - 6 * day,
          note: '手填领用',
        },
      ],
      issues: [
        {
          id: newId('iss'),
          qty: 1,
          operator: '林砚秋',
          specimenNo: 'FP-2024-0031',
          issuedAt: now - 6 * day,
        },
      ],
    },
    {
      id: newId('sup'),
      name: 'Paraloid B-72',
      kind: '胶种',
      spec: '分析纯 500 g（已过期）',
      lotNo: 'B72-OLD-2306',
      qty: 3,
      reservedQty: 0,
      unit: '瓶',
      openedAt: now - 400 * day,
      shelfLifeMonths: 12,
      lowThreshold: 1,
      movements: [],
      issues: [],
    },
    {
      id: newId('sup'),
      name: '渗透滴管',
      kind: '耗材',
      spec: '一次性 3 ml',
      lotNo: 'PIP-3ML-2503',
      qty: 20,
      reservedQty: 0,
      unit: '支',
      openedAt: now - 20 * day,
      shelfLifeMonths: 60,
      lowThreshold: 5,
      movements: [],
      issues: [],
    },
    {
      id: newId('sup'),
      name: '碳化硅磨料',
      kind: '磨料',
      spec: '800 目 1 kg',
      lotNo: 'SIC-800-2401',
      qty: 1,
      reservedQty: 0,
      unit: '袋',
      openedAt: now - 60 * day,
      shelfLifeMonths: 60,
      lowThreshold: 2,
      movements: [],
      issues: [],
    },
    {
      id: newId('sup'),
      name: '气动笔针头',
      kind: '耗材',
      spec: '钨钢 2.3 mm',
      lotNo: 'NEEDLE-2312',
      qty: 18,
      reservedQty: 0,
      unit: '支',
      openedAt: now - 90 * day,
      shelfLifeMonths: 120,
      lowThreshold: 5,
      movements: [],
      issues: [],
    },
    {
      id: newId('sup'),
      name: '超声波清洗机',
      kind: '工具',
      spec: '6 L / 40 kHz',
      lotNo: 'US-6L-01',
      qty: 1,
      reservedQty: 0,
      unit: '台',
      openedAt: now - 200 * day,
      shelfLifeMonths: 120,
      lowThreshold: 1,
      movements: [],
      issues: [],
    },
  ];

  // 一张示范草稿：草稿不动库存，可在排程工作台打开继续编辑/确认
  const draftSchedule: PrepSchedule = {
    id: newId('sch'),
    scheduleNo: 'PS-DRAFT-0001',
    state: 'draft',
    operator: '林砚秋',
    remark: '示范草稿：尚未确认，不占用任何库存',
    createdAt: now - day,
    items: [
      {
        rowId: newId('row'),
        specimenId,
        procedureId: proc2Id,
        stepType: '加固',
        nodeName: '围岩裂隙渗透加固',
        materials: defaultMaterialsForProcedure({ stepType: '加固', adhesive: 'Paraloid B-72' }),
      },
    ],
    allocations: [],
  };

  await db.transaction('rw', db.specimens, db.procedures, db.supplies, db.schedules, db.photos, async () => {
    await db.specimens.bulkPut(specimens);
    await db.procedures.bulkPut(procedures);
    await db.supplies.bulkPut(supplies);
    await db.schedules.put(draftSchedule);
    await db.photos.bulkPut(photos);
  });
}
