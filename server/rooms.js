/**
 * 房间与牌局服务。
 *
 * 职责划分：
 * - 房间层：房间码、席位、房主权限、掉线保留、托管、快捷短语
 * - 牌局层：直接调用 shared/rules.js，服务端是唯一权威判定方
 *
 * 客户端只发"我想出这张牌"的意图，是否合法一律由这里裁决，
 * 因此改前端也作弊不了。
 *
 * 与网络层解耦：只要求传入的对象有 sendJson(payload) / close(code, reason) / on(event, fn)，
 * 测试里可以用假连接直接驱动完整流程。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { chooseMove } from '../shared/ai.js';
import { PHASE, createGame, drawCard, passAfterDraw, playCard } from '../shared/rules.js';
import { projectPlayer, projectState } from '../shared/view.js';

export const ROOM_CONFIG = Object.freeze({
  minPlayers: 2,
  maxPlayers: 4,
  /** 掉线后座位保留时长 */
  reserveMs: 30_000,
  /** 托管出牌的思考延迟，太快会看不清 */
  autoPlayDelay: 900,
  nameMaxLength: 8,
  phraseMaxLength: 30,
  /** 全员离线多久后回收房间 */
  roomIdleMs: 10 * 60_000,
  /**
   * 全局房间数上限。
   * 公网开放后，任何人都能不带成本地建房，而房间全在内存里；
   * 没有这个上限，一个循环脚本就能把进程内存吃满。
   * 200 个房间够几百人同时玩，正常使用永远碰不到。
   */
  maxRooms: 200,
});

/** 断线/错误提示里给玩家看的文案 */
const CLOSE_CODES = Object.freeze({
  REPLACED: 4001,
  KICKED: 4002,
});

/** 昵称清洗：去控制字符、限长、空则兜底 */
export function sanitizeName(raw) {
  const text = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim();
  const chars = Array.from(text).slice(0, ROOM_CONFIG.nameMaxLength);
  return chars.join('') || '玩家';
}

export class RoomManager {
  /**
   * @param {Partial<typeof ROOM_CONFIG>} options
   */
  constructor(options = {}) {
    this.config = { ...ROOM_CONFIG, ...options };
    /** @type {Map<string, object>} 房间码 -> 房间 */
    this.rooms = new Map();
    /** @type {Map<string, {code: string, seat: number}>} 令牌 -> 会话 */
    this.sessions = new Map();
    /** @type {Map<object, string>} 连接 -> 令牌 */
    this.sockets = new Map();

    this.sweepTimer = setInterval(() => this.#sweep(), 60_000);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  /** 关闭后台定时器（测试结束时调用） */
  close() {
    clearInterval(this.sweepTimer);
    for (const room of this.rooms.values()) {
      clearTimeout(room.autoTimer);
      for (const player of room.players) clearTimeout(player.reserveTimer);
    }
    this.rooms.clear();
    this.sessions.clear();
    this.sockets.clear();
  }

  /* ------------------------------ 连接生命周期 ------------------------------ */

  /** 绑定连接：注册断开回调 */
  attach(connection) {
    connection.on('close', () => this.#onDisconnect(connection));
  }

  /** 处理一条来自客户端 JSON 消息 */
  handle(connection, raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      this.#error(connection, '消息格式不正确');
      return;
    }
    if (!message || typeof message !== 'object') return;

    switch (message.t) {
      case 'create':
        this.#create(connection, message);
        break;
      case 'join':
        this.#join(connection, message);
        break;
      case 'resume':
        this.#resume(connection, message);
        break;
      case 'start':
        this.#start(connection);
        break;
      case 'play':
        this.#play(connection, message);
        break;
      case 'draw':
        this.#draw(connection);
        break;
      case 'pass':
        this.#pass(connection);
        break;
      case 'kick':
        this.#kick(connection, message);
        break;
      case 'again':
        this.#again(connection);
        break;
      case 'say':
        this.#say(connection, message);
        break;
      case 'leave':
        this.#leave(connection);
        break;
      case 'ping':
        connection.sendJson({ t: 'pong' });
        break;
      default:
        this.#error(connection, '未知指令');
    }
  }

  /* -------------------------------- 房间 -------------------------------- */

  #create(connection, message) {
    if (this.rooms.size >= this.config.maxRooms) {
      this.#error(connection, '服务器房间已满，过几分钟再试');
      return;
    }

    const room = {
      code: this.#newCode(),
      players: [],
      started: false,
      game: null,
      gameSeats: [],
      /** 第几局，用来区分"这局的人"和结算后才进来的新人 */
      round: 0,
      hostSeat: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      autoTimer: null,
    };

    const player = this.#newPlayer(message.name, 0, true);
    player.connection = connection;
    room.players.push(player);
    room.hostSeat = player.seat;

    this.rooms.set(room.code, room);
    this.sessions.set(player.token, { code: room.code, seat: player.seat });
    this.sockets.set(connection, player.token);

    this.#welcome(player, room);
    this.#broadcastRoom(room);
  }

  #join(connection, message) {
    const code = String(message.code ?? '').trim();
    const room = this.rooms.get(code);
    if (!room) {
      this.#error(connection, '房间不存在，检查一下房间码');
      return;
    }
    // 只有"打到一半"才挡人；结算完的房间随时可以进（下一局还要凑人）
    if (this.#isLive(room)) {
      this.#error(connection, '这局已经开始了，等他们打完再来');
      return;
    }
    // 上一局托管掉的座位不该继续占位，否则新人会看到"房间已满"
    if (this.#pruneAbandoned(room)) {
      this.#error(connection, '房间不存在，检查一下房间码');
      return;
    }
    if (room.players.length >= this.config.maxPlayers) {
      this.#error(connection, '房间已满（最多 4 人）');
      return;
    }

    const seat = this.#lowestFreeSeat(room);
    const player = this.#newPlayer(message.name, seat, false);
    player.connection = connection;
    room.players.push(player);
    room.updatedAt = Date.now();

    this.sessions.set(player.token, { code: room.code, seat });
    this.sockets.set(connection, player.token);

    this.#welcome(player, room);
    this.#broadcastRoom(room);
    this.#notice(room, `${player.name} 加入了房间`, player.seat);
  }

  #resume(connection, message) {
    const code = String(message.code ?? '').trim();
    const token = String(message.token ?? '').trim();
    const room = this.rooms.get(code);
    if (!room) {
      this.#error(connection, '房间已关闭');
      return;
    }

    const player = room.players.find((item) => item.token === token);
    if (!player) {
      this.#error(connection, '座位已被释放，请重新加入');
      return;
    }

    // 同一座位保留两条连接会导致状态错乱，旧连接直接踢掉
    if (player.connection && player.connection !== connection) {
      player.connection.sendJson({ t: 'kicked', reason: '账号在别处重新连接' });
      player.connection.close(CLOSE_CODES.REPLACED, 'replaced');
    }

    clearTimeout(player.reserveTimer);
    player.reserveTimer = null;
    player.connection = connection;
    player.connected = true;
    player.abandoned = false;
    this.sockets.set(connection, token);

    this.#welcome(player, room);
    this.#broadcastRoom(room);
    if (room.started) {
      this.#broadcastState(room);
      this.#maybeAutoPlay(room);
    }
  }

  #start(connection) {
    const context = this.#context(connection);
    if (!context) return;
    const { room, player } = context;

    if (!player.isHost) {
      this.#error(connection, '只有房主可以开始游戏');
      return;
    }
    if (room.started) {
      this.#error(connection, '对局已经开始了');
      return;
    }
    if (room.players.length < this.config.minPlayers) {
      this.#error(connection, `至少需要 ${this.config.minPlayers} 名玩家`);
      return;
    }

    this.#startGame(room);
  }

  #startGame(room) {
    const occupants = [...room.players].sort((a, b) => a.seat - b.seat);
    room.round += 1;
    room.game = createGame({ players: occupants.map((item) => ({ name: item.name })) });
    room.gameSeats = occupants.map((item) => item.seat);
    room.started = true;
    room.updatedAt = Date.now();

    // 记住谁参加了这一局：结算后新人可能顶到同一个座位号，
    // 不能让他继承上一局的手牌视图
    for (const player of occupants) player.roundId = room.round;

    this.#broadcastRoom(room);
    this.#broadcastState(room);
    this.#notice(room, '对局开始，祝你好运');
    this.#maybeAutoPlay(room);
  }

  #again(connection) {
    const context = this.#context(connection);
    if (!context) return;
    const { room, player } = context;

    if (!player.isHost) {
      this.#error(connection, '只有房主可以开下一局');
      return;
    }
    if (!room.started || room.game?.phase !== PHASE.FINISHED) {
      this.#error(connection, '当前对局还没结束');
      return;
    }

    // 托管中的玩家不参与下一局
    const active = room.players.filter((item) => !item.abandoned);
    if (active.length < this.config.minPlayers) {
      this.#error(connection, '在线玩家不足，无法再来一局');
      return;
    }

    // 被剔除的座位要连带清掉令牌，否则会留下指向不存在玩家的会话
    for (const player of room.players) {
      if (player.abandoned) {
        clearTimeout(player.reserveTimer);
        this.sessions.delete(player.token);
      }
    }

    room.players = active;
    room.game = null;
    room.gameSeats = [];
    room.started = false;
    this.#startGame(room);
  }

  #kick(connection, message) {
    const context = this.#context(connection);
    if (!context) return;
    const { room, player } = context;

    if (!player.isHost) {
      this.#error(connection, '只有房主可以踢人');
      return;
    }
    if (room.started) {
      this.#error(connection, '对局已经开始，不能踢人');
      return;
    }

    const target = room.players.find((item) => item.seat === Number(message.seat));
    if (!target || target === player) return;

    target.connection?.sendJson({ t: 'kicked', reason: '房主将你移出了房间' });
    target.connection?.close(CLOSE_CODES.KICKED, 'kicked');
    this.#removePlayer(room, target, `${target.name} 被移出房间`);
  }

  #leave(connection) {
    const context = this.#context(connection);
    if (!context) return;
    const { room, player } = context;

    this.sockets.delete(connection);
    this.sessions.delete(player.token);

    if (this.#isLive(room)) {
      // 对局进行中退出不打断其他人，直接交给系统托管
      player.abandoned = true;
      player.connected = false;
      player.connection = null;
      // 房主托管后必须交权，否则这局打完没人能开下一局
      this.#reassignHost(room);
      this.#notice(room, `${player.name} 离开了对局，已托管`);
      this.#broadcastRoom(room);
      this.#broadcastState(room);
      this.#maybeAutoPlay(room);
    } else {
      // 结算完（或还没开局）离开就是真离开，房间该散就散
      this.#removePlayer(room, player, `${player.name} 离开了房间`);
    }

    connection.close(1000, 'left');
  }

  /* -------------------------------- 牌局 -------------------------------- */

  #play(connection, message) {
    this.#act(connection, (game, index) =>
      playCard(game, index, message.cardId, message.color),
    );
  }

  #draw(connection) {
    this.#act(connection, (game, index) => drawCard(game, index));
  }

  #pass(connection) {
    this.#act(connection, (game, index) => passAfterDraw(game, index));
  }

  /** 统一的出牌/摸牌/过牌执行入口 */
  #act(connection, action) {
    const context = this.#context(connection);
    if (!context) return;
    const { room, player } = context;

    if (!room.started || !room.game) {
      this.#error(connection, '对局还没开始');
      return;
    }
    if (player.abandoned) {
      this.#error(connection, '你已被系统托管，刷新页面可恢复');
      return;
    }

    const index = room.gameSeats.indexOf(player.seat);
    if (index < 0) return;

    try {
      room.game = action(room.game, index);
    } catch (error) {
      this.#error(connection, error?.message ?? '操作无效');
      return;
    }

    room.updatedAt = Date.now();
    this.#broadcastState(room);
    this.#afterTurn(room);
  }

  #afterTurn(room) {
    if (!room.game) return;
    if (room.game.phase === PHASE.FINISHED) {
      const winner = room.game.players.find((item) => item.id === room.game.winnerId);
      this.#notice(room, `${winner?.name ?? '有人'} 赢下了这一局`);
      return;
    }
    this.#maybeAutoPlay(room);
  }

  /** 当前行动者已掉线托管时，由服务端代打 */
  #maybeAutoPlay(room) {
    if (!room.game || room.game.phase === PHASE.FINISHED) return;
    if (room.autoTimer) return;

    const seat = room.gameSeats[room.game.currentPlayer];
    const player = room.players.find((item) => item.seat === seat);
    if (!player || !player.abandoned) return;

    room.autoTimer = setTimeout(() => {
      room.autoTimer = null;
      if (!room.game || room.game.phase === PHASE.FINISHED) return;

      const index = room.game.currentPlayer;
      const currentSeat = room.gameSeats[index];
      const current = room.players.find((item) => item.seat === currentSeat);
      if (!current?.abandoned) return; // 期间回来了，交还给玩家

      const move = chooseMove(room.game, 'normal');
      try {
        if (move.action === 'play') {
          room.game = playCard(room.game, index, move.cardId, move.color);
        } else if (move.action === 'draw') {
          room.game = drawCard(room.game, index);
        } else {
          room.game = passAfterDraw(room.game, index);
        }
      } catch {
        // 兜底：无论如何都要推进，否则整局会卡死
        try {
          room.game = drawCard(room.game, index);
        } catch {
          /* 保持现状，等下一次状态变化 */
        }
      }

      this.#broadcastState(room);
      this.#afterTurn(room);
    }, this.config.autoPlayDelay);
  }

  /* ------------------------------ 断线与回收 ------------------------------ */

  #onDisconnect(connection) {
    const token = this.sockets.get(connection);
    if (!token) return;
    this.sockets.delete(connection);

    const session = this.sessions.get(token);
    if (!session) return;

    const room = this.rooms.get(session.code);
    if (!room) return;

    const player = room.players.find((item) => item.token === token);
    // 已经被新连接接管，这次断开属于旧连接，忽略
    if (!player || player.connection !== connection) return;

    player.connection = null;
    player.connected = false;
    room.updatedAt = Date.now();

    this.#broadcastRoom(room);
    if (room.started) this.#broadcastState(room);
    this.#notice(
      room,
      `${player.name} 掉线了，座位保留 ${Math.round(this.config.reserveMs / 1000)} 秒`,
    );

    clearTimeout(player.reserveTimer);
    player.reserveTimer = setTimeout(() => {
      this.#releaseSeat(room, player);
    }, this.config.reserveMs);
  }

  /** 保留期结束仍未回来 */
  #releaseSeat(room, player) {
    player.reserveTimer = null;
    if (player.connected) return;

    if (this.#isLive(room)) {
      // 对局中不清座：改成系统托管，让其他人能继续打下去
      player.abandoned = true;
      player.connected = false;
      this.#reassignHost(room);
      this.#notice(room, `${player.name} 没有回来，已由系统托管`);
      this.#broadcastRoom(room);
      this.#broadcastState(room);
      this.#maybeAutoPlay(room);
      return;
    }

    this.#removePlayer(room, player, `${player.name} 超时未返回，座位已释放`);
  }

  #removePlayer(room, player, noticeText) {
    clearTimeout(player.reserveTimer);
    player.reserveTimer = null;

    room.players = room.players.filter((item) => item !== player);
    this.sessions.delete(player.token);
    room.updatedAt = Date.now();

    if (room.players.length === 0) {
      this.#destroyRoom(room);
      return;
    }

    // 房主离开后把权限交给剩下座位最靠前的人
    this.#reassignHost(room);

    this.#broadcastRoom(room);
    if (noticeText) this.#notice(room, noticeText);
  }

  /* ------------------------------ 房间状态判定 ------------------------------ */

  /** 对局是否正在进行。结算完之后房间就回到"可进可出"的普通状态 */
  #isLive(room) {
    return Boolean(room.started && room.game && room.game.phase !== PHASE.FINISHED);
  }

  /**
   * 把房主权限交给在场的人。
   *
   * 只处理"原房主已经不在了"的情况：托管中的座位不能再当房主，
   * 否则整局打完没人有权限开下一局、也没人能踢人，房间就废了。
   * 掉线但还在保留期的座位不动，他可能马上就回来。
   */
  #reassignHost(room) {
    const current = room.players.find((item) => item.isHost);
    if (current && !current.abandoned) return;

    const next = [...room.players]
      .filter((item) => !item.abandoned)
      .sort((a, b) => a.seat - b.seat)[0];
    if (!next) return;

    for (const item of room.players) item.isHost = item === next;
    room.hostSeat = next.seat;
  }

  /**
   * 清掉已托管的僵尸座位，让房间能重新接纳玩家。
   * @returns {boolean} 房间是否因此被销毁
   */
  #pruneAbandoned(room) {
    const stale = room.players.filter((item) => item.abandoned);
    if (stale.length === 0) return false;

    for (const player of stale) {
      clearTimeout(player.reserveTimer);
      player.reserveTimer = null;
      this.sessions.delete(player.token);
    }
    room.players = room.players.filter((item) => !item.abandoned);

    if (room.players.length === 0) {
      this.#destroyRoom(room);
      return true;
    }

    this.#reassignHost(room);
    this.#broadcastRoom(room);
    return false;
  }

  #destroyRoom(room) {
    clearTimeout(room.autoTimer);
    for (const player of room.players) clearTimeout(player.reserveTimer);
    this.rooms.delete(room.code);
  }

  /** 全员离线超过回收阈值就把房间删掉，避免内存里堆积僵尸房间 */
  #sweep() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      const allOffline = room.players.every((player) => !player.connected);
      if (allOffline && now - room.updatedAt > this.config.roomIdleMs) {
        for (const player of room.players) this.sessions.delete(player.token);
        this.#destroyRoom(room);
      }
    }
  }

  /* -------------------------------- 工具 -------------------------------- */

  #newPlayer(name, seat, isHost) {
    return {
      seat,
      id: randomUUID(),
      name: sanitizeName(name),
      token: randomBytes(16).toString('hex'),
      connection: null,
      connected: true,
      abandoned: false,
      isHost,
      reserveTimer: null,
      /** 打过房间的第几局，0 表示还没参与过任何一局 */
      roundId: 0,
    };
  }

  #newCode() {
    for (let i = 0; i < 200; i += 1) {
      const code = String(Math.floor(1000 + Math.random() * 9000));
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('房间数量已达上限，请稍后再试');
  }

  #lowestFreeSeat(room) {
    const used = new Set(room.players.map((player) => player.seat));
    for (let seat = 0; seat < this.config.maxPlayers; seat += 1) {
      if (!used.has(seat)) return seat;
    }
    return room.players.length;
  }

  #context(connection) {
    const token = this.sockets.get(connection);
    if (!token) {
      this.#error(connection, '尚未进入房间');
      return null;
    }
    const session = this.sessions.get(token);
    const room = session ? this.rooms.get(session.code) : null;
    const player = room?.players.find((item) => item.token === token);
    if (!room || !player) {
      this.#error(connection, '房间已关闭');
      return null;
    }
    return { room, player };
  }

  #welcome(player, room) {
    player.connection?.sendJson({
      t: 'joined',
      code: room.code,
      seat: player.seat,
      name: player.name,
      token: player.token,
      hostSeat: room.hostSeat,
      started: room.started,
      players: room.players.map(projectPlayer),
      // 重连时立刻补一份当前牌局，避免出现空白牌桌
      state: this.#stateFor(room, player),
    });
  }

  #stateFor(room, player) {
    if (!room.game) return null;
    // 没参加这一局的人（结算后才进来的新人）不给看残局
    if (player.roundId !== room.round) return null;
    const index = room.gameSeats.indexOf(player.seat);
    if (index < 0) return null;
    return {
      state: projectState(room.game, index, this.#gameExtras(room)),
      seat: index,
    };
  }

  /** 把房间层的"托管中"状态拼进牌局视图 */
  #gameExtras(room) {
    return room.gameSeats.map((seat) => {
      const player = room.players.find((item) => item.seat === seat);
      return { abandoned: Boolean(player?.abandoned) };
    });
  }

  #broadcastRoom(room) {
    const payload = {
      t: 'room',
      code: room.code,
      hostSeat: room.hostSeat,
      started: room.started,
      players: room.players.map(projectPlayer),
    };
    for (const player of room.players) player.connection?.sendJson(payload);
  }

  #broadcastState(room) {
    if (!room.game) return;
    const extras = this.#gameExtras(room);
    for (const player of room.players) {
      const index = room.gameSeats.indexOf(player.seat);
      if (index < 0 || !player.connection) continue;
      player.connection.sendJson({
        t: 'state',
        code: room.code,
        seat: index,
        state: projectState(room.game, index, extras),
      });
    }
  }

  #broadcast(room, payload) {
    for (const player of room.players) player.connection?.sendJson(payload);
  }

  #notice(room, text, exceptSeat = null) {
    this.#broadcast(room, { t: 'notice', text, exceptSeat });
  }

  #say(connection, message) {
    const context = this.#context(connection);
    if (!context) return;
    const { room, player } = context;

    const text = String(message.text ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, this.config.phraseMaxLength);
    if (!text) return;

    this.#broadcast(room, { t: 'say', seat: player.seat, name: player.name, text });
  }

  #error(connection, message) {
    connection.sendJson({ t: 'error', message });
  }
}
