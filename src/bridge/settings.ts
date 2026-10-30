import dotenv from 'dotenv';
import { z } from 'zod/v4';

dotenv.config({ path: ['.env.local', '.env'], quiet: true } as dotenv.DotenvConfigOptions);
const id = z.string().regex(/^[A-Za-z0-9_-]+$/).max(200);
export const targetSchema = z.object({
  id, name: z.string().min(1), space_id: id, parent_node_token: id,
  staging_space_id: id.optional(), staging_folder_token: id.optional(),
  url_origin: z.string().url().refine(s => {
    const u = new URL(s); return u.protocol === 'https:' && u.origin === s && u.hostname.endsWith('.feishu.cn');
  }),
});
export type Target = z.infer<typeof targetSchema>;
export interface BridgeSettings {
  port: number; host: string; publicUrl: string; dbPath: string; keyPath: string;
  appId: string; appSecret: string; tenant: string; users: string[];
  accessMode?: 'allowlist' | 'tenant';
  resourceMode?: 'configured' | 'user';
  scopes: string; wiki: Target[];
  chats: { id: string; name: string; chat_id: string }[];
  tables: { id: string; name: string; app_token: string; table_id: string }[];
  recipients: { id: string; name: string; open_id: string; allowed_senders: string[] }[];
}
function json(name: string) { return JSON.parse(process.env[name] || '[]') as unknown; }
export function readSettings(): BridgeSettings {
  const env = process.env;
  const publicUrl = (env.MCP_PUBLIC_URL || '').replace(/\/$/, '');
  if (publicUrl && (new URL(publicUrl).protocol !== 'https:' || new URL(publicUrl).origin !== publicUrl)) {
    throw new Error('MCP_PUBLIC_URL 必须为不带路径的 HTTPS 地址');
  }
  const wiki = z.array(targetSchema).parse(json('FEISHU_WIKI_TARGETS_JSON'));
  const folders = JSON.parse(env.FEISHU_FOLDER_MAP_JSON || '{}') as Record<string, string>;
  for (const target of wiki) target.staging_folder_token ??= folders[target.staging_space_id || ''];
  const settings: BridgeSettings = {
    port: Number(env.MCP_PORT || 3010), host: '127.0.0.1', publicUrl,
    dbPath: env.MCP_STATE_DB_PATH || './data/bridge.db', keyPath: './data/bridge.key',
    appId: env.FEISHU_APP_ID || '', appSecret: env.FEISHU_APP_SECRET || '',
    tenant: env.MCP_FEISHU_TENANT_KEY || '',
    accessMode: z.enum(['allowlist', 'tenant']).parse(env.MCP_ACCESS_MODE || 'allowlist'),
    resourceMode: z.enum(['configured', 'user']).parse(env.MCP_RESOURCE_MODE || 'configured'),
    users: z.array(id).parse(json('MCP_ALLOWED_USERS_JSON')),
    scopes: env.MCP_FEISHU_SCOPES || 'offline_access wiki:wiki docx:document drive:file:upload im:chat:read im:chat.members:read im:message:readonly im:message.group_msg:get_as_user base:field:read base:record:retrieve base:record:create base:record:update',
    wiki,
    chats: z.array(z.object({ id, name: z.string().min(1), chat_id: id })).parse(json('MCP_CHATS_JSON')),
    tables: z.array(z.object({ id, name: z.string().min(1), app_token: id, table_id: id })).parse(json('MCP_TABLES_JSON')),
    recipients: z.array(z.object({ id, name: z.string().min(1), open_id: id,
      allowed_senders: z.array(id).min(1) })).parse(json('MCP_RECIPIENTS_JSON')),
  };
  for (const entries of [settings.wiki, settings.chats, settings.tables, settings.recipients]) {
    if (new Set(entries.map(v => v.id)).size !== entries.length) throw new Error('资源配置 ID 重复');
  }
  return settings;
}
export function missingSettings(s: BridgeSettings) {
  return [['MCP_PUBLIC_URL', s.publicUrl], ['FEISHU_APP_ID', s.appId],
    ['FEISHU_APP_SECRET', s.appSecret], ['MCP_FEISHU_TENANT_KEY', s.tenant],
    ['MCP_ALLOWED_USERS_JSON', s.accessMode === 'tenant' || s.users.length ? 'yes' : '']].filter(([, value]) => !value).map(([name]) => name);
}
