/**
 * 跨窗口库存同步。
 * 本窗口改动库存（预占/领用/退回）后广播，其他窗口收到后提示「库存已变」，
 * 并从 IndexedDB 重新拉取最新在库/预占数量（保留新数量，不用旧值覆盖）。
 * BroadcastChannel 同源同浏览器自动投递，发送窗口本身不会收到自己的消息。
 */
const CHANNEL_NAME = 'gbfossilprep-sync';

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  try {
    if (typeof BroadcastChannel === 'undefined') return null;
    if (!channel) channel = new BroadcastChannel(CHANNEL_NAME);
    return channel;
  } catch {
    return null;
  }
}

export function broadcastStockChanged(): void {
  const ch = getChannel();
  if (!ch) return;
  try {
    ch.postMessage({ type: 'stock-changed', at: Date.now() });
  } catch {
    /* 广播失败可忽略 */
  }
}

export function onStockChanged(cb: () => void): () => void {
  const ch = getChannel();
  if (!ch) return () => {};
  const handler = () => cb();
  ch.addEventListener('message', handler);
  return () => ch.removeEventListener('message', handler);
}
