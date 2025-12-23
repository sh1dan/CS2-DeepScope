import winston from 'winston';

/**
 * Simple logger for CS2 DeepScope service
 * Uses CLI format with colors for easy debugging
 */
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.cli()
  ),
  transports: [
    // Simple console output with colors
    new winston.transports.Console(),
  ],
});

