// PM2 Ecosystem Configuration for Zylos
// Location: ~/zylos/pm2.config.js

module.exports = {
  apps: [
    {
      name: 'activity-monitor',
      script: '~/.claude/skills/self-maintenance/activity-monitor.sh',
      interpreter: '/bin/bash',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
    },
    {
      name: 'scheduler',
      script: '~/.claude/skills/scheduler/scheduler.js',
      interpreter: 'node',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
        ZYLOS_DIR: process.env.HOME + '/zylos',
      },
    },
    // Optional: Add channel-specific services here
    // {
    //   name: 'telegram-bot',
    //   script: '~/.claude/skills/telegram/bot.js',
    //   ...
    // },
  ],
};
