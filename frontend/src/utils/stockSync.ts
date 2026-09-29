/**
 * 跨窗口库存变更通知。
 * 主通道用 BroadcastChannel；不支持时用 storage 事件（localStorage 版本号）兜底。
 * 任一窗口改动库存后 bumpStockVersion，其它窗口收到提示并刷新、保留最新数量。
 */

const CHANNEL_NAME = 'gbfossilprep:stock';
const VERSION_KEY = 'gbfossilprep:stock-version';
const PAYLOAD_KEY = 'gbfossilprep:stock-last-change';

export interface StockChangePayload {
  at: number;
  /** 操作人 */
  operator: string;
  /** 变更摘要，如「确认排程 PS-xxx 预占」「手填领用」 */
  reason: string;
  /** 发起窗口标识，用来忽略自己发出的消息 */
  origin: string;
}

let channel: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
  }
} catch {
  channel = null;
}

function readVersion(): number {
  try {
    return Number(window.localStorage.getItem(VERSION_KEY) || '0') || 0;
  } catch {
    return 0;
  }
}

/** 本窗口改动库存后调用：写版本号并广播 */
export function bumpStockVersion(reason: string, operator = ''): void {
  const payload: StockChangePayload = { at: Date.now(), reason, operator: operator || '当前窗口', origin: windowId() };
  try {
    window.localStorage.setItem(VERSION_KEY, String(readVersion() + 1));
    window.localStorage.setItem(PAYLOAD_KEY, JSON.stringify(payload));
  } catch {
    /* localStorage 不可用时仅靠 BroadcastChannel */
  }
  channel?.postMessage(payload);
}

/** 当前窗口唯一标识（会话级） */
export function windowId(): string {
  const KEY = 'gbfossilprep:win-id';
  try {
    let id = window.sessionStorage.getItem(KEY);
    if (!id) {
      id = `win-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      window.sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return 'win-unknown';
  }
}

export function readLastChange(): StockChangePayload | null {
  try {
    const raw = window.localStorage.getItem(PAYLOAD_KEY);
    return raw ? (JSON.parse(raw) as StockChangePayload) : null;
  } catch {
    return null;
  }
}

/**
 * 订阅其它窗口的库存变更：
 * - BroadcastChannel 消息（其它窗口）
 * - storage 事件（其它窗口改 localStorage 时触发）
 * 返回退订函数。
 */
export function subscribeStockChange(listener: (payload: StockChangePayload) => void): () => void {
  const self = windowId();
  const onMessage = (ev: MessageEvent<StockChangePayload>) => {
    if (ev.data && ev.data.origin !== self) listener(ev.data);
  };
  const onStorage = (ev: StorageEvent) => {
    if (ev.key !== VERSION_KEY || !ev.newValue) return;
    const payload = readLastChange();
    if (payload && payload.origin !== self) listener(payload);
  };
  channel?.addEventListener('message', onMessage);
  window.addEventListener('storage', onStorage);
  return () => {
    channel?.removeEventListener('message', onMessage);
    window.removeEventListener('storage', onStorage);
  };
}
