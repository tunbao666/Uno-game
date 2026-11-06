# 通用部署镜像：给 Render 之外的平台用（Railway / Zeabur / Fly.io / 自己的服务器）。
# Render 走 render.yaml 就够了，不需要这个文件。
#
# 构建：docker build -t uno-game .
# 运行：docker run -p 3000:3000 uno-game

FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# 先只拷清单再装依赖，让这一层能被缓存住
COPY package.json ./
# 本项目零第三方依赖；保留这步是为了以后加依赖时不用改 Dockerfile
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 3000

# 容器平台靠这个判断实例是否健康
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "server/index.js"]
