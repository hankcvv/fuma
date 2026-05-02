# Back4app Containers / 任意 Docker 宿主：单镜像 = 构建前端 + 跑 Express
FROM node:20-bookworm-slim AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=web-build /app/web/dist /app/web/dist
ENV NODE_ENV=production
EXPOSE 4000
# 容器平台通常注入 PORT，server/index.js 已读取 process.env.PORT
CMD ["node", "index.js"]
