/**
 * WebSocket 客户端封装：自动重连 + 发送队列。
 *
 * 断线不是异常情况而是常态（手机切后台、WiFi 抖动），
 * 所以这里不把断线当错误抛给上层，而是转入"重连中"状态，
 * 连上后由上层发 resume 把座位要回来。
 */

const RETRY_BASE_MS = 400;
const RETRY_MAX_MS = 4000;

export function createNet({ onOpen, onMessage, onStatus } = {}) {
  let socket = null;
  let attempt = 0;
  let retryTimer = null;
  let manual = false;
  const queue = [];

  function status(value, detail) {
    onStatus?.(value, detail);
  }

  function endpoint() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws`;
  }

  function connect() {
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      return;
    }

    manual = false;
    status(attempt === 0 ? 'connecting' : 'reconnecting', attempt);

    const ws = new WebSocket(endpoint());
    socket = ws;

    ws.addEventListener('open', () => {
      attempt = 0;
      status('online');
      onOpen?.();
      // 重连期间攒下的事件在连上后补发
      while (queue.length > 0) ws.send(queue.shift());
    });

    ws.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      onMessage?.(payload);
    });

    ws.addEventListener('close', () => {
      if (manual) return;
      scheduleRetry();
    });

    // error 之后浏览器一定会触发 close，重连逻辑统一放在 close 里
    ws.addEventListener('error', () => {});
  }

  function scheduleRetry() {
    attempt += 1;
    // 指数退避，但不超过 4 秒：手机切回前台时要尽快恢复
    const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
    status('reconnecting', attempt);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, delay);
  }

  function send(payload) {
    const text = JSON.stringify(payload);
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(text);
      return true;
    }
    // 未连上时先排队，连上后一次性发出
    if (queue.length < 32) queue.push(text);
    connect();
    return false;
  }

  function close() {
    manual = true;
    clearTimeout(retryTimer);
    retryTimer = null;
    queue.length = 0;
    socket?.close();
    socket = null;
  }

  return {
    connect,
    send,
    close,
    get isOpen() {
      return socket?.readyState === WebSocket.OPEN;
    },
  };
}
