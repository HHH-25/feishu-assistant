import { readSettings } from './bridge/settings.js';
import { BridgeStore } from './bridge/store.js';
import { createBridgeApp } from './bridge/app.js';

const settings=readSettings();
const store=new BridgeStore(settings.dbPath,settings.keyPath);
const {app}=await createBridgeApp(settings,store);
const server=app.listen(settings.port,settings.host,()=>{
  console.log(`飞书 MCP 服务：http://${settings.host}:${settings.port}（/health 查看接入状态）`);
});
function shutdown(){server.close(()=>{store.close();process.exit(0);});}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
