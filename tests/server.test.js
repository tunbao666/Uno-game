/**
 * 真实网络层的端到端测试。
 *
 * 前面的 rooms.test.js 用的是假连接，验证的是房间逻辑；
 * 这里用 Node 内置的 WebSocket 客户端连真服务器，验证的是 handshake、帧编解码、
 * 以及"两个玩家能通过服务器打完一整轮"。
 *
 * 顺带覆盖 126 字节扩展长度分支：状态包里带 7 张手牌和日志，JSON 长度必然超过 125。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createUnoServer } from '../server/index.js';
import { PHASE, getPlayableCards, getTopCard } from '../shared/rules.js';

/** 把 WebSocket 包成"按类型取消息"的小工具，避免测试里到处写回调 */
function wrap(ws) {
  const buffer = [];
  const waiters = [];

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(message);
    } else {
      buffer.push(message);
    }
  });

  return {
    send(payload) {
      ws.send(JSON.stringify(payload));
    },
    next(type, timeout = 3000) {
      const predicate = typeof type === 'function' ? type : (message) => message.t === type;
      const found = buffer.findIndex(predicate);
      if (found >= 0) return Promise.resolve(buffer.splice(found, 1)[0]);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const pending = waiters.findIndex((item) => item.resolve === wrapped);
          if (pending >= 0) waiters.splice(pending, 1);
          reject(new Error(`等待消息超时：${typeof type === 'string' ? type : '自定义条件'}`));
        }, timeout);

        const wrapped = (message) => {
          clearTimeout(timer);
          resolve(message);
        };

        waiters.push({ predicate, resolve: wrapped });
      });
    },
  };
}

async function openClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
  });
  return { ws, client: wrap(ws) };
}

test('两个玩家通过真实 WebSocket 建房、加入、开局并出牌', async (t) => {
  const app = createUnoServer({ reserveMs: 500, autoPlayDelay: 20 });
  const address = await app.listen(0);
  const port = address.port;

  t.after(async () => {
    await app.close();
  });

  /* --- 建房 --- */
  const { ws: wsA, client: a } = await openClient(port);
  a.send({ t: 'create', name: '房主' });

  const joinedA = await a.next('joined');
  assert.match(joinedA.code, /^\d{4}$/);
  assert.equal(joinedA.seat, 0);
  assert.ok(joinedA.token);

  /* --- 加入 --- */
  const { ws: wsB, client: b } = await openClient(port);
  b.send({ t: 'join', code: joinedA.code, name: '挑战者' });

  const joinedB = await b.next('joined');
  assert.equal(joinedB.seat, 1);
  assert.equal(joinedB.players.length, 2);

  // 建房时已经广播过一次房间（1 人），这里要等"加入后"的那次
  const roomA = await a.next((message) => message.t === 'room' && message.players.length === 2);
  assert.equal(roomA.players.length, 2);

  /* --- 开局 --- */
  a.send({ t: 'start' });
  const stateA = await a.next('state');
  const stateB = await b.next('state');

  assert.equal(stateA.state.players[0].hand.length, 7);
  assert.equal(stateA.state.players[1].hand, undefined, '对手手牌不能下发');
  assert.equal(stateB.state.players[1].hand.length, 7);
  assert.equal(stateA.seat, 0);
  assert.equal(stateB.seat, 1);

  /* --- 出牌或摸牌，另一侧必须收到新状态 --- */
  const topCard = getTopCard(stateA.state);
  const playable = getPlayableCards(stateA.state.players[0].hand, {
    topCard,
    currentColor: stateA.state.currentColor,
  });

  if (playable.length > 0) {
    const card = playable[0];
    a.send({ t: 'play', cardId: card.id, color: card.color ?? 'red' });
  } else {
    a.send({ t: 'draw' });
  }

  const afterA = await b.next('state');
  assert.ok(
    afterA.state.turnCount > 0 || afterA.state.drawCount < stateA.state.drawCount,
    '对手应当看到牌局推进',
  );

  /* --- 非法操作被服务端拒绝 --- */
  b.send({ t: 'play', cardId: 'no-such-card' });
  const error = await b.next('error');
  assert.ok(error.message.length > 0);

  /* --- 心跳指令 --- */
  a.send({ t: 'ping' });
  const pong = await a.next('pong');
  assert.equal(pong.t, 'pong');

  wsA.close();
  wsB.close();
});

test('客户端重连后能拿回自己的手牌', async (t) => {
  const app = createUnoServer({ reserveMs: 800, autoPlayDelay: 20 });
  const address = await app.listen(0);
  const port = address.port;

  t.after(async () => {
    await app.close();
  });

  const { ws: wsA, client: a } = await openClient(port);
  a.send({ t: 'create', name: '掉线王' });
  const joined = await a.next('joined');

  const { client: b } = await openClient(port);
  b.send({ t: 'join', code: joined.code, name: '路人' });
  await b.next('joined');

  a.send({ t: 'start' });
  const first = await a.next('state');
  const handBefore = first.state.players[0].hand.map((card) => card.id);

  // 断开并立即重连
  wsA.close();
  await new Promise((resolve) => setTimeout(resolve, 120));

  const { client: a2 } = await openClient(port);
  a2.send({ t: 'resume', code: joined.code, token: joined.token });

  const rejoin = await a2.next('joined');
  assert.equal(rejoin.seat, 0);
  assert.deepEqual(
    rejoin.state.state.players[0].hand.map((card) => card.id),
    handBefore,
  );
});

test('房间不存在时返回可读错误而不是断线', async (t) => {
  const app = createUnoServer();
  const address = await app.listen(0);

  t.after(async () => {
    await app.close();
  });

  const { ws, client } = await openClient(address.port);
  client.send({ t: 'join', code: '9999', name: '路人' });

  const error = await client.next('error');
  assert.match(error.message, /房间不存在/);
  assert.equal(ws.readyState, WebSocket.OPEN, '报错不应断开连接');

  ws.close();
});

test('重名在真实链路上被拦住，同一连接改名后能进', async (t) => {
  const app = createUnoServer();
  const address = await app.listen(0);

  t.after(async () => {
    await app.close();
  });

  const { ws: wsA, client: a } = await openClient(address.port);
  a.send({ t: 'create', name: '小明' });
  const joinedA = await a.next('joined');

  const { ws: wsB, client: b } = await openClient(address.port);
  b.send({ t: 'join', code: joinedA.code, name: '小明' });

  const error = await b.next('error');
  assert.equal(error.code, 'NAME_TAKEN');
  assert.match(error.message, /已经有人叫/);
  assert.equal(wsB.readyState, WebSocket.OPEN, '重名不该把连接掐掉，否则改名重试要重连');

  // 同一条连接上改名重发，应当直接进房
  b.send({ t: 'join', code: joinedA.code, name: '小红' });
  const joinedB = await b.next('joined');
  assert.equal(joinedB.seat, 1);

  wsA.close();
  wsB.close();
});

test('结算后离开再重进：座位当场释放，不会顶着托管标记', async (t) => {
  const app = createUnoServer({ reserveMs: 500, autoPlayDelay: 20 });
  const address = await app.listen(0);

  t.after(async () => {
    await app.close();
  });

  const { ws: wsA, client: a } = await openClient(address.port);
  a.send({ t: 'create', name: '房主' });
  const joinedA = await a.next('joined');

  const { ws: wsB, client: b } = await openClient(address.port);
  b.send({ t: 'join', code: joinedA.code, name: '朋友' });
  await b.next('joined');

  a.send({ t: 'start' });
  await a.next('state');
  await b.next('state');

  // 直接把对局推到结算态，省去把牌打完的时间
  app.manager.rooms.get(joinedA.code).game.phase = PHASE.FINISHED;

  b.send({ t: 'leave' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  wsB.close();

  // 同一个房间码再进一次
  const { ws: wsB2, client: b2 } = await openClient(address.port);
  b2.send({ t: 'join', code: joinedA.code, name: '朋友' });
  const rejoined = await b2.next('joined');

  assert.equal(rejoined.seat, 1, '应当拿回原来那个空出来的座位');
  assert.equal(rejoined.players.length, 2);
  assert.equal(
    rejoined.players.some((player) => player.abandoned),
    false,
    '重新进来不该看到"已托管"',
  );
  assert.equal(rejoined.state, null, '结算后才进来的人不该继承上一局的手牌视图');

  wsB2.close();
  wsA.close();
});

test('房主再来一局后，对手收到的是新局而不是结算态', async (t) => {
  const app = createUnoServer({ reserveMs: 500, autoPlayDelay: 20 });
  const address = await app.listen(0);

  t.after(async () => {
    await app.close();
  });

  const { ws: wsA, client: a } = await openClient(address.port);
  a.send({ t: 'create', name: '房主' });
  const joinedA = await a.next('joined');

  const { ws: wsB, client: b } = await openClient(address.port);
  b.send({ t: 'join', code: joinedA.code, name: '朋友' });
  await b.next('joined');

  a.send({ t: 'start' });
  await a.next('state');
  await b.next('state');

  app.manager.rooms.get(joinedA.code).game.phase = PHASE.FINISHED;

  a.send({ t: 'again' });

  // 桌面必须真的复位：双方都拿到重新发牌的开局状态
  const notFinished = (message) => message.t === 'state' && message.state.phase !== PHASE.FINISHED;
  const nextA = await a.next(notFinished);
  const nextB = await b.next(notFinished);

  assert.equal(nextA.state.players[0].hand.length, 7, '房主应当拿到新一局的 7 张手牌');
  assert.equal(nextB.state.players[0].hand, undefined, '对手仍然看不到别人的手牌');
  assert.equal(nextB.state.players[1].hand.length, 7, '对手也应当拿到新一局的 7 张手牌');

  wsB.close();
  wsA.close();
});
