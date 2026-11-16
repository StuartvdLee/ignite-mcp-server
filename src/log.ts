export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: string): value is LogLevel {
  return Object.hasOwn(LEVELS, value);
}

export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) return { error: error.message, errorName: error.name };
  return { error: String(error) };
}

/** Writes one JSON object per line: easy to query in Log Analytics. */
export function createLogger(level: LogLevel, write: (line: string, level: LogLevel) => void = defaultWrite): Logger {
  const emit = (messageLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVELS[messageLevel] < LEVELS[level]) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: messageLevel, msg: message, ...fields }), messageLevel);
  };
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

function defaultWrite(line: string, level: LogLevel): void {
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
