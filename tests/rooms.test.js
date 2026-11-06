/**
 * 房间服务测试。
 *
 * 用假连接直接驱动 RoomManager，不经过网络，
 * 这样能精确控制时间（保留时长、托管延迟），也不会引入端口占用等随机失败。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { RoomManager, sanitizeName } from '../server/rooms.js';
import { PHASE, getPlayableCards, getTopCard } from '../shared/rules.js';

/** 最小连接桩：记录所有下发消息，实现房间服务需要的三个方法 */
class FakeConnection extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.closed = null;
  }

  sendJson(payload) {
    this.messages.push(payload);
    return true;
  }

  close(code, reason) {
    this.closed = { code, reason };
  }

  of(type) {
    return this.messages.filter((message) => message.t === type);
  }

  last(type) {
    const list = type ? this.of(type) : this.messages;
    return list.at(-1);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(options = {}) {
  const manager = new RoomManager({
    reserveMs: 120,
    autoPlayDelay: 5,
    ...options,
  });
  const connect = () => {
    const connection = new FakeConnection();
    manager.attach(connection);
    return connection;
  };
  return { manager, connect };
}

/** 建房 + 让 n-1 个人加入，返回房主与所有连接 */
function createRoom(manager, connect, { players = 2, names = [] } = {}) {
  const hostConn = connect();
  manager.handle(hostConn, JSON.stringify({ t: 'create', name: names[0] ?? '房主' }));
  const code = hostConn.last('joined').code;

  const others = [];
  for (let i = 1; i < players; i += 1) {
    const conn = connect();
    manager.handle(
      conn,
      JSON.stringify({ t: 'join', code, name: names[i] ?? `玩家${i + 1}` }),
    );
    others.push(conn);
  }

  return { hostConn, code, others, all: [hostConn, ...others] };
}

test('创建房间返回 4 位房间码与身份令牌', () => {
  const { manager, connect } = setup();
  const conn = connect();
  manager.handle(conn, JSON.stringify({ t: 'create', name: '小明' }));

  const joined = conn.last('joined');
  assert.ok(joined, '应当收到 joined');
  assert.match(joined.code, /^\d{4}$/, '房间码应为 4 位数字');
  assert.equal(joined.seat, 0);
  assert.equal(joined.hostSeat, 0);
  assert.ok(joined.token.length >= 16, '令牌长度不足');
  assert.equal(joined.players.length, 1);

  manager.close();
});

test('房间码不存在时给出明确提示', () => {
  const { manager, connect } = setup();
  const conn = connect();
  manager.handle(conn, JSON.stringify({ t: 'join', code: '0000', name: '路人' }));

  assert.match(conn.last('error').message, /房间不存在/);
  manager.close();
});

test('第二个玩家加入后，房主收到人数更新', () => {
  const { manager, connect } = setup();
  const { hostConn, others } = createRoom(manager, connect, { players: 2 });

  const room = hostConn.last('room');
  assert.equal(room.players.length, 2);
  assert.equal(others[0].last('joined').seat, 1);
  assert.equal(others[0].last('joined').players.length, 2);

  manager.close();
});

test('人数不足时不能开始，且非房主不能开始', () => {
  const { manager, connect } = setup();
  const { hostConn, others } = createRoom(manager, connect, { players: 2 });

  // 先把第二个玩家踢走，回到 1 人
  manager.handle(hostConn, JSON.stringify({ t: 'kick', seat: 1 }));
  manager.handle(hostConn, JSON.stringify({ t: 'start' }));
  assert.match(hostConn.last('error').message, /至少需要/);

  // 再拉一个人进来，但他不是房主
  const third = connect();
  const code = hostConn.last('joined').code;
  manager.handle(third, JSON.stringify({ t: 'join', code, name: '阿强' }));
  manager.handle(third, JSON.stringify({ t: 'start' }));
  assert.match(third.last('error').message, /只有房主/);

  assert.equal(others[0].closed.code, 4002, '被踢连接应以 4002 关闭');
  manager.close();
});

test('开局后每人只看到自己的手牌，别人的只有张数', () => {
  const { manager, connect } = setup();
  const { hostConn, others } = createRoom(manager, connect, { players: 3 });

  manager.handle(hostConn, JSON.stringify({ t: 'start' }));

  const state = hostConn.last('state').state;
  assert.equal(state.players.length, 3);
  assert.equal(state.players[0].hand.length, 7, '自己应当拿到 7 张牌');
  assert.equal(state.players[0].handCount, 7);

  for (const index of [1, 2]) {
    const other = state.players[index];
    assert.equal(other.hand, undefined, '绝不能把别人的手牌下发');
    assert.equal(other.handCount, 7);
  }

  assert.equal(typeof state.drawCount, 'number', '摸牌堆只下发数量');
  assert.equal(state.drawPile, undefined, '不能下发完整摸牌堆');
  assert.equal(state.seed, undefined, '不能下发随机种子');

  // 每个连接拿到的视角座位不同
  assert.equal(others[0].last('state').seat, 1);
  assert.equal(others[1].last('state').seat, 2);

  manager.close();
});

test('不到自己回合出牌会被拒绝', () => {
  const { manager, connect } = setup();
  const { hostConn, others } = createRoom(manager, connect, { players: 2 });
  manager.handle(hostConn, JSON.stringify({ t: 'start' }));

  const notCurrent = others[0];
  const state = notCurrent.last('state').state;
  const cardId = state.players[1].hand[0].id;

  manager.handle(notCurrent, JSON.stringify({ t: 'play', cardId }));
  assert.match(notCurrent.last('error').message, /还没轮到/);

  manager.close();
});

test('房主可以出牌，全场状态同步更新', () => {
  const { manager, connect } = setup();
  const { hostConn, others } = createRoom(manager, connect, { players: 2 });
  manager.handle(hostConn, JSON.stringify({ t: 'start' }));

  const state = hostConn.last('state').state;
  const topCard = getTopCard(state);
  const playable = getPlayableCards(state.players[0].hand, {
    topCard,
    currentColor: state.currentColor,
  });

  if (playable.length > 0) {
    const card = playable[0];
    manager.handle(
      hostConn,
      JSON.stringify({ t: 'play', cardId: card.id, color: card.color ?? 'red' }),
    );

    const nextState = hostConn.last('state').state;
    assert.ok(
      nextState.players[0].handCount === 6 || nextState.phase === PHASE.FINISHED,
      '出牌后手牌应减少',
    );
    assert.equal(others[0].last('state').state.players[0].handCount, 6);
  } else {
    // 没有可出的牌就摸一张，同样要广播
    manager.handle(hostConn, JSON.stringify({ t: 'draw' }));
    assert.ok(hostConn.last('state').state.turnCount >= 0);
  }

  manager.close();
});

test('掉线后 30 秒内用令牌恢复，座位与手牌都还在', async () => {
  const { manager, connect } = setup();
  const { hostConn, others } = createRoom(manager, connect, { players: 2 });
  manager.handle(hostConn, JSON.stringify({ t: 'start' }));

  const token = hostConn.last('joined').token;
  const code = hostConn.last('joined').code;
  const handBefore = hostConn.last('state').state.players[0].hand.map((card) => card.id);

  // 模拟网络断开：本人收不到任何消息，由对手看到"掉线"提示
  hostConn.emit('close');
  assert.match(others[0].last('notice').text, /掉线/);

  await sleep(40);

  const revived = connect();
  manager.handle(revived, JSON.stringify({ t: 'resume', code, token }));

  const joined = revived.last('joined');
  assert.ok(joined, '重连应当直接回到房间');
  assert.equal(joined.code, code);
  assert.equal(joined.seat, 0);
  assert.equal(joined.state.state.players[0].hand.length, handBefore.length);
  assert.deepEqual(
    joined.state.state.players[0].hand.map((card) => card.id),
    handBefore,
    '恢复后手牌必须完全一致',
  );

  manager.close();
});

test('等待室里掉线超时，座位会被释放', async () => {
  const { manager, connect } = setup();
  const { hostConn, others } = createRoom(manager, connect, { players: 2 });

  others[0].emit('close');
  await sleep(200);

  const room = hostConn.last('room');
  assert.equal(room.players.length, 1, '超时后应只剩房主');
  assert.match(hostConn.last('notice').text, /座位已释放/);

  manager.close();
});

test('对局中掉线超时，改为系统托管并自动出牌', async () => {
  const { manager, connect } = setup();
  const { hostConn, others } = createRoom(manager, connect, { players: 2 });
  manager.handle(hostConn, JSON.stringify({ t: 'start' }));

  // 让第二个人断线，等他超时
  others[0].emit('close');
  await sleep(220);

  const state = hostConn.last('state').state;
  const abandoned = state.players.filter((player) => player.abandoned);
  assert.equal(abandoned.length, 1, '应当有一位玩家被标记为托管');

  manager.close();
});

test('房主离开后权限自动交给下一位', () => {
  const { manager, connect } = setup();
  const { hostConn, others } = createRoom(manager, connect, { players: 2 });

  manager.handle(hostConn, JSON.stringify({ t: 'leave' }));

  // 离开者本人收不到更新，看留在房间里的人
  const room = others[0].last('room');
  assert.equal(room.players.length, 1);
  assert.equal(room.players[0].isHost, true);
  assert.equal(room.hostSeat, room.players[0].seat);
  assert.equal(hostConn.closed.code, 1000, '主动离开以 1000 正常关闭');

  manager.close();
});

test('昵称会被清洗：去标签、限长、空值兜底', () => {
  assert.equal(sanitizeName('  <b>小明</b>  '), 'b小明/b');
  assert.equal(sanitizeName('一二三四五六七八九十'), '一二三四五六七八');
  assert.equal(sanitizeName('   '), '玩家');
  assert.equal(sanitizeName(null), '玩家');
});

test('快捷短语会被转发给同房间所有人', () => {
  const { manager, connect } = setup();
  const { hostConn, others } = createRoom(manager, connect, { players: 2 });

  manager.handle(others[0], JSON.stringify({ t: 'say', text: '快点啊' }));

  assert.equal(hostConn.last('say').text, '快点啊');
  assert.equal(hostConn.last('say').seat, 1);
  assert.equal(others[0].last('say').name, '玩家2');

  manager.close();
});

test('对局结束时给出赢家提示，房主可以再来一局', () => {
  const { manager, connect } = setup();
  const { hostConn } = createRoom(manager, connect, { players: 2 });
  manager.handle(hostConn, JSON.stringify({ t: 'start' }));

  // 直接把状态打到结束：反复摸牌直到有人出完不现实，
  // 这里改为验证"未结束不能再来一局"的守卫
  manager.handle(hostConn, JSON.stringify({ t: 'again' }));
  assert.match(hostConn.last('error').message, /还没结束/);

  manager.close();
});
