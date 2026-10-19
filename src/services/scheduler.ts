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

/** 上海本地时间；超过目标小时后，当天剩余时间允许补跑。 */
export function shanghaiHourAndMinute(now = new Date()): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone || 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  return {
    hour: Number(parts.find((p) => p.type === 'hour')?.value ?? '-1'),
    minute: Number(parts.find((p) => p.type === 'minute')?.value ?? '-1'),
  };
}

/** 将检查对齐到时钟整分，避免进程在 16:29 启动后拖到 20:29 才触发。 */
export function millisecondsUntilNextMinute(now = new Date()): number {
  return 60_000 - (now.getTime() % 60_000);
}

export interface SchedulerStatus {
  enabled: boolean;
  timezone: string;
  cron_expr: string;
  target_hour: number;
  last_fired_business_date: string | null;
  last_fired_at: string | null;
  last_run_mode: 'on_time' | 'catch_up' | null;
  next_check_note: string;
}

/**
 * 轻量定时：每分钟检查一次，上海 20:00 起触发当日汇总。
 * 若主机在 20:00 休眠，当日醒来后补跑；跨日不自动回填。
 * 真实系统 cron / 云定时可后置；与手动 POST /daily-summary/run 共用业务逻辑。
 */
export class DailySummaryScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFiredBusinessDate: string | null = null;
  private lastFiredAt: string | null = null;
  private lastRunMode: 'on_time' | 'catch_up' | null = null;
  private checking = false;
  private readonly targetHour = 20;

  constructor(private daily: DailySummaryService) {}

  getStatus(): SchedulerStatus {
    return {
      enabled: Boolean(this.timer || this.initialTimer) || config.dailyCronEnabled,
      timezone: config.timezone || 'Asia/Shanghai',
      cron_expr: '0 20 * * *',
      target_hour: this.targetHour,
      last_fired_business_date: this.lastFiredBusinessDate,
      last_fired_at: this.lastFiredAt,
      last_run_mode: this.lastRunMode,
      next_check_note: config.dailyCronEnabled
        ? '进程内每分钟检查；20:00 起执行，若同日恢复运行则补跑；跨日不自动回填'
        : 'DAILY_CRON_ENABLED=false，请用手动 API',
    };
  }

  start(): void {
    if (!config.dailyCronEnabled) {
      logger.info('日报定时未启用', { DAILY_CRON_ENABLED: false });
      return;
    }
    if (this.timer || this.initialTimer) return;
    const tick = () => void this.maybeFire();
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      tick();
      this.timer = setInterval(tick, 60_000);
    }, millisecondsUntilNextMinute());
    // 启动后立即检查一次，允许错过 20:00 后同日重启补跑。
    tick();
    logger.info('日报定时已启动', {
      timezone: config.timezone,
      cron_expr: '0 20 * * *',
    });
  }

  stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 供单测：强制按给定时间尝试触发 */
  async maybeFire(now = new Date()): Promise<boolean> {
    const { hour, minute } = shanghaiHourAndMinute(now);
    if (hour < this.targetHour || hour > 23 || this.checking) return false;
    const businessDate = shanghaiBusinessDate(now);
    if (this.lastFiredBusinessDate === businessDate) return false;

    const requestId = `cron_${businessDate}`;
    this.checking = true;
    try {
      if (await this.daily.hasCompletedRun(businessDate)) {
        this.lastFiredBusinessDate = businessDate;
        logger.info('定时日报汇总已有成功记录，跳过重复执行', { business_date: businessDate });
        return false;
      }
      await this.daily.run({
        businessDate,
        operator: 'system:cron',
        trigger: 'cron',
        requestId,
      });
      this.lastFiredBusinessDate = businessDate;
      this.lastFiredAt = now.toISOString();
      this.lastRunMode = hour === this.targetHour && minute === 0 ? 'on_time' : 'catch_up';
      logger.info('定时日报汇总已触发', {
        business_date: businessDate,
        request_id: requestId,
        run_mode: this.lastRunMode,
      });
      return true;
    } catch (err) {
      logger.error('定时日报汇总失败', { business_date: businessDate, error: 'UPSTREAM' });
      return false;
    } finally {
      this.checking = false;
    }
  }
}
