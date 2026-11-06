/**
 * 网络层测试。
 *
 * 这里验证的是最容易出事的场景：换了网络、TCP 半开着、
 * 浏览器既收不到 close 也没有报错 —— 一条"看起来还活着"的连接。
 * 没有心跳时，客户端会一直以为自己在房间里，所有操作静默丢包。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createNet } from '../client/js/net.js';

/** 极简 WebSocket 桩，够驱动 createNet 的状态机 */
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

  pings() {
    return this.sent.filter((text) => text.includes('"ping"'));
  }
}

globalThis.WebSocket = FakeSocket;
globalThis.location = { protocol: 'http:', host: 'localhost:3000' };

function makeNet() {
  FakeSocket.instances = [];
  const statuses = [];
  const net = createNet({ onStatus: (status) => statuses.push(status) });
  return { net, statuses };
}

test('连上后上报 online，并按固定间隔发心跳', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const { net, statuses } = makeNet();

  net.connect();
  const ws = FakeSocket.instances[0];
  ws.open();

  assert.deepEqual(statuses, ['connecting', 'online']);

  t.mock.timers.tick(8_000);
  assert.equal(ws.pings().length, 1, '连上后应当开始发心跳');

  t.mock.timers.tick(8_000);
  assert.equal(ws.pings().length, 2);

  net.close();
});

test('对端一直不回话时，主动断开僵尸连接并重连', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const { net, statuses } = makeNet();

  net.connect();
  const first = FakeSocket.instances[0];
  first.open();

  // 一路推进到超过 24 秒没有收到任何回包
  t.mock.timers.tick(24_000);
  t.mock.timers.tick(8_000);

  assert.equal(first.readyState, FakeSocket.CLOSED, '假在线的连接应当被主动关闭');

  // 退避 400ms 后发起新连接
  t.mock.timers.tick(500);
  assert.equal(FakeSocket.instances.length, 2, '应当发起新的连接');
  assert.ok(statuses.includes('reconnecting'), '上层要能看到重连状态');

  net.close();
});

test('正常收到回包时不会误判断线', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const { net } = makeNet();

  net.connect();
  const ws = FakeSocket.instances[0];
  ws.open();

  // 连续 5 个心跳周期都有回包，累计 40 秒，远超 24 秒阈值
  for (let i = 0; i < 5; i += 1) {
    t.mock.timers.tick(8_000);
    ws.receive({ t: 'pong' });
  }

  assert.equal(FakeSocket.instances.length, 1, '连接正常时不该重连');

  net.close();
});

test('被取代的旧连接再冒 close 事件，不会触发第二轮重连', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const { net } = makeNet();

  net.connect();
  const first = FakeSocket.instances[0];
  first.open();

  // 服务端断开 → 进入重连
  first.close();
  t.mock.timers.tick(500);
  assert.equal(FakeSocket.instances.length, 2);

  // 真实网络里旧连接常常还会再冒一次 close
  first.emit('close');
  t.mock.timers.tick(5_000);
  assert.equal(FakeSocket.instances.length, 2, '过期事件不该制造额外连接');

  net.close();
});

test('主动 close 之后不再自动重连', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const { net } = makeNet();

  net.connect();
  const ws = FakeSocket.instances[0];
  ws.open();

  net.close();
  t.mock.timers.tick(20_000);

  assert.equal(FakeSocket.instances.length, 1, '用户已经离开，不该偷偷重连回来');
});
