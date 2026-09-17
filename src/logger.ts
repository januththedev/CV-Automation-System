import pino from 'pino';

const REDACT_PATHS = [
  '*.apiKey',
  '*.accessToken',
  '*.privateKey',
  '*.appSecret',
  '*.verifyToken',
  '*.password',
  'Authorization',
  'req.headers.authorization',
];

export const logger = pino({
  level: process.env.CV_LOG_LEVEL ?? 'info',
  transport:
    process.env.CV_LOG_PRETTY === '1'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
});
