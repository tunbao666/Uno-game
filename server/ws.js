/**
 * 最小可用的 WebSocket 服务端实现（RFC 6455）。
 *
 * 为什么不用 ws 库：这个项目承诺"克隆下来 npm start 就能跑"，
 * 不引入任何依赖意味着不需要 npm install、也不会因为装包失败卡住。
 * 浏览器发来的帧只有文本消息、掩码固定、极少分片，因此手写解析的复杂度可控。
 *
 * 已处理：
 * - 握手（Sec-WebSocket-Accept 计算）
 * - 掩码解码、126/127 两种扩展长度
 * - 分片续帧（CONTINUATION）
 * - ping / pong 心跳与 close 握手
 * - 超大帧直接以 1009 关闭，避免被一条消息打爆内存
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

/** RFC 6455 规定的固定 GUID */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

/** 单条消息上限 256 KB，超过说明不是正常客户端 */
const MAX_PAYLOAD = 256 * 1024;

/** 把 opcode 与载荷打包成一帧（服务端发出的帧不加掩码） */
function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

/**
 * 一条已建立的连接。
 * 事件：message(string) / close() / error(Error)
 */
export class WsConnection extends EventEmitter {
  constructor(socket, request) {
    super();
    this.socket = socket;
    this.request = request;
    this.closed = false;
    this.isAlive = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (error) => {
      this.emit('error', error);
      this.destroy();
    });
    socket.on('close', () => this.#onClose());
    // 不设超时：长连接靠 ping/pong 保活，不能因为一时没数据就断开
    socket.setTimeout(0);
  }

  /** 发送一条文本消息 */
  send(text) {
    if (this.closed || this.socket.destroyed) return false;
    try {
      this.socket.write(encodeFrame(OPCODE.TEXT, Buffer.from(text, 'utf8')));
      return true;
    } catch {
      this.destroy();
      return false;
    }
  }

  /** 发送一条 JSON 消息 */
  sendJson(payload) {
    return this.send(JSON.stringify(payload));
  }

  ping() {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(encodeFrame(OPCODE.PING, Buffer.alloc(0)));
  }

  /** 走正常的 close 握手（客户端会收到 1000） */
  close(code = 1000, reason = '') {
    if (this.closed || this.socket.destroyed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    try {
      this.socket.write(encodeFrame(OPCODE.CLOSE, payload));
    } catch {
      /* 写失败就直接销毁 */
    }
    this.closed = true;
    this.socket.end();
  }

  destroy() {
    this.closed = true;
    this.socket.destroy();
  }

  #onClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  #onData(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    // 一个 chunk 里可能有多帧，循环解析到数据不够为止
    let guard = 0;
    while (!this.closed && this.#parseFrame()) {
      guard += 1;
      if (guard > 512) break; // 防御性上限，避免异常数据导致死循环
    }
  }

  /** 解析一帧；数据不完整时返回 false 等下一个 chunk */
  #parseFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return false;

    const first = buf[0];
    const second = buf[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buf.length < offset + 2) return false;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return false;
      const big = buf.readBigUInt64BE(offset);
      offset += 8;
      if (big > BigInt(MAX_PAYLOAD)) {
        this.close(1009, 'message too big');
        return false;
      }
      length = Number(big);
    }

    if (length > MAX_PAYLOAD) {
      this.close(1009, 'message too big');
      return false;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return false;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + length) return false;

    // 复制一份再解码，避免和后续帧共用同一块内存
    const payload = Buffer.alloc(length);
    buf.copy(payload, 0, offset, offset + length);
    if (maskKey) {
      for (let i = 0; i < length; i += 1) {
        payload[i] ^= maskKey[i & 3];
      }
    }

    this.buffer = buf.subarray(offset + length);
    this.#handleFrame(opcode, fin, payload);
    return true;
  }

  #handleFrame(opcode, fin, payload) {
    switch (opcode) {
      case OPCODE.PING:
        if (!this.closed) this.socket.write(encodeFrame(OPCODE.PONG, payload));
        return;

      case OPCODE.PONG:
        this.isAlive = true;
        return;

      case OPCODE.CLOSE:
        this.close(1000);
        return;

      case OPCODE.TEXT:
      case OPCODE.BINARY:
        if (fin) {
          this.#emitMessage(opcode, payload);
        } else {
          this.fragmentOpcode = opcode;
          this.fragments = [payload];
        }
        return;

      case OPCODE.CONTINUATION: {
        if (this.fragmentOpcode === null) return;
        this.fragments.push(payload);
        const total = this.fragments.reduce((sum, item) => sum + item.length, 0);
        if (total > MAX_PAYLOAD) {
          this.close(1009, 'message too big');
          return;
        }
        if (fin) {
          const merged = Buffer.concat(this.fragments);
          const type = this.fragmentOpcode;
          this.fragments = [];
          this.fragmentOpcode = null;
          this.#emitMessage(type, merged);
        }
        return;
      }

      default:
        this.close(1002, 'unsupported opcode');
    }
  }

  #emitMessage(opcode, payload) {
    if (opcode !== OPCODE.TEXT) return; // 本项目只用文本帧
    this.isAlive = true;
    this.emit('message', payload.toString('utf8'));
  }
}

/**
 * 把 WebSocket 能力挂到一个已有的 http.Server 上（与静态文件共用端口）。
 * @param {import('node:http').Server} server
 * @param {{path?: string}} options
 * @returns {EventEmitter} 触发 connection(WsConnection, request)
 */
export function attachWebSocketServer(server, { path = '/ws' } = {}) {
  const emitter = new EventEmitter();

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = request.headers['sec-websocket-key'];
    const version = request.headers['sec-websocket-version'];
    if (!key || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );

    // 升级请求可能已经把首帧数据塞进 head
    socket.removeAllListeners('data');
    socket.setNoDelay(true);

    const connection = new WsConnection(socket, request);
    if (head && head.length > 0) {
      socket.emit('data', head);
    }

    emitter.emit('connection', connection, request, url);
  });

  return emitter;
}
