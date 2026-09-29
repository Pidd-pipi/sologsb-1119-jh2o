import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Checkbox from '@mui/material/Checkbox';
import IconButton from '@mui/material/IconButton';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Divider from '@mui/material/Divider';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import EventAvailableIcon from '@mui/icons-material/EventAvailable';
import SaveIcon from '@mui/icons-material/Save';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { useSupplyStore } from '../stores/supplyStore';
import { useScheduleStore, ScheduleStockError, ScheduleStateError } from '../stores/scheduleStore';
import { planAllocation } from '../utils/allocation';
import { newId } from '../utils/id';
import { lotAvailable, shelfLifeLeftDays, NEAR_EXPIRE_DAYS, type SupplyLot } from '../types/supply';
import { defaultMaterialsForProcedure, MATERIAL_SOURCE_LABEL, type ProcedureMaterial, type StepType } from '../types/procedure';
import type { PrepSchedule, ScheduleItem } from '../types/schedule';

/** /schedules 修复批次排程工作台 */
export default function ScheduleWorkbench() {
  const navigate = useNavigate();
  const specimens = useSpecimenStore((s) => s.items);
  const procedures = useProcedureStore((s) => s.items);
  const lots = useSupplyStore((s) => s.items);
  const schedules = useScheduleStore((s) => s.items);
  const loadSchedules = useScheduleStore((s) => s.load);
  const saveDraft = useScheduleStore((s) => s.saveDraft);
  const confirm = useScheduleStore((s) => s.confirm);
  const cancel = useScheduleStore((s) => s.cancel);
  const issueSchedule = useScheduleStore((s) => s.issue);
  const removeDraft = useScheduleStore((s) => s.removeDraft);

  const [checkedSpecimens, setCheckedSpecimens] = useState<string[]>([]);
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [operator, setOperator] = useState('');
  const [remark, setRemark] = useState('');
  const [editId, setEditId] = useState<string | undefined>(undefined);
  const [error, setError] = useState('');
  const [gap, setGap] = useState<ScheduleStockError | null>(null);
  const [toast, setToast] = useState('');

  const specimenNoOf = useMemo(() => {
    const map = new Map(specimens.map((s) => [s.id, s.specimenNo]));
    return (sid: string) => map.get(sid) ?? sid;
  }, [specimens]);

  /** 可供勾选的计划工序：待办 / 已回退，且没有挂在其它未终结排程上 */
  const takenProcedureIds = useMemo(() => {
    const set = new Set<string>();
    for (const sch of schedules) {
      if (sch.state === 'cancelled') continue;
      for (const it of sch.items) if (it.procedureId) set.add(it.procedureId);
    }
    return set;
  }, [schedules]);

  const candidateProcedures = useMemo(
    () =>
      procedures
        .filter((p) => p.state !== 'done')
        .filter((p) => !takenProcedureIds.has(p.id) || items.some((it) => it.procedureId === p.id)),
    [procedures, takenProcedureIds, items],
  );

  const plan = useMemo(() => planAllocation(items, lots, specimenNoOf), [items, lots, specimenNoOf]);

  const toggleSpecimen = (specimenId: string) => {
    setGap(null);
    setError('');
    const on = !checkedSpecimens.includes(specimenId);
    let nextItems = items;
    if (on) {
      const autoItems: ScheduleItem[] = candidateProcedures
        .filter((p) => p.specimenId === specimenId)
        .filter((p) => !items.some((it) => it.procedureId === p.id))
        .map((p) => ({
          rowId: newId('row'),
          specimenId: p.specimenId,
          procedureId: p.id,
          stepType: p.stepType,
          nodeName: p.nodeName,
          materials: p.materials?.length ? p.materials.map((m) => ({ ...m })) : defaultMaterialsForProcedure(p),
        }));
      nextItems = [...items, ...autoItems];
    } else {
      nextItems = items.filter((it) => it.specimenId !== specimenId);
    }
    setItems(nextItems);
    setCheckedSpecimens(on ? [...checkedSpecimens, specimenId] : checkedSpecimens.filter((id) => id !== specimenId));
  };

  const addManualItem = () => {
    const specimenId = checkedSpecimens[0] ?? specimens[0]?.id;
    if (!specimenId) {
      setError('请先勾选标本');
      return;
    }
    const stepType: StepType = '清修';
    setItems([
      ...items,
      {
        rowId: newId('row'),
        specimenId,
        stepType,
        nodeName: '临时增补工序',
        materials: defaultMaterialsForProcedure({ stepType }),
      },
    ]);
  };

  const updateItem = (rowId: string, patch: Partial<ScheduleItem>) => {
    setItems(items.map((it) => (it.rowId === rowId ? { ...it, ...patch } : it)));
  };

  const changeItemSpecimen = (rowId: string, specimenId: string) => {
    updateItem(rowId, { specimenId, procedureId: undefined });
  };

  const changeStepType = (rowId: string, stepType: StepType) => {
    const item = items.find((it) => it.rowId === rowId);
    updateItem(rowId, {
      stepType,
      nodeName: item?.nodeName && item.nodeName !== '临时增补工序' ? item.nodeName : `${stepType}工序`,
      materials: defaultMaterialsForProcedure({ stepType }),
      procedureId: undefined,
    });
  };

  const updateMaterial = (rowId: string, idx: number, patch: Partial<ProcedureMaterial>) => {
    setItems(
      items.map((it) =>
        it.rowId === rowId ? { ...it, materials: it.materials.map((m, i) => (i === idx ? { ...m, ...patch } : m)) } : it,
      ),
    );
  };

  const addMaterial = (rowId: string) => {
    const first = lots[0];
    setItems(
      items.map((it) =>
        it.rowId === rowId
          ? {
              ...it,
              materials: [
                ...it.materials,
                { name: first?.name ?? '', qty: 1, unit: first?.unit ?? '件', source: 'manual' },
              ],
            }
          : it,
      ),
    );
  };

  const removeItem = (rowId: string) => {
    const target = items.find((it) => it.rowId === rowId);
    setItems(items.filter((it) => it.rowId !== rowId));
    if (target) {
      const stillHas = items.some((it) => it.rowId !== rowId && it.specimenId === target.specimenId);
      if (!stillHas) setCheckedSpecimens((prev) => prev.filter((id) => id !== target.specimenId));
    }
  };

  const resetEditor = () => {
    setItems([]);
    setCheckedSpecimens([]);
    setOperator('');
    setRemark('');
    setEditId(undefined);
    setGap(null);
    setError('');
  };

  const startEdit = (sch: PrepSchedule) => {
    if (sch.state !== 'draft') {
      navigate(`/schedules/${sch.id}`);
      return;
    }
    setEditId(sch.id);
    setItems(sch.items.map((it) => ({ ...it, rowId: it.rowId || newId('row'), materials: it.materials.map((m) => ({ ...m })) })));
    setCheckedSpecimens([...new Set(sch.items.map((it) => it.specimenId))]);
    setOperator(sch.operator);
    setRemark(sch.remark ?? '');
    setGap(null);
    setError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const doSaveDraft = async () => {
    if (items.length === 0) {
      setError('请先勾选标本与计划工序');
      return;
    }
    if (!operator.trim()) {
      setError('操作人必填');
      return;
    }
    const rec = await saveDraft(editId, { items, operator: operator.trim(), remark: remark.trim() || undefined });
    setToast(`草稿 ${rec.scheduleNo} 已保存（未动库存）`);
    setEditId(rec.id);
    await loadSchedules();
  };

  const doConfirm = async () => {
    setGap(null);
    if (items.length === 0) {
      setError('请先勾选标本与计划工序');
      return;
    }
    if (!operator.trim()) {
      setError('操作人必填');
      return;
    }
    if (!plan.ok) {
      // 前端预校验直接给出缺口，不发起事务
      setGap(new ScheduleStockError(plan.shortages, plan.skippedExpired));
      setError('材料不足：整份排程保持原样，请先补齐缺口或调整数量');
      return;
    }
    try {
      // 先落草稿（仍不动库存），再在同一数据上确认预占
      const draft = await saveDraft(editId, { items, operator: operator.trim(), remark: remark.trim() || undefined });
      const rec = await confirm(draft.id, operator.trim(), specimenNoOf);
      setToast(`排程 ${rec.scheduleNo} 已确认，材料按批次预占完成`);
      resetEditor();
      await loadSchedules();
    } catch (e) {
      if (e instanceof ScheduleStockError) {
        setGap(e);
        setError('材料不足：整份排程保持原样，缺口如下');
      } else if (e instanceof ScheduleStateError) {
        setError(e.message);
      } else {
        setError('确认失败，请重试');
      }
    }
  };

  const doCancel = async (sch: PrepSchedule) => {
    try {
      const rec = await cancel(sch.id, operator.trim() || sch.operator);
      setToast(rec.confirmedAt ? `排程 ${sch.scheduleNo} 已取消，材料按原批次退回` : `草稿 ${sch.scheduleNo} 已取消（库存未动）`);
      await loadSchedules();
    } catch (e) {
      setError(e instanceof Error ? e.message : '取消失败');
    }
  };

  const doIssue = async (sch: PrepSchedule) => {
    try {
      const rec = await issueSchedule(sch.id, operator.trim() || sch.operator);
      void rec;
      setToast(`排程 ${sch.scheduleNo} 已领用`);
      await loadSchedules();
    } catch (e) {
      setError(e instanceof Error ? e.message : '领用失败');
    }
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <EventAvailableIcon color="primary" />
        <Typography variant="h5" fontWeight={700}>
          修复批次排程工作台
        </Typography>
        <Chip size="small" variant="outlined" label={`排程 ${schedules.length} 份`} />
        <Box sx={{ flex: 1 }} />
        <Button onClick={() => navigate('/supplies')}>材料台账</Button>
      </Stack>

      {error ? (
        <Alert severity="error" data-testid="schedule-error" onClose={() => setError('')}>
          {error}
        </Alert>
      ) : null}

      {gap && gap.shortages.length > 0 ? (
        <Alert severity="warning" data-testid="schedule-gap" sx={{ alignItems: 'flex-start' }}>
          <Typography variant="body2" fontWeight={700} gutterBottom>
            缺口清单（库存未发生任何变化）
          </Typography>
          {gap.shortages.map((s) => (
            <Box key={`${s.name}-${s.unit}`}>
              <Typography variant="body2">
                {s.name}：需 {s.qty} {s.unit}，缺 {s.missingQty} {s.unit}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                用于：{s.rows.map((r) => `${r.specimenNo}/${r.nodeName}(${r.qty}${s.unit})`).join('、')}
              </Typography>
            </Box>
          ))}
        </Alert>
      ) : null}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 380px' }, gap: 2 }}>
        {/* 左：勾选与计划项 */}
        <Stack spacing={2}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle1" fontWeight={700} gutterBottom>
              1. 勾选标本（自动带出待办/已回退工序）
            </Typography>
            <Stack spacing={0.5}>
              {specimens.map((s) => {
                const count = candidateProcedures.filter((p) => p.specimenId === s.id).length;
                return (
                  <Stack key={s.id} direction="row" alignItems="center" spacing={1}>
                    <Checkbox
                      size="small"
                      checked={checkedSpecimens.includes(s.id)}
                      onChange={() => toggleSpecimen(s.id)}
                      data-testid={`specimen-check-${s.specimenNo}`}
                    />
                    <Typography variant="body2" sx={{ flex: 1 }}>
                      {s.specimenNo} · {s.taxon}
                    </Typography>
                    <Chip size="small" label={`${count} 道计划工序`} />
                    <Chip size="small" variant="outlined" label={s.status} />
                  </Stack>
                );
              })}
              {specimens.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  暂无标本。
                </Typography>
              ) : null}
            </Stack>
          </Paper>

          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
              <Typography variant="subtitle1" fontWeight={700}>
                2. 计划工序与耗材明细
              </Typography>
              <Chip size="small" label={`${items.length} 行`} />
              <Box sx={{ flex: 1 }} />
              <Button size="small" startIcon={<AddIcon />} onClick={addManualItem}>
                临时增补工序
              </Button>
            </Stack>

            {items.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                尚未勾选任何标本，或标本下没有待办工序。
              </Typography>
            ) : (
              <Stack spacing={1.5}>
                {items.map((item) => (
                  <ScheduleItemEditor
                    key={item.rowId}
                    item={item}
                    specimens={specimens}
                    lots={lots}
                    checkedSpecimens={checkedSpecimens}
                    onSpecimenChange={(sid) => changeItemSpecimen(item.rowId, sid)}
                    onStepTypeChange={(t) => changeStepType(item.rowId, t)}
                    onNodeName={(v) => updateItem(item.rowId, { nodeName: v })}
                    onRemove={() => removeItem(item.rowId)}
                    onMaterialChange={(idx, patch) => updateMaterial(item.rowId, idx, patch)}
                    onAddMaterial={() => addMaterial(item.rowId)}
                    onRemoveMaterial={(idx) =>
                      updateItem(item.rowId, { materials: item.materials.filter((_, i) => i !== idx) })
                    }
                  />
                ))}
              </Stack>
            )}
          </Paper>

          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle1" fontWeight={700} gutterBottom>
              3. 操作人与排程动作
            </Typography>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
              <TextField
                size="small"
                label="操作人"
                required
                value={operator}
                onChange={(e) => setOperator(e.target.value)}
                sx={{ minWidth: 160 }}
              />
              <TextField
                size="small"
                fullWidth
                label="备注"
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
              />
            </Stack>
            <Stack direction="row" spacing={1} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
              <Button variant="contained" color="primary" onClick={doConfirm} disabled={items.length === 0}>
                确认排程（占用材料）
              </Button>
              <Button variant="outlined" startIcon={<SaveIcon />} onClick={doSaveDraft} disabled={items.length === 0}>
                保存草稿
              </Button>
              <Button onClick={resetEditor}>{editId ? '放弃编辑' : '清空'}</Button>
              {editId ? <Chip size="small" color="default" label={`正在编辑草稿 ${editId.slice(-6)}`} /> : null}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              草稿不改动任何库存；确认时按「临期优先、跳过过期」自动分配，材料不足则整份排程保持原样。
            </Typography>
          </Paper>
        </Stack>

        {/* 右：实时分配预览 */}
        <Paper variant="outlined" sx={{ p: 2, height: 'fit-content', position: { lg: 'sticky' }, top: 16 }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            分配预览（FEFO 临期优先）
          </Typography>
          {plan.allocations.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              勾选工序后显示批次分配。
            </Typography>
          ) : (
            <Stack spacing={1.5}>
              {plan.allocations.map((grouped) => {
                const filled = grouped.slices.reduce((sum, s) => sum + s.qty, 0);
                const missing = Math.round((grouped.qty - filled) * 1000) / 1000;
                return (
                  <Box key={`${grouped.name}-${grouped.unit}`}>
                    <Stack direction="row" alignItems="center" spacing={1}>
                      <Typography variant="body2" fontWeight={700}>
                        {grouped.name}
                      </Typography>
                      <Chip size="small" label={`需 ${grouped.qty} ${grouped.unit}`} />
                      {missing > 0 ? <Chip size="small" color="error" label={`缺 ${missing}`} /> : null}
                    </Stack>
                    {grouped.slices.map((s) => (
                      <Stack key={s.lotId} direction="row" spacing={1} sx={{ pl: 1, mt: 0.5 }} alignItems="center">
                        <Chip
                          size="small"
                          color={s.leftDays <= NEAR_EXPIRE_DAYS ? 'warning' : 'success'}
                          variant={s.leftDays <= NEAR_EXPIRE_DAYS ? 'filled' : 'outlined'}
                          label={s.leftDays <= NEAR_EXPIRE_DAYS ? `临期 ${s.leftDays}天` : `${s.leftDays}天`}
                        />
                        <Typography variant="caption">
                          {s.lotNo} 取 {s.qty} {s.unit}（可用 {s.available}）
                        </Typography>
                      </Stack>
                    ))}
                  </Box>
                );
              })}
              {plan.skippedExpired.length > 0 ? (
                <>
                  <Divider />
                  <Typography variant="caption" color="error.main">
                    已跳过过期批次：
                    {plan.skippedExpired.map((l) => `${l.lotNo}（剩 ${shelfLifeLeftDays(l)} 天）`).join('、')}
                  </Typography>
                </>
              ) : null}
            </Stack>
          )}
        </Paper>
      </Box>

      <Divider />

      <ScheduleList
        schedules={schedules}
        specimenNoOf={specimenNoOf}
        onEdit={startEdit}
        onCancel={doCancel}
        onIssue={doIssue}
        onRemove={async (sch) => {
          await removeDraft(sch.id);
          if (editId === sch.id) resetEditor();
          setToast('草稿已删除');
        }}
      />

      <Snackbar open={!!toast} autoHideDuration={2600} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}

/** 单个计划工序编辑卡片 */
function ScheduleItemEditor(props: {
  item: ScheduleItem;
  specimens: ReturnType<typeof useSpecimenStore.getState>['items'];
  lots: SupplyLot[];
  checkedSpecimens: string[];
  onSpecimenChange: (sid: string) => void;
  onStepTypeChange: (t: StepType) => void;
  onNodeName: (v: string) => void;
  onRemove: () => void;
  onMaterialChange: (idx: number, patch: Partial<ProcedureMaterial>) => void;
  onAddMaterial: () => void;
  onRemoveMaterial: (idx: number) => void;
}) {
  const { item, specimens, lots, onMaterialChange } = props;
  const selectableSpecimens = specimens.filter((s) => props.checkedSpecimens.includes(s.id) || s.id === item.specimenId);

  return (
    <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'grey.50' }} data-testid={`schedule-item-${item.nodeName}`}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'center' }}>
        <TextField
          select
          size="small"
          label="标本"
          value={item.specimenId}
          onChange={(e) => props.onSpecimenChange(e.target.value)}
          sx={{ minWidth: 220 }}
        >
          {selectableSpecimens.map((s) => (
            <MenuItem key={s.id} value={s.id}>
              {s.specimenNo}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="工序类型"
          value={item.stepType}
          disabled={!!item.procedureId}
          onChange={(e) => props.onStepTypeChange(e.target.value as StepType)}
          sx={{ width: 130 }}
        >
          {(['清修', '加固', '粘接', '补配', '翻模'] as StepType[]).map((t) => (
            <MenuItem key={t} value={t}>
              {t}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          label="节点名称"
          value={item.nodeName}
          disabled={!!item.procedureId}
          onChange={(e) => props.onNodeName(e.target.value)}
          sx={{ flex: 1, minWidth: 180 }}
        />
        {item.procedureId ? <Chip size="small" color="info" variant="outlined" label="挂接计划工序" /> : null}
        <IconButton size="small" color="error" onClick={props.onRemove}>
          <DeleteIcon fontSize="small" />
        </IconButton>
      </Stack>

      <Table size="small" sx={{ mt: 1 }}>
        <TableHead>
          <TableRow>
            <TableCell>材料</TableCell>
            <TableCell sx={{ width: 150 }}>用量</TableCell>
            <TableCell>单位</TableCell>
            <TableCell>来源</TableCell>
            <TableCell align="right">操作</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {item.materials.map((m, idx) => (
            <TableRow key={idx}>
              <TableCell>
                <TextField
                  select
                  size="small"
                  fullWidth
                  value={m.name}
                  onChange={(e) => {
                    const lot = lots.find((l) => l.name === e.target.value);
                    onMaterialChange(idx, { name: e.target.value, unit: lot?.unit ?? m.unit, source: 'manual' });
                  }}
                >
                  {[...new Set(lots.map((l) => l.name))].map((name) => (
                    <MenuItem key={name} value={name}>
                      {name}
                    </MenuItem>
                  ))}
                </TextField>
              </TableCell>
              <TableCell>
                <TextField
                  size="small"
                  type="number"
                  value={m.qty}
                  inputProps={{ min: 0, step: 0.5 }}
                  onChange={(e) => onMaterialChange(idx, { qty: Number(e.target.value) })}
                />
              </TableCell>
              <TableCell>{m.unit}</TableCell>
              <TableCell>
                <Chip
                  size="small"
                  variant={m.source === 'default' ? 'outlined' : 'filled'}
                  color={m.source === 'default' ? 'secondary' : 'primary'}
                  label={MATERIAL_SOURCE_LABEL[m.source]}
                  title={m.note}
                />
              </TableCell>
              <TableCell align="right">
                <IconButton size="small" onClick={() => props.onRemoveMaterial(idx)}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Button size="small" startIcon={<AddIcon />} onClick={props.onAddMaterial}>
        添加耗材
      </Button>
    </Paper>
  );
}

/** 既有排程列表与行内动作 */
export function ScheduleList(props: {
  schedules: PrepSchedule[];
  specimenNoOf: (sid: string) => string;
  onEdit: (sch: PrepSchedule) => void;
  onCancel: (sch: PrepSchedule) => void;
  onIssue: (sch: PrepSchedule) => void;
  onRemove: (sch: PrepSchedule) => void;
}) {
  const navigate = useNavigate();
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={700} gutterBottom>
        修复批次排程
      </Typography>
      {props.schedules.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          暂无排程。
        </Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>排程单号</TableCell>
              <TableCell>状态</TableCell>
              <TableCell>标本 / 工序</TableCell>
              <TableCell>批次分配</TableCell>
              <TableCell>操作人</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {props.schedules.map((sch) => {
              const label = sch.state === 'draft' ? '草稿' : sch.state === 'confirmed' ? '已确认' : sch.state === 'issued' ? '已领用' : '已取消';
              const color = sch.state === 'draft' ? 'default' : sch.state === 'confirmed' ? 'info' : sch.state === 'issued' ? 'success' : 'error';
              return (
                <TableRow key={sch.id} hover data-testid={`schedule-row-${sch.scheduleNo}`}>
                  <TableCell>
                    <Button size="small" onClick={() => navigate(`/schedules/${sch.id}`)}>
                      {sch.scheduleNo}
                    </Button>
                  </TableCell>
                  <TableCell>
                    <Chip size="small" color={color as 'default'} label={label} />
                  </TableCell>
                  <TableCell>
                    {[...new Set(sch.items.map((it) => props.specimenNoOf(it.specimenId)))].join('、')}
                    <Typography variant="caption" color="text.secondary" display="block">
                      {sch.items.length} 道工序
                    </Typography>
                  </TableCell>
                  <TableCell>
                    {sch.allocations.length === 0
                      ? '—'
                      : sch.allocations.map((a) => `${a.lotNo}×${a.qty}${a.unit}`).join('、')}
                  </TableCell>
                  <TableCell>{sch.operator}</TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                      {sch.state === 'draft' ? (
                        <>
                          <Button size="small" onClick={() => props.onEdit(sch)}>
                            编辑
                          </Button>
                          <Button size="small" color="error" onClick={() => props.onRemove(sch)}>
                            删除
                          </Button>
                        </>
                      ) : null}
                      {sch.state === 'confirmed' ? (
                        <>
                          <Button size="small" variant="contained" onClick={() => props.onIssue(sch)}>
                            领用
                          </Button>
                          <Button size="small" color="warning" onClick={() => props.onCancel(sch)}>
                            取消并退回
                          </Button>
                        </>
                      ) : null}
                      {sch.state === 'issued' ? (
                        <Button size="small" color="warning" onClick={() => props.onCancel(sch)}>
                          取消并退回
                        </Button>
                      ) : null}
                      {sch.state === 'cancelled' ? (
                        <Chip size="small" variant="outlined" label="重复取消不会再动库存" />
                      ) : null}
                    </Stack>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Paper>
  );
}

