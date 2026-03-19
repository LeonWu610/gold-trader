# ── 阶段 1：构建 React ────────────────────────────────────────
FROM node:18-alpine AS builder

WORKDIR /app

# 先只复制依赖文件，充分利用 Docker 层缓存
COPY package.json package-lock.json ./

# 强制用 development 模式安装，确保 react-scripts 被安装
# 同时忽略 peer deps 冲突
RUN npm install --legacy-peer-deps

# 复制源码
COPY public/ ./public/
COPY src/ ./src/

# 构建生产包（此时 NODE_ENV=production 是正确的，react-scripts 已在 node_modules）
ARG REACT_APP_BACKEND_URL
ENV REACT_APP_BACKEND_URL=$REACT_APP_BACKEND_URL

RUN npm run build

# ── 阶段 2：运行静态文件服务器 ────────────────────────────────
FROM node:18-alpine

WORKDIR /app

# 只安装 serve，不需要其他依赖
RUN npm install -g serve

# 从构建阶段拷贝产物
COPY --from=builder /app/build ./build

# Railway 会注入 $PORT 环境变量
ENV PORT=8080
EXPOSE 8080

CMD serve -s build --listen tcp://0.0.0.0:$PORT
