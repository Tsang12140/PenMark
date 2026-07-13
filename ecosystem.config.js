// PM2 进程管理配置
// 用法：pm2 start ecosystem.config.js
module.exports = {
  apps: [{
    name: 'penmark',
    script: 'server.js',
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production'
    },
    env_file: '.env',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    // 健康检查（graceful shutdown）
    kill_timeout: 5000,
    listen_timeout: 10000,
    // 启动前先等数据库就绪
    wait_ready: true,
    // 优雅关闭
    shutdown_with_message: false
  }]
};
