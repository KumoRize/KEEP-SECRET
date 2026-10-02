import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : config.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      'headers["x-api-key"]',
      '*.password',
      '*.apiKey',
      '*.token',
      '*.secret',
    ],
    censor: '[redacted]',
  },
});
