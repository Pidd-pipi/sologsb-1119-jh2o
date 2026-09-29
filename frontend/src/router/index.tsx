import { useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { useSupplyStore } from '../stores/supplyStore';
import { useScheduleStore } from '../stores/scheduleStore';
import { ensureSeedData, markDbVersion, readDbVersion } from '../utils/db';
import { useStockSync } from '../hooks/useStockSync';
import SpecimenList from '../pages/SpecimenList';
import SpecimenDetail from '../pages/SpecimenDetail';
import ProcedureForm from '../pages/ProcedureForm';
import SupplyList from '../pages/SupplyList';
import ScheduleWorkbench from '../pages/ScheduleWorkbench';
import ScheduleDetail from '../pages/ScheduleDetail';
import CompareView from '../pages/CompareView';

function fmt(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const specimens = useSpecimenStore((s) => s.items);
  const version = readDbVersion();
  const { notice, clear } = useStockSync();

  const navItems = useMemo(() => {
    const firstId = specimens[0]?.id;
    return [
      { label: '标本台账', path: '/specimens' },
      { label: '工序录入', path: '/procedures/new' },
      { label: '排程工作台', path: '/schedules' },
      { label: '材料台账', path: '/supplies' },
      { label: '前后对照', path: firstId ? `/compare/${firstId}` : '/specimens' },
    ];
  }, [specimens]);

  const activePrefix = (() => {
    if (location.pathname.startsWith('/specimens')) return '/specimens';
    if (location.pathname.startsWith('/procedures')) return '/procedures';
    if (location.pathname.startsWith('/schedules')) return '/schedules';
    if (location.pathname.startsWith('/supplies')) return '/supplies';
    if (location.pathname.startsWith('/compare')) return '/compare';
    return '/specimens';
  })();
  const active = navItems.findIndex((item) => item.path === activePrefix);

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'grey.50' }}>
      <AppBar position="static" color="default" elevation={1}>
        <Toolbar variant="dense">
          <Typography variant="h6" sx={{ fontWeight: 700, mr: 2 }}>
            化石修复工序档案
          </Typography>
          <Tabs
            value={active === -1 ? 0 : active}
            onChange={(_, idx) => navigate(navItems[idx].path)}
            textColor="primary"
            indicatorColor="primary"
            variant="scrollable"
            scrollButtons="auto"
          >
            {navItems.map((item) => (
              <Tab key={item.label} label={item.label} />
            ))}
          </Tabs>
          <Box sx={{ flex: 1 }} />
          <Chip size="small" variant="outlined" label={`本地结构版本 v${version}`} />
        </Toolbar>
      </AppBar>
      <Container maxWidth="xl" sx={{ py: 3 }}>
        {notice ? (
          <Alert
            severity="warning"
            sx={{ mb: 2 }}
            data-testid="stock-changed-notice"
            onClose={clear}
            action={
              <Chip
                size="small"
                color="primary"
                label="已刷新为最新库存"
                sx={{ mr: 1 }}
              />
            }
          >
            另一窗口（{notice.operator}）已于 {fmt(notice.at)} 改动库存：{notice.reason}。当前页面已重新载入并保留最新数量。
          </Alert>
        ) : null}
        <Routes>
          <Route path="/" element={<Navigate to="/specimens" replace />} />
          <Route path="/specimens" element={<SpecimenList />} />
          <Route path="/specimens/:id" element={<SpecimenDetail />} />
          <Route path="/procedures/new" element={<ProcedureForm />} />
          <Route path="/schedules" element={<ScheduleWorkbench />} />
          <Route path="/schedules/:id" element={<ScheduleDetail />} />
          <Route path="/supplies" element={<SupplyList />} />
          <Route path="/compare/:specimenId" element={<CompareView />} />
          <Route path="*" element={<Navigate to="/specimens" replace />} />
        </Routes>
      </Container>
    </Box>
  );
}

/** 应用路由 + 本地数据引导（IndexedDB 迁移 + 示范数据） */
export default function AppRouter() {
  const [ready, setReady] = useState(false);
  const loadSpecimens = useSpecimenStore((s) => s.load);
  const loadProcedures = useProcedureStore((s) => s.load);
  const loadSupplies = useSupplyStore((s) => s.load);
  const loadSchedules = useScheduleStore((s) => s.load);

  useEffect(() => {
    let alive = true;
    (async () => {
      await ensureSeedData();
      await markDbVersion();
      await Promise.all([loadSpecimens(), loadProcedures(), loadSupplies(), loadSchedules()]);
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [loadSpecimens, loadProcedures, loadSupplies, loadSchedules]);

  if (!ready) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ minHeight: '100vh' }} spacing={2}>
        <CircularProgress />
        <Typography variant="body2" color="text.secondary">
          正在打开本地档案库（IndexedDB）…
        </Typography>
      </Stack>
    );
  }

  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
