/**
 * 端到端逻辑测试：FEFO 分配、过期跳过、不足原子回滚、草稿不动库存、
 * 取消按原批次退回、重复确认/取消幂等、v2→v3 迁移补齐默认耗材。
 * 运行：npx tsx scripts/schedule.test.ts
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert';
import { db, DB_VERSION } from '../src/utils/db';
import { planAllocation } from '../src/utils/allocation';
import { useScheduleStore, ScheduleStockError } from '../src/stores/scheduleStore';
import { useSupplyStore } from '../src/stores/supplyStore';
import type { SupplyLot } from '../src/types/supply';
import type { PrepProcedure, PrepProcedureDraft } from '../src/types/procedure';
import type { Specimen } from '../src/types/specimen';
import { newId } from '../src/utils/id';

let passed = 0;
function test(name: string, fn: () => Promise<void>) {
  return fn()
    .then(() => {
      passed += 1;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      console.error(`  ✗ ${name}`);
      console.error(e);
      process.exitCode = 1;
    });
}

const day = 24 * 3600 * 1000;
const now = Date.now();

function makeLot(over: Partial<SupplyLot> & Pick<SupplyLot, 'name' | 'lotNo' | 'qty' | 'openedAt' | 'shelfLifeMonths'>): SupplyLot {
  return {
    id: newId('sup'),
    kind: '胶种',
    spec: '',
    reservedQty: 0,
    unit: '瓶',
    lowThreshold: 0,
    movements: [],
    issues: [],
    ...over,
  };
}

async function setupFixture() {
  await db.delete();
  await db.open();
  assert.strictEqual(DB_VERSION, 3);

  const specimenId = newId('spm');
  await db.specimens.put({
    id: specimenId,
    specimenNo: 'T-001',
    taxon: '测试种',
    horizon: '',
    locality: '',
    lithology: '',
    matrixHardness: 1,
    dimensions: '',
    weight: 1,
    storageBox: '',
    status: '修复中',
    createdAt: now,
  } as Specimen);

  const procId = newId('prc');
  await db.procedures.put({
    id: procId,
    specimenId,
    stepType: '加固',
    nodeName: '测试加固',
    seq: 1,
    tools: [],
    abrasive: '',
    adhesive: 'Paraloid B-72',
    adhesiveConc: 5,
    materials: [{ name: 'Paraloid B-72', qty: 3, unit: '瓶', source: 'default', note: '测试' }],
    durationMin: 10,
    tempC: 20,
    rh: 50,
    photoBeforeIds: [],
    photoAfterIds: [],
    operator: '测试员',
    startedAt: now,
    state: 'pending',
  } as PrepProcedure);

  // 三批次：已过期（3 瓶）、临期 12 天（2 瓶）、远期（10 瓶）
  const expired = makeLot({
    name: 'Paraloid B-72',
    lotNo: 'LOT-EXPIRED',
    qty: 3,
    openedAt: now - 400 * day,
    shelfLifeMonths: 12,
  });
  const near = makeLot({
    name: 'Paraloid B-72',
    lotNo: 'LOT-NEAR',
    qty: 2,
    openedAt: now - (36 * 30 - 12) * day,
    shelfLifeMonths: 36,
  });
  const fresh = makeLot({
    name: 'Paraloid B-72',
    lotNo: 'LOT-FRESH',
    qty: 10,
    openedAt: now - 10 * day,
    shelfLifeMonths: 36,
  });
  await db.supplies.bulkPut([expired, near, fresh]);

  await useSupplyStore.getState().load();
  return { specimenId, procId, lotIds: { expired: expired.id, near: near.id, fresh: fresh.id } };
}

const itemsOf = (specimenId: string, procId: string, qty: number) => [
  {
    rowId: 'r1',
    specimenId,
    procedureId: procId,
    stepType: '加固',
    nodeName: '测试加固',
    materials: [{ name: 'Paraloid B-72', qty, unit: '瓶', source: 'default' as const }],
  },
];
const noOf = () => 'T-001';

async function main() {
  console.log('FEFO 分配算法');

  await test('临期批次优先、过期批次跳过', async () => {
    const { specimenId, procId } = await setupFixture();
    const lots = await db.supplies.toArray();
    const plan = planAllocation(itemsOf(specimenId, procId, 3), lots, noOf);
    assert.ok(plan.ok);
    assert.strictEqual(plan.skippedExpired.length, 1);
    assert.strictEqual(plan.skippedExpired[0].lotNo, 'LOT-EXPIRED');
    // 3 瓶需求 = 临期 2 + 远期 1，顺序临期在前
    const slices = plan.allocations[0].slices;
    assert.deepStrictEqual(
      slices.map((s) => [s.lotNo, s.qty]),
      [
        ['LOT-NEAR', 2],
        ['LOT-FRESH', 1],
      ],
    );
  });

  await test('只剩过期批次时报缺口', async () => {
    await setupFixture();
    const lots = (await db.supplies.toArray()).map((l) =>
      l.lotNo === 'LOT-NEAR' || l.lotNo === 'LOT-FRESH' ? { ...l, qty: 0 } : l,
    );
    const plan = planAllocation(itemsOf('s', 'p', 2), lots, noOf);
    assert.strictEqual(plan.ok, false);
    assert.strictEqual(plan.shortages[0].missingQty, 2);
  });

  console.log('确认 / 草稿 / 取消 / 幂等');

  await test('草稿保存不动库存', async () => {
    const { specimenId, procId } = await setupFixture();
    const before = (await db.supplies.toArray()).map((l) => [l.lotNo, l.qty, l.reservedQty]);
    await useScheduleStore.getState().saveDraft(undefined, { items: itemsOf(specimenId, procId, 3), operator: '测试员' });
    const after = (await db.supplies.toArray()).map((l) => [l.lotNo, l.qty, l.reservedQty]);
    assert.deepStrictEqual(after, before);
  });

  await test('确认排程按临期优先预占，可用量减少、实物不变', async () => {
    const { specimenId, procId } = await setupFixture();
    const draft = await useScheduleStore.getState().saveDraft(undefined, { items: itemsOf(specimenId, procId, 3), operator: '测试员' });
    const rec = await useScheduleStore.getState().confirm(draft.id, '测试员', noOf);
    assert.strictEqual(rec.state, 'confirmed');
    const lots = await db.supplies.toArray();
    const near = lots.find((l) => l.lotNo === 'LOT-NEAR')!;
    const fresh = lots.find((l) => l.lotNo === 'LOT-FRESH')!;
    const expired = lots.find((l) => l.lotNo === 'LOT-EXPIRED')!;
    assert.strictEqual(near.qty, 2); // 实物未动
    assert.strictEqual(near.reservedQty, 2);
    assert.strictEqual(fresh.qty, 10);
    assert.strictEqual(fresh.reservedQty, 1);
    assert.strictEqual(expired.reservedQty, 0); // 过期不参与
    // 流水只记一条 reserve / 批次
    assert.strictEqual(near.movements.filter((m) => m.kind === 'reserve').length, 1);
    assert.strictEqual(fresh.movements.filter((m) => m.kind === 'reserve').length, 1);
  });

  await test('材料不足时整份排程与库存保持原样（事务回滚）', async () => {
    const { specimenId, procId } = await setupFixture();
    // 需求量 100：临期 2 + 远期 10 = 12，远不够
    const draft = await useScheduleStore.getState().saveDraft(undefined, { items: itemsOf(specimenId, procId, 100), operator: '测试员' });
    await assert.rejects(
      () => useScheduleStore.getState().confirm(draft.id, '测试员', noOf),
      (e: unknown) => e instanceof ScheduleStockError && (e as ScheduleStockError).shortages[0].missingQty === 88,
    );
    // 排程仍是草稿，库存全部零预占零流水
    const reloaded = await db.schedules.get(draft.id);
    assert.strictEqual(reloaded!.state, 'draft');
    const totalReserved = (await db.supplies.toArray()).reduce((sum, l) => sum + l.reservedQty, 0);
    assert.strictEqual(totalReserved, 0);
    const anyReserveMovement = (await db.supplies.toArray()).some((l) => l.movements.some((m) => m.kind === 'reserve'));
    assert.strictEqual(anyReserveMovement, false);
  });

  await test('已预占的数量不能被手填领用', async () => {
    const { specimenId, procId } = await setupFixture();
    const draft = await useScheduleStore.getState().saveDraft(undefined, { items: itemsOf(specimenId, procId, 3), operator: '测试员' });
    await useScheduleStore.getState().confirm(draft.id, '测试员', noOf);
    // 临期批次 qty2 全被预占，可领用为 0
    await useSupplyStore.getState().load();
    const near = useSupplyStore.getState().items.find((l) => l.lotNo === 'LOT-NEAR')!;
    await assert.rejects(
      () => useSupplyStore.getState().issue(near.id, { qty: 1, operator: '张三', specimenNo: 'T-001' }),
      /可领用量仅 0/,
    );
  });

  await test('领用后实物与预占同步下降，取消按原批次退回', async () => {
    const { specimenId, procId } = await setupFixture();
    const draft = await useScheduleStore.getState().saveDraft(undefined, { items: itemsOf(specimenId, procId, 3), operator: '测试员' });
    await useScheduleStore.getState().confirm(draft.id, '测试员', noOf);
    await useScheduleStore.getState().issue(draft.id, '测试员');

    let near = (await db.supplies.toArray()).find((l) => l.lotNo === 'LOT-NEAR')!;
    assert.strictEqual(near.qty, 0);
    assert.strictEqual(near.reservedQty, 0);
    let fresh = (await db.supplies.toArray()).find((l) => l.lotNo === 'LOT-FRESH')!;
    assert.strictEqual(fresh.qty, 9);

    await useScheduleStore.getState().cancel(draft.id, '测试员');
    near = (await db.supplies.toArray()).find((l) => l.lotNo === 'LOT-NEAR')!;
    fresh = (await db.supplies.toArray()).find((l) => l.lotNo === 'LOT-FRESH')!;
    // 已领用 3 瓶按原批次退回：临期 +2、远期 +1
    assert.strictEqual(near.qty, 2);
    assert.strictEqual(fresh.qty, 10);
    assert.strictEqual(near.reservedQty, 0);
    const cancelled = await db.schedules.get(draft.id);
    assert.strictEqual(cancelled!.state, 'cancelled');
    const returnedTotal = cancelled!.allocations.reduce((s, a) => s + a.returnedQty, 0);
    assert.strictEqual(returnedTotal, 3);
  });

  await test('已确认未领用直接取消：仅解除预占、实物不变', async () => {
    const { specimenId, procId } = await setupFixture();
    const draft = await useScheduleStore.getState().saveDraft(undefined, { items: itemsOf(specimenId, procId, 3), operator: '测试员' });
    await useScheduleStore.getState().confirm(draft.id, '测试员', noOf);
    await useScheduleStore.getState().cancel(draft.id, '测试员');
    const near = (await db.supplies.toArray()).find((l) => l.lotNo === 'LOT-NEAR')!;
    const fresh = (await db.supplies.toArray()).find((l) => l.lotNo === 'LOT-FRESH')!;
    assert.strictEqual(near.qty, 2);
    assert.strictEqual(fresh.qty, 10);
    assert.strictEqual(near.reservedQty, 0);
    assert.strictEqual(fresh.reservedQty, 0);
    // 无 return 流水（没有实物离库）
    assert.strictEqual(near.movements.some((m) => m.kind === 'return'), false);
    assert.ok(near.movements.some((m) => m.kind === 'release'));
  });

  await test('重复确认 / 重复取消只记一次库存变化', async () => {
    const { specimenId, procId } = await setupFixture();
    const draft = await useScheduleStore.getState().saveDraft(undefined, { items: itemsOf(specimenId, procId, 3), operator: '测试员' });
    await useScheduleStore.getState().confirm(draft.id, '测试员', noOf);
    await useScheduleStore.getState().confirm(draft.id, '测试员', noOf); // 幂等
    let near = (await db.supplies.toArray()).find((l) => l.lotNo === 'LOT-NEAR')!;
    assert.strictEqual(near.movements.filter((m) => m.kind === 'reserve').length, 1);
    assert.strictEqual(near.reservedQty, 2);

    await useScheduleStore.getState().cancel(draft.id, '测试员');
    near = (await db.supplies.toArray()).find((l) => l.lotNo === 'LOT-NEAR')!;
    const releasesAfterFirstCancel = near.movements.filter((m) => m.kind === 'release').length;
    await useScheduleStore.getState().cancel(draft.id, '测试员'); // 幂等
    near = (await db.supplies.toArray()).find((l) => l.lotNo === 'LOT-NEAR')!;
    assert.strictEqual(near.movements.filter((m) => m.kind === 'release').length, releasesAfterFirstCancel);
    assert.strictEqual(near.reservedQty, 0);
  });

  console.log('v2 → v3 迁移');

  await test('旧工序补出默认耗材明细，已完成工序状态不变', async () => {
    // 手工构造一个 v2 结构库（无 materials / reservedQty / movements）
    await db.close();
    await indexedDB.deleteDatabase('gbfossilprep');
    const DexieMod = await import('dexie');
    const v2db = new DexieMod.default('gbfossilprep');
    v2db.version(2).stores({
      specimens: 'id, specimenNo, taxon, locality, status, createdAt',
      procedures: 'id, specimenId, seq, stepType, state, startedAt',
      supplies: 'id, kind, lotNo, name, openedAt',
      photos: 'id, specimenId, procedureId, stage, capturedAt',
    });
    await v2db.open();
    await v2db.table('procedures').put({
      id: 'old-prc-1',
      specimenId: 'spm1',
      stepType: '加固',
      nodeName: '老加固',
      seq: 1,
      tools: ['渗透滴管'],
      abrasive: '',
      adhesive: 'Paraloid B-72',
      adhesiveConc: 5,
      durationMin: 30,
      tempC: 20,
      rh: 50,
      photoBeforeIds: [],
      photoAfterIds: [],
      operator: '老技师',
      startedAt: now - 2 * day,
      state: 'done',
      finishedAt: now - 2 * day + 30 * 60000,
    });
    await v2db.table('supplies').put({
      id: 'old-sup-1',
      name: 'Paraloid B-72',
      kind: '胶种',
      spec: '',
      lotNo: 'OLD-LOT',
      qty: 5,
      unit: '瓶',
      openedAt: now - 5 * day,
      shelfLifeMonths: 36,
      lowThreshold: 1,
      issues: [{ id: 'old-iss', qty: 2, operator: '老技师', specimenNo: 'OLD-1', issuedAt: now - day }],
    });
    v2db.close();

    // 重新以 v3 打开，触发 upgrade
    await db.open();
    const proc = await db.procedures.get('old-prc-1');
    assert.ok(proc!.materials.length >= 1, '旧工序应补出耗材明细');
    assert.ok(proc!.materials.every((m) => m.source === 'default'));
    assert.strictEqual(proc!.state, 'done', '旧完成工序仍保持已完成');
    assert.ok(proc!.finishedAt, '完成时间保留');
    const sup = await db.supplies.get('old-sup-1');
    assert.strictEqual(sup!.reservedQty, 0);
    assert.strictEqual(sup!.movements.length, 1, '旧领用应迁移成流水');
    assert.strictEqual(sup!.movements[0].kind, 'issue');
    assert.strictEqual(sup!.movements[0].qty, 2);
    assert.strictEqual(sup!.issues.length, 1, '旧 issues 字段保留');
    db.close();
  });

  console.log(`\n${passed} 项测试通过`);
}

main().then(() => {
  if (process.exitCode) {
    console.error('存在失败用例');
    process.exit(1);
  }
  console.log('全部通过');
  // BroadcastChannel / fake-indexeddb 会令事件循环保活，显式退出
  process.exit(0);
});
