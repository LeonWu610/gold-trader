# ── 阶段 1：构建 React ────────────────────────────────────────
FROM node:18-bullseye AS builder

WORKDIR /app

# 先只复制依赖文件
COPY package.json ./

# 删除 package-lock 强制重新解析，安装时明确设置非 production 模式
RUN NODE_ENV=development npm install --prefer-offline

# 复制源码
COPY public/ ./public/
COPY src/ ./src/

# 接收构建时变量
ARG REACT_APP_BACKEND_URL
ENV REACT_APP_BACKEND_URL=$REACT_APP_BACKEND_URL

# 构建
RUN NODE_ENV=production ./node_modules/.bin/react-scripts build

# ── 阶段 2：运行静态文件服务器 ────────────────────────────────
FROM node:18-bullseye-slim

WORKDIR /app

RUN npm install -g serve

COPY --from=builder /app/build ./build

ENV PORT=8080
EXPOSE 8080

CMD serve -s build --listen tcp://0.0.0.0:$PORT
