import { config } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const minLevel = (LEVEL_ORDER[config.logLevel as Level] ?? LEVEL_ORDER.info);

/** 脱敏：避免密钥出现在日志 */
function sanitize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (/secret|token|api[_-]?key|password/i.test(value) && value.length > 8) {
      return '[REDACTED]';
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/secret|token|api[_-]?key|password|authorization/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitize(v);
      }
    }
    return out;
  }
  return value;
}

function write(level: Level, message: string, fields?: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < minLevel) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(fields ? (sanitize(fields) as Record<string, unknown>) : {}),
  };
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
};
