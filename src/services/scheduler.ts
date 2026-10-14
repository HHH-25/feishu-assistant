import { config } from '../config.js';
import { logger } from '../logger.js';
import type { DailySummaryService } from './dailySummary.js';

/** Asia/Shanghai 业务日 YYYY-MM-DD */
export function shanghaiBusinessDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone || 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 当前是否落在上海时区的目标小时（默认 20） */
export function isShanghaiHour(hour: number, now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone || 'Asia/Shanghai',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '-1');
  return h === hour;
}

export interface SchedulerStatus {
  enabled: boolean;
  timezone: string;
  cron_expr: string;
  target_hour: number;
  last_fired_business_date: string | null;
  next_check_note: string;
}

/**
 * 轻量定时：每分钟检查一次，上海 20:00 触发当日汇总。
 * 真实系统 cron / 云定时可后置；与手动 POST /daily-summary/run 共用业务逻辑。
 */
export class DailySummaryScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFiredBusinessDate: string | null = null;
  private readonly targetHour = 20;

  constructor(private daily: DailySummaryService) {}

  getStatus(): SchedulerStatus {
    return {
      enabled: Boolean(this.timer) || config.dailyCronEnabled,
      timezone: config.timezone || 'Asia/Shanghai',
      cron_expr: '0 20 * * *',
      target_hour: this.targetHour,
      last_fired_business_date: this.lastFiredBusinessDate,
      next_check_note: config.dailyCronEnabled
        ? '进程内每分钟检查；到点触发一次/业务日'
        : 'DAILY_CRON_ENABLED=false，请用手动 API',
    };
  }

  start(): void {
    if (!config.dailyCronEnabled) {
      logger.info('日报定时未启用', { DAILY_CRON_ENABLED: false });
      return;
    }
    if (this.timer) return;
    const tick = () => void this.maybeFire();
    this.timer = setInterval(tick, 60_000);
    // 启动后立即检查一次（便于 mock 演示，不强制等到整分）
    tick();
    logger.info('日报定时已启动', {
      timezone: config.timezone,
      cron_expr: '0 20 * * *',
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 供单测：强制按给定时间尝试触发 */
  async maybeFire(now = new Date()): Promise<boolean> {
    if (!isShanghaiHour(this.targetHour, now)) return false;
    const businessDate = shanghaiBusinessDate(now);
    if (this.lastFiredBusinessDate === businessDate) return false;

    this.lastFiredBusinessDate = businessDate;
    const requestId = `cron_${businessDate}`;
    try {
      await this.daily.run({
        businessDate,
        operator: 'system:cron',
        trigger: 'cron',
        requestId,
      });
      logger.info('定时日报汇总已触发', { business_date: businessDate, request_id: requestId });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('定时日报汇总失败', { business_date: businessDate, error: message });
      return false;
    }
  }
}
