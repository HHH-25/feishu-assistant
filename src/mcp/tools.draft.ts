/**
 * MCP 工具清单（草案挂点）。
 * 业务全部委托 ArchiveService / DailySummaryService，本层仅做参数映射。
 * 凭证与 Connect 就绪后再注册真正的 MCP Server。
 */

export const MCP_TOOL_DEFS = [
  {
    name: 'archive_file',
    description: '将文件归档到飞书目标空间并写入台账',
    inputSchema: {
      type: 'object',
      required: ['file_name', 'content_base64', 'department', 'confidentiality', 'space_id', 'operator'],
      properties: {
        file_name: { type: 'string' },
        content_base64: { type: 'string' },
        department: { type: 'string' },
        confidentiality: { type: 'string', enum: ['public', 'dept', 'mgmt', 'finance'] },
        space_id: { type: 'string' },
        operator: { type: 'string' },
        source: { type: 'string' },
      },
    },
  },
  {
    name: 'get_archive_status',
    description: '按 archive_id 查询归档与台账状态',
    inputSchema: {
      type: 'object',
      required: ['archive_id'],
      properties: { archive_id: { type: 'string' } },
    },
  },
  {
    name: 'trigger_daily_summary',
    description: '手动触发指定业务日的日报汇总（与 20:00 逻辑相同）',
    inputSchema: {
      type: 'object',
      required: ['business_date', 'operator'],
      properties: {
        business_date: { type: 'string', description: 'YYYY-MM-DD' },
        operator: { type: 'string' },
      },
    },
  },
] as const;
