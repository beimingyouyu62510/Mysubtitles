FROM node:20-alpine

# 安装必要的系统依赖（包含 curl 用于健康检查）
RUN apk add --no-cache \
    sqlite \
    python3 \
    make \
    g++ \
    curl

# 设置工作目录
WORKDIR /usr/src/app

# 复制 package 文件
COPY package*.json ./

# 安装依赖
RUN npm ci --production --verbose

# 创建数据目录并设置权限
RUN mkdir -p /usr/src/app/data && \
    chown -R node:node /usr/src/app

# 复制应用代码
COPY --chown=node:node . .

# 切换到非 root 用户
USER node

# 暴露端口
EXPOSE 3000

# 使用 curl 进行健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

# 启动命令
CMD ["npm", "start"]
