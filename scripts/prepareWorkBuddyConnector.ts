import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const entry = path.resolve(root, 'dist/src/workbuddy/server.js');
if (!existsSync(entry)) throw new Error('请先运行 npm run build');
const target = path.resolve(root, 'tmp/workbuddy-connector');
mkdirSync(target, { recursive: true });
cpSync(path.resolve(root, 'workbuddy'), target, { recursive: true, force: true });
const configPath = path.join(target, 'mcp.json');
const template = readFileSync(configPath, 'utf8');
writeFileSync(configPath, template.replace('__ABSOLUTE_SERVER_JS__',
  entry.replace(/\\/g, '/')));
const localConfig = {
  mcpServers: {
    'feishu-datacenter-employee': {
      type: 'stdio', command: process.execPath, args: [entry.replace(/\\/g, '/')],
      env: {
        MVP_EMPLOYEE_TOKEN_FILE: path.resolve(root,
          process.env.MVP_EMPLOYEE_TOKEN_FILE ?? 'tmp/workbuddy-hyh-credential.txt'),
        MVP_BASE_URL: process.env.MVP_BASE_URL ?? 'http://127.0.0.1:3001',
        MVP_UPLOAD_ROOT: path.resolve(root, 'tmp/workbuddy-upload'),
      },
      timeout: 30000,
    },
  },
};
writeFileSync(path.join(target, 'mcp.local.json'), `${JSON.stringify(localConfig, null, 2)}\n`);
process.stdout.write(`${target}\n`);
