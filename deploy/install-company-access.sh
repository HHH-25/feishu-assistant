#!/usr/bin/env bash
set -euo pipefail
patch_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
test "$(id -u)" = 0
cd /opt/feishu-mcp
systemctl is-active --quiet feishu-mcp.service
test -f .env.local
test -f dist/src/bridge/settings.js
test -f dist/src/bridge/feishu.js
(cd "$patch_dir" && sha256sum -c SHA256SUMS)
node --input-type=module <<'NODE'
import {readSettings} from './dist/src/bridge/settings.js';
const s=readSettings();
if(s.appId!=='cli_aa6acb79effa9d2f'||s.tenant!=='1b617f6cfbcd974f'||s.publicUrl!=='https://mcp.zhiyinhui.top')
  throw Error('目标应用或企业不匹配，未更新');
NODE
backup_dir="$(mktemp -d /root/feishu-company-backup-XXXXXXXX)"
cp -a .env.local "$backup_dir/env.local"
cp -a dist/src/bridge/settings.js "$backup_dir/settings.js"
cp -a dist/src/bridge/feishu.js "$backup_dir/feishu.js"
rollback() {
  rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ]; then
    echo "更新失败，正在恢复原配置和程序。备份：$backup_dir"
    cp -a "$backup_dir/env.local" .env.local
    cp -a "$backup_dir/settings.js" dist/src/bridge/settings.js
    cp -a "$backup_dir/feishu.js" dist/src/bridge/feishu.js
    systemctl restart feishu-mcp.service || echo "恢复后重启失败，请检查服务状态"
  fi
  exit "$rc"
}
trap rollback EXIT
cp "$patch_dir/settings.js" dist/src/bridge/settings.js
cp "$patch_dir/feishu.js" dist/src/bridge/feishu.js
node --input-type=module <<'NODE'
import {readFileSync,writeFileSync} from 'node:fs';
const path='.env.local';
const original=readFileSync(path,'utf8');
const stripped=original.replace(/^[ \t]*(?:export[ \t]+)?MCP_ACCESS_MODE[ \t]*=.*(?:\r?\n|$)/gm,'');
writeFileSync(path,stripped.replace(/\s*$/,'')+'\nMCP_ACCESS_MODE=tenant\n');
NODE
node --input-type=module <<'NODE'
import {readSettings,missingSettings} from './dist/src/bridge/settings.js';
const s=readSettings();
if(s.accessMode!=='tenant'||missingSettings(s).length)throw Error('公司接入配置验证失败');
console.log('公司成员接入模式配置通过');
NODE
systemctl restart feishu-mcp.service
healthy=false
for attempt in 1 2 3 4 5; do
  if curl --noproxy '*' --fail --silent --show-error --max-time 3 http://127.0.0.1:3010/health |
    node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;try{const h=JSON.parse(s);if(h.service!=="feishu-mcp"||h.ready!==true)process.exit(1)}catch{process.exit(1)}'; then
    healthy=true
    break
  fi
  sleep 1
done
test "$healthy" = true
systemctl is-active --quiet feishu-mcp.service
trap - EXIT
echo "公司成员接入模式已启用，服务健康检查通过。"
echo "备份位置：$backup_dir"
echo "请回到 ChatGPT 重新发起连接，让周涛扫码授权。"
