/**
 * 联机客户端测试。
 *
 * 重点是"被服务端拒绝之后还能不能再试一次"：
 * 服务端报错不会断开连接，连接一直是 OPEN，
 * 于是任何依赖 connect() 来重发指令的写法都会静默失效。
 * 重名被拒 → 改名 → 再点加入，正好踩在这条路上。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createOnlineGame } from '../client/js/game/online.js';

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.instances.push(this);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  emit(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit('open');
  }

  receive(payload) {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  send(text) {
    this.sent.push(text);
  }

  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.emit('close');
  }

  /** 按类型取出已发出的帧 */
  frames(type) {
    return this.sent.map((text) => JSON.parse(text)).filter((frame) => frame.t === type);
  }
}

globalThis.WebSocket = FakeSocket;
globalThis.location = { protocol: 'http:', host: 'localhost:3000' };

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

function createClient() {
  FakeSocket.instances = [];
  store.clear();
  const errors = [];
  const joined = [];
  const online = createOnlineGame({
    onError: (text, detail) => errors.push({ text, ...detail }),
    onJoined: (payload) => joined.push(payload),
  });
  return { online, errors, joined };
}

test('重名被拒后改名重试，join 帧会重新发出去', async () => {
  const { online, errors, joined } = createClient();

  online.joinRoom('1234', '小明');
  const ws = FakeSocket.instances.at(0);
  ws.open();

  assert.equal(ws.frames('join').length, 1, '连上后应当发出第一次 join');
  assert.equal(ws.frames('join')[0].name, '小明');

  ws.receive({ t: 'error', message: '房间里已经有人叫「小明」了，换个名字吧', code: 'NAME_TAKEN' });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'NAME_TAKEN', '错误码要透传给界面，用来聚焦名字输入框');
  assert.equal(joined.length, 0, '被拒绝时不能当成已进房');

  // 连接此时仍然是 OPEN，改名再点一次必须能发出去
  online.joinRoom('1234', '小红');
  const joins = ws.frames('join');
  assert.equal(joins.length, 2, '同一个连接上也要重新发 join，不能静默丢掉');
  assert.equal(joins[1].name, '小红');

  ws.receive({
    t: 'joined',
    code: '1234',
    seat: 1,
    token: 'tok-1',
    hostSeat: 0,
    started: false,
    players: [],
  });
  assert.equal(joined.length, 1, '改名之后应当正常进房');
  assert.equal(joined[0].seat, 1);

  online.dispose();
  await new Promise((resolve) => setTimeout(resolve, 120));
});

test('连接还没建立时，指令先排队、连上后补发', async () => {
  const { online } = createClient();

  online.joinRoom('5678', '阿黄');
  const ws = FakeSocket.instances.at(0);
  assert.equal(ws.frames('join').length, 0, 'CONNECTING 阶段发不出去');

  ws.open();
  assert.equal(ws.frames('join').length, 1, '连上后应当补发');
  assert.equal(ws.frames('join')[0].code, '5678');

  online.dispose();
  await new Promise((resolve) => setTimeout(resolve, 120));
});
