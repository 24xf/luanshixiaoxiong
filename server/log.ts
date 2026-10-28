// 结构化日志：所有服务端日志统一为 JSON 单行，便于 ELK / grep / 采集。
// 用法：log.info('round', { room, turn, winners });  log.warn('reject', { reason });
import { inspect } from 'util';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function ser(v: unknown): unknown {
  if (v instanceof Error) return { message: v.message, stack: v.stack };
  if (typeof v === 'object' && v !== null) {
    try { return JSON.parse(JSON.stringify(v)); } catch { return inspect(v); }
  }
  return v;
}

export const log = {
  emit(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
    const safeFields = Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, ser(v)]),
    );
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...safeFields,
    });
    // error 走 stderr，其余 stdout；单行 JSON，方便管道采集
    if (level === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  },
  info(event: string, fields?: Record<string, unknown>) { this.emit('info', event, fields); },
  warn(event: string, fields?: Record<string, unknown>) { this.emit('warn', event, fields); },
  error(event: string, fields?: Record<string, unknown>) { this.emit('error', event, fields); },
  debug(event: string, fields?: Record<string, unknown>) {
    if (process.env.DEBUG) this.emit('debug', event, fields);
  },
};
