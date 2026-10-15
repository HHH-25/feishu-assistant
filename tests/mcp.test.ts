import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createClients } from '../src/clients/factory.js';
import { createMcpServer } from '../src/mcp/server.js';

function firstText(content: Array<{ type: string; text?: string }>): string {
  const item = content.find((part) => part.type === 'text');
  if (!item?.text) throw new Error('MCP 工具未返回文本');
  return item.text;
}

describe('MCP 受控入口', () => {
  it('通过标准 MCP 协议完成归档、状态查询和手动汇总', async () => {
    const clients = createClients('mock');
    const server = createMcpServer(clients, { operator: 'user:demo', spaces: ['*'],
      can_run_summary: true, finance: true });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        'archive_file', 'get_archive_status', 'trigger_daily_summary',
      ]);
      const archive = await client.callTool({ name: 'archive_file', arguments: {
        file_name: 'test.txt', content_base64: Buffer.from('MCP test').toString('base64'),
        department: '销售', confidentiality: 'dept', space_id: 'space_sales',
      } });
      expect(archive.isError).not.toBe(true);
      const archived = JSON.parse(firstText(archive.content)) as { archive_id: string };
      const status = await client.callTool({ name: 'get_archive_status',
        arguments: { archive_id: archived.archive_id } });
      expect(JSON.parse(firstText(status.content)).status).toBe('success');
      const summary = await client.callTool({ name: 'trigger_daily_summary',
        arguments: { business_date: '2026-10-14' } });
      expect(summary.isError).not.toBe(true);
      expect(JSON.parse(firstText(summary.content)).message_sent).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
