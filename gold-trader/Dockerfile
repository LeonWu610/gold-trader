# ── 阶段 1：构建 React ────────────────────────────────────────
FROM node:18 AS builder

WORKDIR /app

# 先只复制依赖文件
COPY package.json package-lock.json ./

# 安装依赖
RUN npm install

# 复制源码
COPY public/ ./public/
COPY src/ ./src/

# 接收构建时变量
ARG REACT_APP_BACKEND_URL
ENV REACT_APP_BACKEND_URL=$REACT_APP_BACKEND_URL

# 用完整路径调用 react-scripts，绕过 PATH 问题
RUN ./node_modules/.bin/react-scripts build

# ── 阶段 2：运行静态文件服务器 ────────────────────────────────
FROM node:18-slim

WORKDIR /app

RUN npm install -g serve

COPY --from=builder /app/build ./build

ENV PORT=8080
EXPOSE 8080

CMD serve -s build --listen tcp://0.0.0.0:$PORT
