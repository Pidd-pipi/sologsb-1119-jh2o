import { useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useSpecimenStore } from '../stores/specimenStore';
import { useSupplyStore } from '../stores/supplyStore';
import { useScheduleStore, ScheduleStateError } from '../stores/scheduleStore';
import { MATERIAL_SOURCE_LABEL } from '../types/procedure';
import { SUPPLY_MOVEMENT_LABEL } from '../types/supply';
import { SCHEDULE_STATE_LABEL, SCHEDULE_STATE_COLOR } from '../types/schedule';

function fmt(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** /schedules/:id 排程详情：计划项、批次分配与预占/领用/退回轨迹 */
export default function ScheduleDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const specimens = useSpecimenStore((s) => s.items);
  const lots = useSupplyStore((s) => s.items);
  const schedule = useScheduleStore((s) => s.items.find((it) => it.id === id));
  const cancel = useScheduleStore((s) => s.cancel);
  const issueSchedule = useScheduleStore((s) => s.issue);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  /** 聚合该排程在所有批次上的库存流水：预占 / 领用 / 退回 + 操作者 */
  const trail = useMemo(() => {
    if (!schedule) return [];
    const refIds = new Set(schedule.allocations.map((a) => a.refId));
    return lots
      .flatMap((lot) =>
        (lot.movements ?? [])
          .filter((m) => m.scheduleId === schedule.id || (m.refId && refIds.has(m.refId)))
          .map((m) => ({ ...m, lotNo: lot.lotNo, unit: lot.unit, name: lot.name })),
      )
      .sort((a, b) => a.at - b.at);
  }, [schedule, lots]);

  if (!schedule) {
    return (
      <Stack spacing={2}>
        <Alert severity="warning">未找到该排程。</Alert>
        <Button component={RouterLink} to="/schedules" variant="outlined" startIcon={<ArrowBackIcon />}>
          返回排程工作台
        </Button>
      </Stack>
    );
  }

  const noOf = (sid: string) => specimens.find((s) => s.id === sid)?.specimenNo ?? sid;

  const guard = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setToast(ok);
    } catch (e) {
      setError(e instanceof ScheduleStateError ? e.message : '操作失败');
    }
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/schedules')}>
          返回
        </Button>
        <Typography variant="h5" fontWeight={700}>
          排程 {schedule.scheduleNo}
        </Typography>
        <Chip color={SCHEDULE_STATE_COLOR[schedule.state]} label={SCHEDULE_STATE_LABEL[schedule.state]} />
      </Stack>

      {error ? (
        <Alert severity="error" onClose={() => setError('')}>
          {error}
        </Alert>
      ) : null}

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" spacing={3} flexWrap="wrap" rowGap={0.5}>
          <Typography variant="body2">操作人：{schedule.operator}</Typography>
          <Typography variant="body2">创建：{fmt(schedule.createdAt)}</Typography>
          <Typography variant="body2">确认：{fmt(schedule.confirmedAt)}</Typography>
          <Typography variant="body2">领用：{fmt(schedule.issuedAt)}</Typography>
          <Typography variant="body2">取消：{fmt(schedule.cancelledAt)}</Typography>
        </Stack>
        {schedule.remark ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            备注：{schedule.remark}
          </Typography>
        ) : null}
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={700} gutterBottom>
          计划工序与耗材（{schedule.items.length}）
        </Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>标本</TableCell>
              <TableCell>工序</TableCell>
              <TableCell>节点</TableCell>
              <TableCell>耗材明细</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {schedule.items.map((item) => (
              <TableRow key={item.rowId}>
                <TableCell>{noOf(item.specimenId)}</TableCell>
                <TableCell>{item.stepType}</TableCell>
                <TableCell>{item.nodeName}</TableCell>
                <TableCell>
                  {item.materials.map((m, i) => (
                    <Chip
                      key={i}
                      size="small"
                      sx={{ mr: 0.5, mb: 0.5 }}
                      label={`${m.name} ${m.qty}${m.unit}·${MATERIAL_SOURCE_LABEL[m.source]}`}
                      title={m.note}
                      variant={m.source === 'default' ? 'outlined' : 'filled'}
                    />
                  ))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={700} gutterBottom>
          批次占用 / 领用 / 退回
        </Typography>
        {schedule.allocations.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            草稿尚未确认，无批次占用。
          </Typography>
        ) : (
          <Table size="small" data-testid="schedule-allocations">
            <TableHead>
              <TableRow>
                <TableCell>批号</TableCell>
                <TableCell>材料</TableCell>
                <TableCell align="right">预占</TableCell>
                <TableCell align="right">已领用</TableCell>
                <TableCell align="right">已退回</TableCell>
                <TableCell>状态</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {schedule.allocations.map((a) => {
                const released = Math.round((a.qty - a.issuedQty - a.returnedQty) * 1000) / 1000;
                return (
                  <TableRow key={a.refId}>
                    <TableCell>{a.lotNo}</TableCell>
                    <TableCell>{a.name}</TableCell>
                    <TableCell align="right">
                      {a.qty} {a.unit}
                    </TableCell>
                    <TableCell align="right">
                      {a.issuedQty} {a.unit}
                    </TableCell>
                    <TableCell align="right">
                      {a.returnedQty} {a.unit}
                    </TableCell>
                    <TableCell>
                      {a.returnedQty > 0 ? (
                        <Chip size="small" color="warning" label="已退回" />
                      ) : a.issuedQty >= a.qty ? (
                        <Chip size="small" color="success" label="已领用" />
                      ) : released > 0 ? (
                        <Chip size="small" color="info" label={`预占中 ${released}${a.unit}`} />
                      ) : (
                        <Chip size="small" label="—" />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          取消时已领用部分按原批次实物退回、未领用部分仅解除预占；重复取消/确认只记一次库存变化。
        </Typography>
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={700} gutterBottom>
          库存操作轨迹（预占 / 领用 / 解除 / 退回）
        </Typography>
        {trail.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            尚无库存操作（草稿未确认不产生流水）。
          </Typography>
        ) : (
          <Table size="small" data-testid="schedule-trail">
            <TableHead>
              <TableRow>
                <TableCell>时间</TableCell>
                <TableCell>类型</TableCell>
                <TableCell>批号</TableCell>
                <TableCell>材料</TableCell>
                <TableCell align="right">数量</TableCell>
                <TableCell>操作者</TableCell>
                <TableCell>说明</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {trail.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{fmt(m.at)}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      color={m.kind === 'reserve' ? 'info' : m.kind === 'issue' ? 'success' : m.kind === 'return' ? 'warning' : 'default'}
                      label={SUPPLY_MOVEMENT_LABEL[m.kind]}
                    />
                  </TableCell>
                  <TableCell>{m.lotNo}</TableCell>
                  <TableCell>{m.name}</TableCell>
                  <TableCell align="right">
                    {m.qty} {m.unit}
                  </TableCell>
                  <TableCell>{m.operator}</TableCell>
                  <TableCell>
                    <Typography variant="caption">{m.note}</Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>

      <Stack direction="row" spacing={1}>
        {schedule.state === 'confirmed' ? (
          <Button
            variant="contained"
            onClick={() => guard(() => issueSchedule(schedule.id, schedule.operator), '排程已领用')}
          >
            整单领用
          </Button>
        ) : null}
        {(schedule.state === 'confirmed' || schedule.state === 'issued') ? (
          <Button color="warning" variant="outlined" onClick={() => guard(() => cancel(schedule.id, schedule.operator), '已取消，材料按原批次退回')}>
            取消排程并退回
          </Button>
        ) : null}
      </Stack>

      <Snackbar open={!!toast} autoHideDuration={2400} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
