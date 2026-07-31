type LogLevel = 'info' | 'warn' | 'error';

function write(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, message, ...(extra ?? {}) });
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (message: string, extra?: Record<string, unknown>) => write('info', message, extra),
  warn: (message: string, extra?: Record<string, unknown>) => write('warn', message, extra),
  error: (message: string, extra?: Record<string, unknown>) => write('error', message, extra),
};
