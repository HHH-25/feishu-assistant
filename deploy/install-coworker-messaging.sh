#!/usr/bin/env bash
set -euo pipefail
patch_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
test "$(id -u)" = 0
cd /opt/feishu-mcp
systemctl is-active --quiet feishu-mcp.service
files=(dist/src/bridge/service.js dist/src/bridge/tools.js)
for file in "${files[@]}"; do test -f "$file"; done
(cd "$patch_dir" && sha256sum -c SHA256SUMS)
node --input-type=module <<'NODE'
import {readSettings,missingSettings} from './dist/src/bridge/settings.js';
const s=readSettings();
if(s.appId!=='cli_aa6acb79effa9d2f'||s.tenant!=='1b617f6cfbcd974f'||s.publicUrl!=='https://mcp.zhiyinhui.top'||s.accessMode!=='tenant'||s.resourceMode!=='user'||missingSettings(s).length)
  throw Error('公司应用或资源查询配置不匹配，未更新');
NODE
backup_dir="$(mktemp -d /root/feishu-messaging-backup-XXXXXXXX)"
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
import {BridgeService} from './dist/src/bridge/service.js';
import './dist/src/bridge/tools.js';
if(typeof BridgeService.prototype.findPeople!=='function')throw Error('查找收件人工具未安装');
console.log('同事查找与私信功能：程序检查通过');
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
echo "同事查找与私信功能已更新，服务健康检查通过。"
echo "备份位置：$backup_dir"
echo "下一步：在 ChatGPT 更新插件工具列表，再测试查找技术部的刘明天。"
