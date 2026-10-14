import type { DailyReport } from '../types.js';

export interface SummarizeInput {
  businessDate: string;
  reports: DailyReport[];
  missingEmployees: string[];
}

export interface SummarizeOutput {
  content: string;
}

/** 模型能力抽象 */
export interface ModelClient {
  summarizeDaily(input: SummarizeInput): Promise<SummarizeOutput>;
}

/** Mock：按模板拼接，不调用外网，不编造日报外事实 */
export class MockModelClient implements ModelClient {
  async summarizeDaily(input: SummarizeInput): Promise<SummarizeOutput> {
    const lines: string[] = [];
    lines.push(`【管理日报摘要】业务日 ${input.businessDate}`);
    lines.push('');
    lines.push('一、今日核心进展与关键数据');
    if (input.reports.length === 0) {
      lines.push('- 信息不足：当日无有效日报');
    } else {
      for (const r of input.reports) {
        lines.push(`- ${r.employee}（${r.department}）：${r.done_today || '信息不足'}`);
        if (r.metrics) lines.push(`  关键数据：${r.metrics}`);
      }
    }
    lines.push('');
    lines.push('二、各员工完成情况');
    for (const r of input.reports) {
      lines.push(`- ${r.employee}：完成「${r.done_today || '信息不足'}」；未完成「${r.unfinished || '无'}」`);
    }
    lines.push('');
    lines.push('三、未完成、延期与阻塞');
    const problems = input.reports.filter((r) => r.problems || r.unfinished);
    if (problems.length === 0) lines.push('- 信息不足或无上报阻塞');
    else {
      for (const r of problems) {
        lines.push(`- ${r.employee}：未完成=${r.unfinished || '无'}；问题=${r.problems || '无'}`);
      }
    }
    lines.push('');
    lines.push('四、需管理者决策');
    const decisions = input.reports.filter((r) => r.need_boss_decision);
    if (decisions.length === 0) lines.push('- 无');
    else {
      for (const r of decisions) {
        lines.push(`- ${r.employee}：${r.need_boss_decision}`);
      }
    }
    lines.push('');
    lines.push('五、明日重点');
    for (const r of input.reports) {
      lines.push(`- ${r.employee}：${r.tomorrow_plan || '信息不足'}`);
    }
    lines.push('');
    lines.push('六、未提交人员');
    lines.push(
      input.missingEmployees.length
        ? `- ${input.missingEmployees.join('、')}`
        : '- 无',
    );
    lines.push('');
    lines.push('七、引用日报记录标识');
    lines.push(
      input.reports.length
        ? `- ${input.reports.map((r) => r.record_id).join(', ')}`
        : '- 无',
    );
    return { content: lines.join('\n') };
  }
}

/**
 * 真实模型客户端占位。
 * TODO: 凭证就绪后对接 OpenAI 兼容 API；密钥仅从环境变量读取。
 */
export class RealModelClient implements ModelClient {
  async summarizeDaily(): Promise<SummarizeOutput> {
    throw new Error(
      'RealModelClient 尚未实现：请设置 CLIENT_MODE=mock，或待模型密钥就绪后实现',
    );
  }
}
