import { useEffect, useRef, useState } from 'react';
import { subscribeStockChange, type StockChangePayload } from '../utils/stockSync';
import { db } from '../utils/db';
import { useSupplyStore } from '../stores/supplyStore';
import { useScheduleStore } from '../stores/scheduleStore';

/**
 * 监听其它窗口的库存变更：
 * 收到通知后直接从 IndexedDB 重新读取批次（界面保留新数量），并挂出提示条。
 */
export function useStockSync(): { notice: StockChangePayload | null; clear: () => void } {
  const [notice, setNotice] = useState<StockChangePayload | null>(null);
  // BroadcastChannel 与 storage 兜底可能同时送达，按时间戳去重
  const lastAt = useRef(0);

  useEffect(() => {
    let alive = true;
    const unsub = subscribeStockChange(async (payload) => {
      if (payload.at <= lastAt.current) return;
      lastAt.current = payload.at;
      // 直接落库读最新数量，保证当前窗口展示新库存而不是旧缓存
      const latestLots = await db.supplies.toArray();
      latestLots.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
      useSupplyStore.setState({ items: latestLots });
      await useScheduleStore.getState().load();
      if (alive) setNotice(payload);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  return { notice, clear: () => setNotice(null) };
}
