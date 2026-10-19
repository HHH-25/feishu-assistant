import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { config } from '../src/config.js';

if (config.clientMode !== 'real' || config.feishu.appId !== 'cli_aa5a0c7cd0f5dc14') {
  throw new Error('仅允许在已核对的独立测试应用执行');
}
const actors = JSON.parse(config.apiActorsJson) as Array<{ key: string; spaces: string[] }>;
const publicActor = actors.find((actor) => actor.spaces.includes('space_public_test'));
if (!publicActor) throw new Error('未配置公共测试空间的可信身份');

const client = new Client({ name: 'real-readonly-check', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', 'src/mcp/server.ts'],
  cwd: process.cwd(),
  env: { ...process.env, MCP_API_KEY: publicActor.key } as Record<string, string>,
  stderr: 'pipe',
});
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  const archiveId = '78afdc4a-3e5a-41e9-a8e4-b44f48f8856d';
  const response = await client.callTool({ name: 'get_archive_status', arguments: { archive_id: archiveId } });
  const text = response.content.find((part) => part.type === 'text')?.text;
  if (response.isError || !text) throw new Error(`MCP 只读查询失败：${text ?? '无返回内容'}`);
  const record = JSON.parse(text) as { archive_id: string; file_id: string; status: string; space_id: string };
  if (record.archive_id !== archiveId || record.status !== 'success' || record.space_id !== 'space_public_test') {
    throw new Error('MCP 查询结果与公共测试归档不符');
  }
  process.stdout.write(`${JSON.stringify({ tools, archive_id: record.archive_id,
    file_id: record.file_id, status: record.status, space_id: record.space_id })}\n`);
} finally {
  await client.close();
}
