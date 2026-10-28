// PM2 process config. CloudPanel's Node.js sites use PM2 under the hood to
// keep the app running and restart it if it crashes or the server reboots.
//
// If CloudPanel asks for a "Startup File", point it at src/server.js
// directly and you can ignore this file. If it asks for a PM2 config path
// (or you're managing PM2 yourself over SSH), point it at this file:
//   pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'ums-backend',
      script: './src/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
