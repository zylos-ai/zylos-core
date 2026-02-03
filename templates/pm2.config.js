// PM2 Ecosystem Configuration for Zylos
// Location: ~/zylos/pm2.config.js

const os = require('os');
const path = require('path');

const HOME = os.homedir();
const SKILLS_DIR = path.join(HOME, '.claude', 'skills');

module.exports = {
  apps: [
    {
      name: 'activity-monitor',
      script: path.join(SKILLS_DIR, 'self-maintenance', 'activity-monitor.js'),
      interpreter: 'node',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
    },
    {
      name: 'scheduler',
      script: path.join(SKILLS_DIR, 'scheduler', 'scheduler.js'),
      interpreter: 'node',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
        ZYLOS_DIR: path.join(HOME, 'zylos'),
      },
    },
    {
      name: 'c4-dispatcher',
      script: path.join(SKILLS_DIR, 'comm-bridge', 'c4-dispatcher.js'),
      interpreter: 'node',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 1000,  // Fast restart for message delivery
    },
    {
      name: 'web-console',
      script: path.join(SKILLS_DIR, 'web-console', 'server.js'),
      interpreter: 'node',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        WEB_CONSOLE_PORT: 3456,
        ZYLOS_DIR: path.join(HOME, 'zylos'),
      },
    },
    // Optional: Add channel-specific services here
    // {
    //   name: 'telegram-bot',
    //   script: path.join(SKILLS_DIR, 'telegram', 'bot.js'),
    //   ...
    // },
  ],
};
