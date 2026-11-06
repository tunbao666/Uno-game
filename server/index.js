/**
 * 开发服务器：把项目根目录作为静态站点对外提供。
 *
 * 之所以需要它，是因为浏览器出于安全限制不允许用 file:// 加载 ES 模块，
 * 必须通过 http 协议访问。后续联机版本会在这个服务器上挂载 WebSocket。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

const server = createServer(async (req, res) => {
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
});

server.listen(PORT, () => {
  console.log(`UNO 已启动：http://localhost:${PORT}`);
});
