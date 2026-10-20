import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
import { ALLOWED_EXTENSIONS, MAX_FILE_BYTES } from '../config.js';

export interface EmployeeMcpSettings {
  baseUrl: string;
  token: string;
  uploadRoot: string;
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function failure(err: unknown) {
  return { isError: true, content: [{ type: 'text' as const,
    text: err instanceof Error ? err.message : '操作失败，请检查本机连接器日志' }] };
}

function baseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('员工服务地址必须使用 HTTPS；仅本机测试可使用 HTTP');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('员工服务地址只填写站点根地址');
  }
  return url.origin;
}

async function allowedFile(filePath: string, root: string): Promise<{ fileName: string; buffer: Buffer }> {
  if (!path.isAbsolute(filePath)) throw new Error('请选择上传目录内的绝对文件路径');
  const [actualRoot, actualFile] = await Promise.all([realpath(root), realpath(filePath)]);
  const relative = path.relative(actualRoot, actualFile);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('文件不在授权上传目录内');
  }
  const info = await stat(actualFile);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_FILE_BYTES) {
    throw new Error(`文件必须非空且不超过 ${MAX_FILE_BYTES} 字节`);
  }
  const fileName = path.basename(actualFile);
  if (!ALLOWED_EXTENSIONS.has(path.extname(fileName).toLowerCase())) {
    throw new Error('仅支持 PDF、DOCX、XLSX、TXT 文件');
  }
  const buffer = await readFile(actualFile);
  if (buffer.length !== info.size) throw new Error('文件读取期间发生变化，请重试');
  return { fileName, buffer };
}

export function createEmployeeMcpServer(settings: EmployeeMcpSettings, fetcher: typeof fetch = fetch): McpServer {
  const origin = baseUrl(settings.baseUrl);
  if (settings.token.length < 24) throw new Error('缺少员工专用访问凭证');
  if (!settings.uploadRoot) throw new Error('缺少员工授权上传目录');
  const server = new McpServer({ name: 'feishu-datacenter-employee', version: '0.1.0' });
  const call = async (route: string, options: RequestInit = {}) => {
    const response = await fetcher(`${origin}${route}`, {
      ...options, headers: { authorization: `Bearer ${settings.token}`,
        'x-request-id': randomUUID(), ...options.headers }, signal: AbortSignal.timeout(90_000),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const error = body.error as { message?: string } | undefined;
      throw new Error(error?.message || `服务返回 HTTP ${response.status}`);
    }
    return body;
  };

  server.registerTool('archive_local_file', {
    description: '把授权上传目录内的本地 PDF、DOCX、XLSX 或 TXT 原文件归档到当前员工获准的飞书目录；不会解析文件内容。上传前须让员工明确指定文件。',
    inputSchema: z.object({ file_path: z.string().min(1) }),
  }, async ({ file_path }) => {
    try {
      const file = await allowedFile(file_path, settings.uploadRoot);
      const form = new FormData();
      form.set('file', new Blob([Uint8Array.from(file.buffer)]), file.fileName);
      const body = await call('/api/v1/employee/archives', { method: 'POST', body: form });
      return result(body);
    } catch (err) { return failure(err); }
  });

  server.registerTool('get_archive_status', {
    description: '按归档 ID 查看当前员工自己的文件是否成功入库及飞书链接。',
    inputSchema: z.object({ archive_id: z.string().uuid() }),
  }, async ({ archive_id }) => {
    try { return result(await call(`/api/v1/archives/${encodeURIComponent(archive_id)}`)); }
    catch (err) { return failure(err); }
  });

  server.registerTool('submit_daily_report', {
    description: '提交当前员工今天的日报；同日再次提交会更新同一条飞书记录。员工、部门、日期和密级由服务端身份确定，不可代填他人。',
    inputSchema: z.object({
      done_today: z.string().min(1), metrics: z.string().optional(), unfinished: z.string().optional(),
      problems: z.string().optional(), tomorrow_plan: z.string().optional(),
      need_help: z.string().optional(), need_boss_decision: z.string().optional(),
    }),
  }, async (draft) => {
    try { return result(await call('/api/v1/employee/daily-report', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft),
    })); }
    catch (err) { return failure(err); }
  });

  server.registerTool('get_my_daily_report', {
    description: '查看当前员工指定业务日的日报；不填日期则查今天。',
    inputSchema: z.object({ date: z.iso.date().optional() }),
  }, async ({ date }) => {
    try { return result(await call(`/api/v1/employee/daily-report${date ? `?date=${date}` : ''}`)); }
    catch (err) { return failure(err); }
  });

  return server;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/workbuddy/server.ts') ||
    process.argv[1]?.replace(/\\/g, '/').endsWith('/workbuddy/server.js')) {
  const server = createEmployeeMcpServer({
    baseUrl: process.env.MVP_BASE_URL ?? '', token: process.env.MVP_EMPLOYEE_TOKEN ?? '',
    uploadRoot: process.env.MVP_UPLOAD_ROOT ?? '',
  });
  void serveStdio(() => server);
}
