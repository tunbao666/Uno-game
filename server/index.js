/**
 * 应用服务器：静态站点 + WebSocket 房间服务，共用同一个端口。
 *
 * 之所以需要服务端，是因为浏览器之间不能直接通信：
 * 房间码联机必须有一个中间人负责转发消息、并且充当唯一的规则裁判，
 * 否则任何一个玩家改前端就能作弊。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { RoomManager } from './rooms.js';
import { attachWebSocketServer } from './ws.js';

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 心跳间隔：清理已经断网但没触发 close 的僵尸连接 */
const HEARTBEAT_MS = 30_000;

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function handleHttp(req, res) {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    // 根路径要重定向到真实入口，否则页面里的相对路径（./css、./js）
    // 会以 / 为基准解析，导致样式与脚本全部 404
    if (pathname === '/') {
      res.writeHead(302, { location: '/client/index.html' });
      res.end();
      return;
    }

    const filePath = normalize(join(ROOT, pathname));

    // 阻止越权访问项目目录之外的文件
    if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
      sendText(res, 403, '禁止访问');
      return;
    }

    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
      sendText(res, 404, '页面不存在');
      return;
    }

    const content = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(content);
  } catch {
    sendText(res, 500, '服务器内部错误');
  }
}

/**
 * 创建一个完整的 UNO 服务实例（尚未 listen，便于测试里用随机端口启动）。
 */
export function createUnoServer(options = {}) {
  const manager = new RoomManager(options);
  const server = createServer(handleHttp);
  const wsServer = attachWebSocketServer(server, { path: '/ws' });

  /** @type {Set<object>} 所有活着的连接，用于心跳巡检 */
  const connections = new Set();

  wsServer.on('connection', (connection) => {
    connections.add(connection);
    manager.attach(connection);

    connection.on('message', (raw) => manager.handle(connection, raw));
    connection.on('error', () => connections.delete(connection));
    connection.on('close', () => connections.delete(connection));
  });

  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      if (!connection.isAlive) {
        connection.destroy();
        connections.delete(connection);
        continue;
      }
      connection.isAlive = false;
      connection.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    server,
    manager,
    listen(port = PORT) {
      return new Promise((resolve) => {
        server.listen(port, () => resolve(server.address()));
      });
    },
    close() {
      clearInterval(heartbeat);
      for (const connection of connections) connection.close(1001, 'server shutdown');
      connections.clear();
      manager.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// 直接 node server/index.js 运行时才监听端口；被测试 import 时保持安静
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const app = createUnoServer();
  app.listen().then(() => {
    console.log(`UNO 已启动：http://localhost:${PORT}`);
    console.log(`联机 WebSocket：ws://localhost:${PORT}/ws`);
  });
}
