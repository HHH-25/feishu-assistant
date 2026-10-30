#!/usr/bin/env bash
set -euo pipefail
patch_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
test "$(id -u)" = 0
cd /opt/feishu-mcp
systemctl is-active --quiet feishu-mcp.service
files=(dist/src/bridge/feishu.js dist/src/bridge/service.js dist/src/bridge/tools.js)
for file in "${files[@]}"; do test -f "$file"; done
(cd "$patch_dir" && sha256sum -c SHA256SUMS)
node --input-type=module <<'NODE'
import {readSettings,missingSettings} from './dist/src/bridge/settings.js';
import {BitableService} from './dist/src/bridge/bitable.js';
const s=readSettings();
if(s.appId!=='cli_aa6acb79effa9d2f'||s.tenant!=='1b617f6cfbcd974f'||s.publicUrl!=='https://mcp.zhiyinhui.top'||s.accessMode!=='tenant'||s.resourceMode!=='user'||missingSettings(s).length)
  throw Error('公司应用或资源查询配置不匹配，未更新');
if(typeof BitableService.prototype.create!=='function')throw Error('请先安装已验收的知识库/多维表格版本');
NODE
backup_dir="$(mktemp -d /root/feishu-identity-backup-XXXXXXXX)"
for file in "${files[@]}"; do
  mkdir -p "$backup_dir/$(dirname "$file")"
  cp -a "$file" "$backup_dir/$file"
done
rollback() {
  rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ]; then
    echo "更新失败，正在恢复。备份：$backup_dir"
    for file in "${files[@]}"; do cp -a "$backup_dir/$file" "$file"; done
    systemctl restart feishu-mcp.service || echo "恢复后重启失败，请检查服务状态"
  fi
  exit "$rc"
}
trap rollback EXIT
for file in "${files[@]}"; do cp "$patch_dir/$file" "$file"; done
node --input-type=module <<'NODE'
import {FeishuAuth} from './dist/src/bridge/feishu.js';
import {BridgeService} from './dist/src/bridge/service.js';
import {createTools} from './dist/src/bridge/tools.js';
if(typeof FeishuAuth.prototype.identity!=='function'||typeof BridgeService.prototype.identity!=='function')
  throw Error('企业身份查询功能未安装');
const server=createTools({});
await server.close();
console.log('企业身份查询模块加载通过');
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
echo "企业身份查询已更新，服务健康检查通过。备份：$backup_dir"
echo "请确认应用身份权限 tenant:tenant:readonly 已开通并发布，然后刷新 ChatGPT 工具并查询身份验收。"
