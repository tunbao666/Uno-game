/**
 * WebSocket 客户端封装：自动重连 + 发送队列 + 心跳保活。
 *
 * 断线不是异常情况而是常态（手机切后台、WiFi 抖动、笔记本从 WiFi 换到热点），
 * 所以这里不把断线当错误抛给上层，而是转入"重连中"状态，
 * 连上后由上层发 resume 把座位要回来。
 *
 * 关键点是心跳：换网络时旧 TCP 连接经常既不发 FIN 也不报错，
 * 浏览器的 close 事件永远不会来，于是一条已经死掉的连接看起来还是 OPEN，
 * 所有操作发出去都石沉大海。靠定时 ping 发现对端不回话，主动掐掉重连。
 */

const RETRY_BASE_MS = 400;
const RETRY_MAX_MS = 4000;
/** 心跳间隔：够密才能及时发现"换了网络但 TCP 还没超时"的假在线 */
const PING_MS = 8_000;
/** 超过这么久没收到任何回包，就认定这条连接已经死了 */
const PONG_TIMEOUT_MS = 24_000;

export function createNet({ onOpen, onMessage, onStatus } = {}) {
  let socket = null;
  let attempt = 0;
  let retryTimer = null;
  let heartbeatTimer = null;
  let lastSeen = 0;
  let manual = false;
  const queue = [];

  function status(value, detail) {
    onStatus?.(value, detail);
  }

  function endpoint() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws`;
  }

  function stopHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  /**
   * 对端已经不回话了。
   * 先把 socket 置空，这样旧连接随后触发的 close 事件会被当成"过期事件"忽略，
   * 不会引发第二轮重连。
   */
  function dropAndRetry(target) {
    if (socket === target) socket = null;
    stopHeartbeat();
    try {
      target.close();
    } catch {
      /* 关不掉也没关系，引用已经断开了 */
    }
    if (!manual) scheduleRetry();
  }

  function startHeartbeat(ws) {
    stopHeartbeat();
    lastSeen = Date.now();
    heartbeatTimer = setInterval(() => {
      if (ws !== socket || ws.readyState !== WebSocket.OPEN) return;

      if (Date.now() - lastSeen > PONG_TIMEOUT_MS) {
        dropAndRetry(ws);
        return;
      }

      try {
        ws.send(JSON.stringify({ t: 'ping' }));
      } catch {
        dropAndRetry(ws);
      }
    }, PING_MS);
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
      if (ws !== socket) return;
      attempt = 0;
      status('online');
      startHeartbeat(ws);
      onOpen?.();
      // 重连期间攒下的事件在连上后补发
      while (queue.length > 0) ws.send(queue.shift());
    });

    ws.addEventListener('message', (event) => {
      if (ws !== socket) return;
      lastSeen = Date.now();

      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      onMessage?.(payload);
    });

    ws.addEventListener('close', () => {
      // ws !== socket 说明这条连接已经被放弃或被新连接取代，不该再触发重连
      if (ws !== socket) return;
      socket = null;
      stopHeartbeat();
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
    stopHeartbeat();
    queue.length = 0;
    const ws = socket;
    socket = null;
    try {
      ws?.close();
    } catch {
      /* 忽略 */
    }
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
