import { RealFeishuClient } from '../src/clients/feishuReal.js';

// Read-only configuration helper: prints node/space IDs, never access tokens or document content.
async function main() {
  const url = new URL(process.argv[2] ?? '');
  const token = /^\/wiki\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1];
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.feishu.cn') || !token || url.username || url.password) {
    throw new Error('请提供测试知识库首页的 https://租户.feishu.cn/wiki/节点 链接');
  }
  const node = await new RealFeishuClient().wikiClient().node(token);
  if (node.node_type === 'shortcut') throw new Error('不能使用快捷方式作为测试库首页');
  console.log(JSON.stringify({ ok: true, space_id: node.space_id,
    parent_node_token: node.node_token, title: node.title, url_origin: url.origin }, null, 2));
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '知识库访问检查失败'); process.exitCode = 1;
});
