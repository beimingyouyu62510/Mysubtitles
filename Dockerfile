FROM node:20-alpine

# 安装必要的系统依赖
RUN apk add --no-cache \
    sqlite \
    python3 \
    make \
    g++

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

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "
    const http = require('http');
    const options = {
      host: '0.0.0.0',
      port: process.env.PORT || 3000,
      path: '/health',
      timeout: 2000
    };
    const req = http.request(options, (res) => {
      if (res.statusCode === 200) {
        process.exit(0);
      } else {
        process.exit(1);
      }
    });
    req.on('error', () => process.exit(1));
    req.end();
  "

# 启动命令
CMD ["npm", "start"]
