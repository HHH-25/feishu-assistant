#!/usr/bin/env bash
set -euo pipefail
patch_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
test "$(id -u)" = 0
cd /opt/feishu-mcp
systemctl is-active --quiet feishu-mcp.service
files=(dist/src/bridge/settings.js dist/src/bridge/service.js dist/src/bridge/tools.js dist/src/clients/wiki.js)
for file in "${files[@]}"; do test -f "$file"; done
(cd "$patch_dir" && sha256sum -c SHA256SUMS)
node --input-type=module <<'NODE'
import {readSettings} from './dist/src/bridge/settings.js';
const s=readSettings();
if(s.appId!=='cli_aa6acb79effa9d2f'||s.tenant!=='1b617f6cfbcd974f'||s.publicUrl!=='https://mcp.zhiyinhui.top'||s.accessMode!=='tenant')
  throw Error('公司应用配置不匹配，未更新');
NODE
backup_dir="$(mktemp -d /root/feishu-resources-backup-XXXXXXXX)"
cp -a .env.local "$backup_dir/env.local"
for file in "${files[@]}"; do
  mkdir -p "$backup_dir/$(dirname "$file")"
  cp -a "$file" "$backup_dir/$file"
done
rollback() {
  rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ]; then
    echo "更新失败，正在恢复。备份：$backup_dir"
    cp -a "$backup_dir/env.local" .env.local
    for file in "${files[@]}"; do cp -a "$backup_dir/$file" "$file"; done
    systemctl restart feishu-mcp.service || echo "恢复后重启失败，请检查服务状态"
  fi
  exit "$rc"
}
trap rollback EXIT
for file in "${files[@]}"; do cp "$patch_dir/$file" "$file"; done
node --input-type=module <<'NODE'
import {readFileSync,writeFileSync} from 'node:fs';
const path='.env.local',original=readFileSync(path,'utf8');
const stripped=original.replace(/^[ \t]*(?:export[ \t]+)?MCP_RESOURCE_MODE[ \t]*=.*(?:\r?\n|$)/gm,'');
writeFileSync(path,stripped.replace(/\s*$/,'')+'\nMCP_RESOURCE_MODE=user\n');
NODE
node --input-type=module <<'NODE'
import {readSettings,missingSettings} from './dist/src/bridge/settings.js';
import './dist/src/bridge/tools.js';
const s=readSettings();
if(s.resourceMode!=='user'||s.accessMode!=='tenant'||missingSettings(s).length)throw Error('资源查询配置验证失败');
console.log('按员工身份查询资源：配置检查通过');
NODE
systemctl restart feishu-mcp.service
healthy=false
for attempt in 1 2 3 4 5; do
  sleep 1
  if curl --noproxy '*' --fail --silent --max-time 3 http://127.0.0.1:3010/health |
    node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;try{const h=JSON.parse(s);if(h.service!=="feishu-mcp"||h.ready!==true)process.exit(1)}catch{process.exit(1)}'; then
    healthy=true
    break
  fi
done
test "$healthy" = true
systemctl is-active --quiet feishu-mcp.service
trap - EXIT
echo "员工知识库和群聊查询功能已启用，服务健康检查通过。"
echo "备份位置：$backup_dir"
echo "请在 ChatGPT 新聊天里选中飞书助手，重新查询知识库和群聊。"
