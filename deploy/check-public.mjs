// Read-only checks; never submit messages, modify resources, or print tokens.
const input = process.argv[2];
if (!input) throw new Error('Usage: node deploy/check-public.mjs https://mcp.example.com');
const url = new URL(input);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
  throw new Error('Provide an HTTPS origin without credentials, path, query or fragment');
}
const origin = url.origin;
async function get(path) {
  const response = await fetch(origin + path, {redirect: 'error', signal: AbortSignal.timeout(15000)});
  if (response.status !== 200) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
const health = await get('/health');
if (health.service !== 'feishu-mcp' || health.ready !== true) throw new Error('Service configuration is not ready');
const auth = await get('/.well-known/oauth-authorization-server');
for (const [key, value] of Object.entries({issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token'})) {
  if (auth[key] !== value) throw new Error(`OAuth origin mismatch: ${key}`);
}
const resource = await get('/.well-known/oauth-protected-resource/mcp');
if (resource.resource !== origin + '/mcp' || !resource.authorization_servers?.includes(origin)) {
  throw new Error('Resource metadata origin mismatch');
}
const denied = await fetch(origin + '/mcp', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}', redirect: 'error', signal: AbortSignal.timeout(15000)});
if (denied.status !== 401 || !denied.headers.get('www-authenticate')) throw new Error('Unauthenticated MCP request was not correctly rejected');
console.log('PASS: HTTPS, configuration readiness, OAuth origin, resource metadata, unauthenticated request rejection.');
console.log('Employee login, Feishu permissions, writes, restart recovery and backups still require acceptance.');
