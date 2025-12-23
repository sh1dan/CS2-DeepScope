require('dotenv').config();

/**
 * PM2 Ecosystem Configuration for CS2 DeepScope
 * 
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 stop cs2-deepscope
 *   pm2 restart cs2-deepscope
 *   pm2 logs cs2-deepscope
 *   pm2 delete cs2-deepscope
 */
module.exports = {
  apps: [
    {
      name: 'cs2-deepscope',
      script: 'dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        // Load environment variables from .env file (via dotenv.config() above)
        // All variables from .env will be available in process.env
        STEAM_USERNAME: process.env.STEAM_USERNAME,
        STEAM_PASSWORD: process.env.STEAM_PASSWORD,
        STEAM_SHARED_SECRET: process.env.STEAM_SHARED_SECRET,
        API_PORT: process.env.API_PORT || '3000',
        ENABLE_FILE_CACHE: process.env.ENABLE_FILE_CACHE || 'false',
        OUTPUT_DIR: process.env.OUTPUT_DIR || './output',
        LOG_LEVEL: process.env.LOG_LEVEL || 'info',
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      time: true,
    },
  ],
};

