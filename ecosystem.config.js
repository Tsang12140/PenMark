// PM2 进程管理配置
module.exports = {
  apps: [{
    name: 'penmark',
    script: 'server.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: '3001'
    },
    // 日志
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    // 自动重启
    max_memory_restart: '300M',
    // 监听文件变化自动重启（生产环境建议关掉）
    watch: false,
  }]
};
