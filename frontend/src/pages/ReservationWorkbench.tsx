import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Divider from '@mui/material/Divider';
import AddIcon from '@mui/icons-material/Add';
import InventoryIcon from '@mui/icons-material/Inventory';
import { useSpecimenStore } from '../stores/specimenStore';
import { useSupplyStore } from '../stores/supplyStore';
import { useReservationStore } from '../stores/reservationStore';
import { MeasureField } from '../components/common/MeasureField';
import {
  STEP_TYPES,
  DEFAULT_CONSUMABLES,
  type ProcedureConsumable,
  type StepType,
} from '../types/procedure';
import {
  RESERVATION_STATUS_LABEL,
  RESERVATION_STATUS_COLOR,
  type Reservation,
} from '../types/reservation';
import {
  STOCK_MOVEMENT_LABEL,
  STOCK_MOVEMENT_COLOR,
  shelfLifeLeftDays,
  type StockMovement,
} from '../types/supply';
import { allocateMaterials, aggregateDemand } from '../utils/allocate';

const OPERATOR_KEY = 'gbfossilprep:operator';

interface PlannedRow {
  key: string;
  specimenId: string;
  stepType: StepType;
  nodeName: string;
  consumables: ProcedureConsumable[];
}

function fmtTime(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** /reservations 按修复批次预留材料：勾选多件标本与计划工序，确认排程占用材料 */
export default function ReservationWorkbench() {
  const specimens = useSpecimenStore((s) => s.items);
  const lots = useSupplyStore((s) => s.items);
  const reservations = useReservationStore((s) => s.items);
  const saveDraft = useReservationStore((s) => s.saveDraft);
  const confirmReservation = useReservationStore((s) => s.confirm);
  const cancelReservation = useReservationStore((s) => s.cancel);
  const removeReservation = useReservationStore((s) => s.remove);

  const [operator, setOperator] = useState(() => {
    try {
      return window.localStorage.getItem(OPERATOR_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [rows, setRows] = useState<PlannedRow[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [editingRow, setEditingRow] = useState<PlannedRow | null>(null);
  const [detailTarget, setDetailTarget] = useState<Reservation | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Reservation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  useEffect(() => {
    try {
      window.localStorage.setItem(OPERATOR_KEY, operator);
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }, [operator]);

  const specimenNoOf = (id: string) => specimens.find((s) => s.id === id)?.specimenNo ?? '—';

  // 实时分配预览（不落库存）：临期优先、跳过过期、整份缺口
  const preview = useMemo(() => {
    const demand = aggregateDemand(rows);
    return { demand, result: allocateMaterials(lots, demand) };
  }, [rows, lots]);

  const addSpecimens = () => {
    const existing = new Set(rows.map((r) => r.specimenId));
    const additions = picked
      .filter((id) => !existing.has(id))
      .map((id) => ({
        key: `row_${id}_${Math.random().toString(36).slice(2, 7)}`,
        specimenId: id,
        stepType: '清修' as StepType,
        nodeName: '',
        consumables: DEFAULT_CONSUMABLES['清修'].map((c) => ({ ...c })),
      }));
    if (additions.length === 0) {
      setError('勾选的标本已在排程中');
      return;
    }
    setRows((prev) => [...prev, ...additions]);
    setPickerOpen(false);
    setPicked([]);
    setError('');
  };

  const updateRow = (key: string, patch: Partial<PlannedRow>) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, ...patch };
        if (patch.stepType && patch.stepType !== r.stepType) {
          // 切换工序类型时带出该类型的默认用量（保留已手工调整的数量）
          next.consumables = DEFAULT_CONSUMABLES[patch.stepType].map((c) => ({ ...c }));
        }
        return next;
      }),
    );
  };

  const updateConsumableQty = (key: string, name: string, qty: number) => {
    setRows((prev) =>
      prev.map((r) =>
        r.key === key
          ? {
              ...r,
              consumables: r.consumables.map((c) => (c.name === name ? { ...c, qty, source: 'manual' } : c)),
            }
          : r,
      ),
    );
    if (editingRow) {
      setEditingRow((cur) =>
        cur && cur.key === key
          ? {
              ...cur,
              consumables: cur.consumables.map((c) => (c.name === name ? { ...c, qty, source: 'manual' } : c)),
            }
          : cur,
      );
    }
  };

  const validate = (): string => {
    if (!operator.trim()) return '请先填写操作者';
    if (rows.length === 0) return '请先勾选标本并添加计划工序';
    return '';
  };

  const onSaveDraft = async () => {
    const msg = validate();
    if (msg) {
      setError(msg);
      return;
    }
    setBusy(true);
    try {
      const draft = await saveDraft({
        operator: operator.trim(),
        items: rows.map((r) => ({
          specimenId: r.specimenId,
          specimenNo: specimenNoOf(r.specimenId),
          stepType: r.stepType,
          nodeName: r.nodeName.trim(),
          consumables: r.consumables,
        })),
      });
      setRows([]);
      setError('');
      setToast(`已保存排程草稿 ${draft.code}，未动库存`);
    } finally {
      setBusy(false);
    }
  };

  const onConfirm = async (id: string) => {
    setBusy(true);
    try {
      const res = await confirmReservation(id);
      if (res.alreadyConfirmed) {
        setToast('该排程已确认过，库存仅记一次');
      } else if (res.ok) {
        setToast('排程已确认，材料按临期优先预占');
        setDetailTarget(null);
      } else {
        setError(`材料不足，整份排程未动库存：${(res.shortages ?? []).map((s) => `${s.name} 缺 ${s.missing} ${s.unit}`).join('；')}`);
        setDetailTarget(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const onCancel = async () => {
    if (!cancelTarget) return;
    setBusy(true);
    try {
      await cancelReservation(cancelTarget.id);
      setToast('排程已取消，预占材料按原批次退回');
      setCancelTarget(null);
      setDetailTarget(null);
    } finally {
      setBusy(false);
    }
  };

  const openDetail = (r: Reservation) => {
    setError('');
    setDetailTarget(r);
  };

  // 某排程单相关的库存变动（预占/退回）
  const movementsOf = (r: Reservation): { lot: string; mv: StockMovement }[] => {
    const out: { lot: string; mv: StockMovement }[] = [];
    for (const lot of lots) {
      for (const mv of lot.movements) {
        if (mv.reservationId === r.id) out.push({ lot: `${lot.name} ${lot.lotNo}`, mv });
      }
    }
    out.sort((a, b) => b.mv.at - a.mv.at);
    return out;
  };

  const shortageOf = (name: string) => preview.result.shortages.find((s) => s.name === name);
  const allocatedOf = (name: string) => preview.result.allocations.filter((a) => a.name === name);
  const skippedExpiredOf = (name: string) =>
    preview.result.skipped.filter((s) => s.name === name && s.reason === 'expired');

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <Typography variant="h5" fontWeight={700}>
          修复排程预留
        </Typography>
        <Chip size="small" variant="outlined" label="按批次预占 · 临期优先 · 过期跳过" />
        <Box sx={{ flex: 1 }} />
        <TextField
          size="small"
          label="操作者"
          value={operator}
          onChange={(e) => setOperator(e.target.value)}
          sx={{ width: 160 }}
          helperText="预占/退回均记录操作者"
        />
      </Stack>

      {error ? (
        <Alert severity="error" onClose={() => setError('')}>
          {error}
        </Alert>
      ) : null}

      {/* 计划编辑 */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
          <Typography variant="subtitle1" fontWeight={700}>
            计划工序（{rows.length}）
          </Typography>
          <Button size="small" startIcon={<AddIcon />} onClick={() => { setPicked([]); setPickerOpen(true); }}>
            勾选标本
          </Button>
          <Box sx={{ flex: 1 }} />
          <Button variant="outlined" onClick={onSaveDraft} disabled={busy || rows.length === 0}>
            保存草稿
          </Button>
        </Stack>

        {rows.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            尚未添加计划工序。点击「勾选标本」，一次勾选多件标本并选择计划工序，确认排程后将按临期批次预占材料。
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>标本号</TableCell>
                <TableCell>计划工序</TableCell>
                <TableCell>节点名</TableCell>
                <TableCell>计划耗材（默认用量，可调整）</TableCell>
                <TableCell align="right">操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>{specimenNoOf(row.specimenId)}</TableCell>
                  <TableCell>
                    <TextField
                      select
                      size="small"
                      value={row.stepType}
                      onChange={(e) => updateRow(row.key, { stepType: e.target.value as StepType })}
                      sx={{ minWidth: 110 }}
                    >
                      {STEP_TYPES.map((t) => (
                        <MenuItem key={t} value={t}>
                          {t}
                        </MenuItem>
                      ))}
                    </TextField>
                  </TableCell>
                  <TableCell>
                    <TextField
                      size="small"
                      placeholder="计划节点名（可空）"
                      value={row.nodeName}
                      onChange={(e) => updateRow(row.key, { nodeName: e.target.value })}
                      sx={{ minWidth: 160 }}
                    />
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                      {row.consumables.map((c) => (
                        <Chip
                          key={c.name}
                          size="small"
                          variant="outlined"
                          label={`${c.name} ${c.qty} ${c.unit}`}
                        />
                      ))}
                    </Stack>
                  </TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                      <Button size="small" onClick={() => setEditingRow(row)}>
                        调整用量
                      </Button>
                      <Button
                        size="small"
                        color="error"
                        onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                      >
                        移除
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {/* 需求与分配预览 */}
        {rows.length > 0 ? (
          <Box sx={{ mt: 2 }}>
            <Divider sx={{ mb: 1 }} />
            <Typography variant="subtitle2" gutterBottom>
              材料需求与批次分配预览
              <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                （确认排程时按此预占；材料不足整份不动）
              </Typography>
            </Typography>
            {preview.demand.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                当前计划工序无耗材需求。
              </Typography>
            ) : (
              <Stack spacing={0.75}>
                {preview.demand.map((d) => {
                  const short = shortageOf(d.name);
                  const allocs = allocatedOf(d.name);
                  const expired = skippedExpiredOf(d.name);
                  return (
                    <Box key={`${d.name}__${d.unit}`}>
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                        <Typography variant="body2" fontWeight={600}>
                          {d.name}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          需 {d.qty} {d.unit}
                        </Typography>
                        {short ? (
                          <Chip size="small" color="error" label={`缺口 ${short.missing} ${d.unit}（可用 ${short.available}）`} />
                        ) : (
                          <Chip size="small" color="success" variant="outlined" label="满足" />
                        )}
                      </Stack>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5, pl: 2 }}>
                        {allocs.map((a) => {
                          const lot = lots.find((l) => l.id === a.lotId);
                          const left = lot ? shelfLifeLeftDays(lot) : null;
                          return (
                            <Chip
                              key={a.lotId}
                              size="small"
                              color="info"
                              variant="outlined"
                              label={`${a.lotNo} 出 ${a.qty} ${a.unit}${left !== null && left <= 30 ? ` · 临期 ${left} 天` : ''}`}
                            />
                          );
                        })}
                        {expired.map((s) => (
                          <Chip key={s.lotId} size="small" color="default" variant="outlined" label={`${s.lotNo} 已过期 · 跳过`} />
                        ))}
                      </Stack>
                    </Box>
                  );
                })}
              </Stack>
            )}
            {!preview.result.ok ? (
              <Alert severity="warning" sx={{ mt: 1 }}>
                存在缺口材料，确认排程时整份保持原样、不动库存。可减少计划用量或先登记材料批次。
              </Alert>
            ) : null}
          </Box>
        ) : null}
      </Paper>

      {/* 排程单列表 */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={700} gutterBottom>
          排程单（{reservations.length}）
        </Typography>
        {reservations.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            暂无排程单。
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>单号</TableCell>
                <TableCell>状态</TableCell>
                <TableCell>计划内容</TableCell>
                <TableCell>预占批次</TableCell>
                <TableCell>操作者</TableCell>
                <TableCell>时间</TableCell>
                <TableCell align="right">操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {reservations.map((r) => (
                <TableRow key={r.id} hover>
                  <TableCell>{r.code}</TableCell>
                  <TableCell>
                    <Chip size="small" color={RESERVATION_STATUS_COLOR[r.status]} label={RESERVATION_STATUS_LABEL[r.status]} />
                  </TableCell>
                  <TableCell>
                    {r.items.length} 道工序 · {Array.from(new Set(r.items.map((i) => i.specimenNo))).join('、')}
                  </TableCell>
                  <TableCell>
                    {r.status === 'confirmed'
                      ? r.allocations.map((a) => `${a.lotNo} ${a.qty} ${a.unit}`).join('；')
                      : r.status === 'cancelled'
                        ? '已退回'
                        : '—'}
                  </TableCell>
                  <TableCell>{r.operator}</TableCell>
                  <TableCell>{fmtTime(r.updatedAt)}</TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                      <Button size="small" onClick={() => openDetail(r)}>
                        详情
                      </Button>
                      {r.status === 'draft' ? (
                        <>
                          <Button size="small" variant="contained" disabled={busy} onClick={() => onConfirm(r.id)}>
                            确认排程
                          </Button>
                          <Button size="small" color="error" disabled={busy} onClick={() => removeReservation(r.id)}>
                            删除
                          </Button>
                        </>
                      ) : null}
                      {r.status === 'confirmed' ? (
                        <Button size="small" color="warning" disabled={busy} onClick={() => setCancelTarget(r)}>
                          取消退回
                        </Button>
                      ) : null}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>

      {/* 勾选标本 */}
      <Dialog open={pickerOpen} onClose={() => setPickerOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>勾选标本（可一次多选）</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={0.5}>
            {specimens.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                暂无标本，请先到标本台账登记。
              </Typography>
            ) : (
              specimens.map((s) => {
                const added = rows.some((r) => r.specimenId === s.id);
                return (
                  <FormControlLabel
                    key={s.id}
                    control={
                      <Checkbox
                        checked={picked.includes(s.id) || added}
                        disabled={added}
                        onChange={(e) => {
                          setPicked((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id)));
                        }}
                      />
                    }
                    label={`${s.specimenNo} · ${s.taxon}${added ? '（已添加）' : ''}`}
                  />
                );
              })
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPickerOpen(false)}>取消</Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={addSpecimens} disabled={picked.length === 0}>
            添加 {picked.length} 件
          </Button>
        </DialogActions>
      </Dialog>

      {/* 调整用量 */}
      <Dialog open={!!editingRow} onClose={() => setEditingRow(null)} fullWidth maxWidth="xs">
        <DialogTitle>调整计划用量 · {editingRow ? specimenNoOf(editingRow.specimenId) : ''}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            {editingRow?.consumables.map((c) => (
              <MeasureField
                key={c.name}
                label={`${c.name}（${c.source === 'default' ? '默认用量' : '手工调整'}）`}
                unit={c.unit}
                min={0}
                max={100000}
                step={0.1}
                value={c.qty}
                onChange={(v) => updateConsumableQty(editingRow.key, c.name, v)}
              />
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditingRow(null)}>完成</Button>
        </DialogActions>
      </Dialog>

      {/* 排程详情 */}
      <Dialog open={!!detailTarget} onClose={() => setDetailTarget(null)} fullWidth maxWidth="md">
        {detailTarget ? (
          <>
            <DialogTitle>
              排程详情 · {detailTarget.code}
              <Chip
                size="small"
                color={RESERVATION_STATUS_COLOR[detailTarget.status]}
                label={RESERVATION_STATUS_LABEL[detailTarget.status]}
                sx={{ ml: 1 }}
              />
            </DialogTitle>
            <DialogContent dividers>
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={2} flexWrap="wrap">
                  <Typography variant="body2">操作者：{detailTarget.operator}</Typography>
                  <Typography variant="body2">建立：{fmtTime(detailTarget.createdAt)}</Typography>
                  <Typography variant="body2">更新：{fmtTime(detailTarget.updatedAt)}</Typography>
                </Stack>

                <Typography variant="subtitle2">计划工序</Typography>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>标本号</TableCell>
                      <TableCell>工序</TableCell>
                      <TableCell>节点名</TableCell>
                      <TableCell>耗材</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {detailTarget.items.map((it) => (
                      <TableRow key={it.id}>
                        <TableCell>{it.specimenNo}</TableCell>
                        <TableCell>{it.stepType}</TableCell>
                        <TableCell>{it.nodeName || '—'}</TableCell>
                        <TableCell>
                          {it.consumables.map((c) => `${c.name} ${c.qty} ${c.unit}`).join('；')}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                {detailTarget.status === 'confirmed' ? (
                  <>
                    <Typography variant="subtitle2">预占批次分配（取消时按此原批次退回）</Typography>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                      {detailTarget.allocations.map((a) => (
                        <Chip key={a.lotId} size="small" color="info" variant="outlined" icon={<InventoryIcon />} label={`${a.lotNo} 预占 ${a.qty} ${a.unit}`} />
                      ))}
                    </Stack>
                  </>
                ) : null}

                {detailTarget.shortages.length > 0 ? (
                  <>
                    <Typography variant="subtitle2" color="error">
                      缺口清单（整份排程未占用库存）
                    </Typography>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                      {detailTarget.shortages.map((s) => (
                        <Chip
                          key={s.name}
                          size="small"
                          color="error"
                          variant="outlined"
                          label={`${s.name} 需 ${s.need} ${s.unit} / 可用 ${s.available} / 缺 ${s.missing} ${s.unit}`}
                        />
                      ))}
                    </Stack>
                  </>
                ) : null}

                <Typography variant="subtitle2">库存变动记录（预占 / 退回，含操作者）</Typography>
                {movementsOf(detailTarget).length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    暂无库存变动（草稿未动库存）。
                  </Typography>
                ) : (
                  <Stack spacing={0.5}>
                    {movementsOf(detailTarget).map(({ lot, mv }) => (
                      <Stack key={mv.id} direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                        <Chip size="small" color={STOCK_MOVEMENT_COLOR[mv.type]} label={STOCK_MOVEMENT_LABEL[mv.type]} />
                        <Typography variant="body2">
                          {mv.operator} · {lot} · {mv.qty} {mv.note ? `（${mv.note}）` : ''} · {fmtTime(mv.at)}
                        </Typography>
                      </Stack>
                    ))}
                  </Stack>
                )}
              </Stack>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setDetailTarget(null)}>关闭</Button>
              {detailTarget.status === 'draft' ? (
                <Button
                  variant="contained"
                  disabled={busy}
                  onClick={() => onConfirm(detailTarget.id)}
                >
                  确认排程（预占材料）
                </Button>
              ) : null}
              {detailTarget.status === 'confirmed' ? (
                <Button color="warning" disabled={busy} onClick={() => setCancelTarget(detailTarget)}>
                  取消排程（退回预占）
                </Button>
              ) : null}
            </DialogActions>
          </>
        ) : null}
      </Dialog>

      {/* 取消确认 */}
      <Dialog open={!!cancelTarget} onClose={() => setCancelTarget(null)} maxWidth="xs">
        <DialogTitle>取消排程并退回预占材料？</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2">
            排程 {cancelTarget?.code} 已预占的材料将按原批次退回，库存恢复可用。该操作只记一次退回。
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCancelTarget(null)}>再想想</Button>
          <Button color="warning" variant="contained" disabled={busy} onClick={onCancel}>
            确认退回
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!toast} autoHideDuration={3000} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
