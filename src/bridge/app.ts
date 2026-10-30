import express from 'express';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { BridgeStore } from './store.js';
import { missingSettings, type BridgeSettings } from './settings.js';
import { FeishuAuth } from './feishu.js';
import { makeProvider, installInteractions, asyncRoute } from './oauth.js';
import { BridgeError, safeError } from './errors.js';
import { BridgeService } from './service.js';
import { createTools } from './tools.js';

export async function createBridgeApp(settings:BridgeSettings,store:BridgeStore,dependencies:{feishu?:FeishuAuth}={}) {
  const app=express();app.disable('x-powered-by');app.set('trust proxy','loopback');
  const missing=missingSettings(settings);
  app.use((req,res,next)=>{
    res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store',
      'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"});
    const hosts=new Set([`127.0.0.1:${settings.port}`,`localhost:${settings.port}`,...(settings.publicUrl?[new URL(settings.publicUrl).host]:[])]);
    if(!hosts.has(req.headers.host||'')){res.status(400).json({error:'invalid_host'});return;}next();
  });
  app.get('/health',(_req,res)=>res.json({service:'feishu-mcp',ready:missing.length===0,missing,
    legacy_daily_enabled:false,legacy_archive_enabled:false}));
  app.get('/',(_req,res)=>res.type('html').send('<meta charset="utf-8"><h1>公司飞书助手</h1><p>ChatGPT MCP 地址：当前站点地址后加 /mcp。</p><p>授权状态与配置缺项请查看 /health。旧日报、台账入口已停用。</p>'));
  if(missing.length){app.use('/mcp',(_req,res)=>res.status(503).json({error:'setup_required',missing}));return {app,provider:undefined};}
  const feishu=dependencies.feishu||new FeishuAuth(settings,store),provider=await makeProvider(settings,store,feishu);
  installInteractions(app,provider,settings,store,feishu);
  const resource=`${settings.publicUrl}/mcp`,metadataUrl=`${settings.publicUrl}/.well-known/oauth-protected-resource/mcp`;
  const metadata={resource,authorization_servers:[settings.publicUrl],scopes_supported:['mcp'],bearer_methods_supported:['header']};
  app.get(['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'],(_req,res)=>res.json(metadata));
  app.get('/.well-known/oauth-authorization-server',(_req,res)=>res.json({issuer:settings.publicUrl,
    authorization_endpoint:`${settings.publicUrl}/authorize`,token_endpoint:`${settings.publicUrl}/token`,
    registration_endpoint:`${settings.publicUrl}/register`,revocation_endpoint:`${settings.publicUrl}/revoke`,
    jwks_uri:`${settings.publicUrl}/jwks`,response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],
    token_endpoint_auth_methods_supported:['none','client_secret_basic','client_secret_post'],code_challenge_methods_supported:['S256'],
    scopes_supported:['openid','offline_access','mcp'],authorization_response_iss_parameter_supported:true}));
  app.all('/mcp',express.json({limit:'256kb'}),asyncRoute(async(req,res)=>{
    const origin=req.get('origin');
    if(origin&&origin!=='https://chatgpt.com'&&origin!==settings.publicUrl) throw new BridgeError('ORIGIN_DENIED','请求来源不允许',403);
    const bearer=req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
    const token=bearer?await provider.AccessToken.find(bearer):undefined;
    if(!token||!token.accountId||token.aud!==resource||!token.scope?.split(' ').includes('mcp')||
      !token.grantId||!await provider.Grant.find(token.grantId)) {
      res.set('WWW-Authenticate',`Bearer resource_metadata="${metadataUrl}"`).status(401).json({error:'invalid_token'});return;
    }
    let service:BridgeService;
    try{service=new BridgeService(settings,feishu,store,token.accountId);}
    catch{res.set('WWW-Authenticate',`Bearer resource_metadata="${metadataUrl}", error="invalid_token"`).status(401).json({error:'reconnect_required'});return;}
    if(req.method!=='POST'){res.set('Allow','POST').status(405).end();return;}
    const server=createTools(service),transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    try{
      await server.connect(transport);
      const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(typeof value==='string')headers.set(key,value);
      const request=new Request(resource,{method:'POST',headers,body:JSON.stringify(req.body)});
      const response=await transport.handleRequest(request,{parsedBody:req.body});
      res.status(response.status);response.headers.forEach((value,key)=>res.setHeader(key,value));
      res.end(Buffer.from(await response.arrayBuffer()));
    }finally{await server.close();}
  }));
  let registrations=0,windowStart=Date.now();
  app.use('/register',(req,res,next)=>{
    if(Date.now()-windowStart>3600000){registrations=0;windowStart=Date.now();}
    if(req.method==='POST'&&++registrations>30){res.status(429).json({error:'registration_rate_limited'});return;}next();
  });
  app.use(provider.callback());
  app.use((error:unknown,req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    if(res.headersSent)return;
    if(req.path.startsWith('/interaction/')||req.path==='/feishu/callback') {
      // Never log authorization codes, tokens, cookies, query strings or raw upstream errors.
      const expired=error instanceof Error && error.name==='SessionNotFound';
      store.audit('authorization','oauth_error',error instanceof BridgeError?error.code:expired?'SESSION_EXPIRED':'INTERNAL');
      const message=expired?'本次连接页面已过期或已经使用，请回到 ChatGPT 的公司飞书助手重新发起连接。':
        '本次授权连接未完成，请回到 ChatGPT 的公司飞书助手重新连接。若仍失败，请联系配置负责人检查授权记录。';
      res.status(error instanceof BridgeError?error.status:expired?400:500).type('html').send(
        `<!doctype html><meta charset="utf-8"><title>请重新连接飞书助手</title><h1>请重新连接飞书助手</h1><p>${message}</p><p>此页面处理账号连接，不涉及文档或消息写入。</p>`);
      return;
    }
    res.status(error instanceof BridgeError?error.status:500).json(safeError(error));
  });
  return {app,provider};
}
