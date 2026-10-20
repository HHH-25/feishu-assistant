import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { config } from '../src/config.js';
import { createEmployeeMcpServer } from '../src/workbuddy/server.js';

if (process.env.FEISHU_TEST_EMPLOYEE_ALLOWED !== 'true' ||
    config.clientMode !== 'real' || config.feishu.appId !== 'cli_aa5a0c7cd0f5dc14') {
  throw new Error('仅允许隔离测试租户执行员工真实联调');
}
const baseUrl = process.env.VERIFY_EMPLOYEE_BASE_URL ?? 'http://127.0.0.1:3002';
const token = readFileSync(path.resolve('tmp/workbuddy-hyh-credential.txt'), 'utf8').trim();
const uploadRoot = path.resolve('tmp/workbuddy-upload');
mkdirSync(uploadRoot, { recursive: true });
const file = path.join(uploadRoot, `workbuddy-hyh-fictional-${new Date().toISOString().slice(0, 10)}.txt`);
writeFileSync(file, '虚构财务联调文件；不含真实业务数据。\n');

const server = createEmployeeMcpServer({ baseUrl, token, uploadRoot });
const client = new Client({ name: 'workbuddy-real-check', version: '0.1.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const read = (response: { isError?: boolean; content: unknown }) => {
  const item = (response.content as Array<{ type: string; text?: string }>).find((part) => part.type === 'text');
  if (response.isError || !item?.text) throw new Error(item?.text ?? 'MCP 操作失败');
  return JSON.parse(item.text) as Record<string, unknown>;
};

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const archive = read(await client.callTool({ name: 'archive_local_file', arguments: { file_path: file } }));
  const status = read(await client.callTool({ name: 'get_archive_status',
    arguments: { archive_id: archive.archive_id } }));
  if ((status.archive as { status?: string } | undefined)?.status !== 'success') {
    throw new Error('员工归档未成功');
  }
  const draft = { done_today: '核对虚构财务样例', metrics: '虚构记录 1 条',
    tomorrow_plan: '继续联调测试租户' };
  const first = read(await client.callTool({ name: 'submit_daily_report', arguments: draft }));
  const second = read(await client.callTool({ name: 'submit_daily_report', arguments: draft }));
  const diary = read(await client.callTool({ name: 'get_my_daily_report', arguments: {} }));
  if (first.record_id !== second.record_id || second.updated !== true ||
      (diary.report as { record_id?: string; employee?: string } | undefined)?.record_id !== first.record_id ||
      (diary.report as { employee?: string } | undefined)?.employee !== 'hyh') {
    throw new Error('员工日报幂等或身份核对失败');
  }
  process.stdout.write(`${JSON.stringify({ archive_id: archive.archive_id,
    file_id: archive.file_id, archive_status: 'success',
    daily_record_id: first.record_id, daily_updated: second.updated,
    employee: 'hyh' })}\n`);
} finally {
  await client.close();
  await server.close();
}
