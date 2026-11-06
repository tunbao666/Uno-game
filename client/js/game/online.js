/**
 * 联机会话控制器。
 *
 * 对外暴露的接口和单机控制器一致（humanPlay / humanDraw / humanPass / getState / humanSeat），
 * 界面层因此不需要写两套交互代码。
 *
 * 关键点：这里只发"意图"，绝不本地改状态。
 * 所有状态都由服务端计算后广播回来，客户端拿到什么就画什么。
 */

import { PHASE } from '../../../shared/rules.js';
import { createNet } from '../net.js';

const STORAGE_KEY = 'uno.session.v1';

/** 会话持久化：刷新页面后能凭令牌回到原座位 */
function saveSession(session) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略即可 */
  }
}

function readSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.code && parsed?.token ? parsed : null;
  } catch {
    return null;
  }
}

function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}

/**
 * @param {object} options
 * @param {(state: object, seat: number) => void} options.onState
 * @param {(room: object) => void} options.onRoom
 * @param {(payload: object) => void} options.onJoined
 * @param {(text: string) => void} options.onNotice
 * @param {(payload: object) => void} options.onSay
 * @param {(text: string, detail?: object) => void} options.onError
 * @param {(reason: string) => void} options.onKicked
 * @param {(status: string, attempt: number) => void} options.onStatus
 * @param {(state: object) => void} options.onFinish
 */
export function createOnlineGame(options = {}) {
  const {
    onState,
    onRoom,
    onJoined,
    onNotice,
    onSay,
    onError,
    onKicked,
    onStatus,
    onFinish,
  } = options;

  let state = null;
  let seat = 0;
  let room = null;
  let session = null;
  let intent = null; // { type: 'create' | 'join', name, code }
  let finished = false;
  let disposed = false;

  const net = createNet({
    onStatus: (status, attempt) => {
      if (status === 'reconnecting' && attempt > 6) {
        // 超过约 20 秒还连不上，服务端多半已经把座位释放了
        onStatus?.('lost', attempt);
        return;
      }
      onStatus?.(status, attempt);
    },
    onOpen: () => {
      // 已经离开房间的连接可能刚好重连成功，此时不能再自动建房/进房
      if (disposed) return;

      // 有令牌就优先恢复座位，否则按最初的意图建/加入房间
      if (session) {
        net.send({ t: 'resume', code: session.code, token: session.token });
        return;
      }
      sendIntent();
    },

    onMessage: (message) => {
      if (disposed) return;

      switch (message.t) {
        case 'joined': {
          session = { code: message.code, token: message.token };
          saveSession(session);
          seat = message.seat;
          room = {
            code: message.code,
            hostSeat: message.hostSeat,
            started: message.started,
            players: message.players,
          };
          onJoined?.(message);
          if (message.state) applyState(message.state);
          break;
        }

        case 'room': {
          room = message;
          onRoom?.(message);
          break;
        }

        case 'state': {
          applyState(message);
          break;
        }

        case 'notice': {
          if (message.exceptSeat !== seat) onNotice?.(message.text);
          break;
        }

        case 'say': {
          onSay?.(message);
          break;
        }

        case 'error': {
          onError?.(message.message, message);
          break;
        }

        case 'kicked': {
          clearSession();
          session = null;
          onKicked?.(message.reason ?? '你已离开房间');
          break;
        }

        case 'pong':
          break;

        default:
          break;
      }
    },
  });

  function applyState(payload) {
    state = payload.state;
    seat = payload.seat;
    if (state.phase !== PHASE.FINISHED) finished = false;
    onState?.(state, seat);

    if (state.phase === PHASE.FINISHED && !finished) {
      finished = true;
      onFinish?.(state);
    }
  }

  /** 把当前意图（建房 / 进房）发出去 */
  function sendIntent() {
    if (intent?.type === 'create') {
      net.send({ t: 'create', name: intent.name });
    } else if (intent?.type === 'join') {
      net.send({ t: 'join', code: intent.code, name: intent.name });
    }
  }

  /**
   * 连接已经开着就直接发，否则等 onOpen 里补发。
   * 少了这一条，改名重试时（上一条 join 已被服务端拒绝）点了按钮什么都不会发生：
   * connect() 看到连接是 OPEN 就直接返回，join 永远发不出去。
   */
  function requestIntent() {
    if (net.isOpen) sendIntent();
    else net.connect();
  }

  return {
    /* -------------------------- 与单机一致的接口 -------------------------- */

    humanPlay(cardId, color) {
      net.send({ t: 'play', cardId, color });
    },

    humanDraw() {
      net.send({ t: 'draw' });
    },

    humanPass() {
      net.send({ t: 'pass' });
    },

    getState: () => state,

    get humanSeat() {
      return seat;
    },

    /* ------------------------------ 房间操作 ------------------------------ */

    createRoom(name) {
      intent = { type: 'create', name };
      session = null;
      requestIntent();
    },

    joinRoom(code, name) {
      intent = { type: 'join', code, name };
      session = null;
      requestIntent();
    },

    /** 页面加载时尝试恢复上次未打完的座位 */
    resume(name) {
      const saved = readSession();
      if (!saved) return false;
      session = saved;
      intent = { type: 'create', name };
      net.connect();
      return true;
    },

    hasSession: () => Boolean(readSession()),

    start: () => net.send({ t: 'start' }),
    again: () => net.send({ t: 'again' }),
    kick: (targetSeat) => net.send({ t: 'kick', seat: targetSeat }),
    say: (text) => net.send({ t: 'say', text }),

    leave() {
      net.send({ t: 'leave' });
      clearSession();
      session = null;
    },

    resetFinish() {
      finished = false;
    },

    getRoom: () => room,

    dispose() {
      disposed = true;
      // 留一点时间把 leave 帧发出去，再断开
      setTimeout(() => net.close(), 80);
    },
  };
}

/** 页面加载时用来判断有没有可恢复的会话 */
export function hasSavedSession() {
  return Boolean(readSession());
}
