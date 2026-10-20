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
process.stdout.write(`${target}\n`);
