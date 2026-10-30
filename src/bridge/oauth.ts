import Provider, { errors, type Adapter, type AdapterPayload } from 'oidc-provider';
import { generateKeyPair, exportJWK } from 'jose';
import { randomBytes, createHash } from 'node:crypto';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { BridgeStore } from './store.js';
import { FeishuAuth } from './feishu.js';
import type { BridgeSettings } from './settings.js';
import { BridgeError } from './errors.js';

const random = () => randomBytes(32).toString('base64url');
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export const asyncRoute = (fn: (req: Request,res: Response) => Promise<unknown>) =>
  (req: Request,res: Response,next: NextFunction) => { void fn(req,res).catch(next); };
export function allowedRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://chatgpt.com' && !url.username && !url.password && !url.search && !url.hash &&
      (url.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname));
  } catch { return false; }
}
export function adapterFactory(store: BridgeStore) {
  return (name: string): Adapter => ({
    async upsert(id,payload,ttl) { store.put(name,id,payload,ttl,payload.uid,payload.grantId); },
    async find(id) { return store.get<AdapterPayload>(name,id); },
    async findByUid(uid) { return store.find<AdapterPayload>(name,'uid',uid); },
    async findByUserCode() { return undefined; },
    async consume(id) {
      const payload = store.get<AdapterPayload>(name,id);
      if (payload) { payload.consumed = Math.floor(Date.now()/1000);
        store.put(name,id,payload,payload.exp ? Math.max(1,payload.exp-Math.floor(Date.now()/1000)) : 600,payload.uid,payload.grantId); }
    },
    async destroy(id) { store.delete(name,id); },
    async revokeByGrantId(id) { store.revokeGrant(id); },
  });
}
export async function makeProvider(settings: BridgeSettings, store: BridgeStore, feishu: FeishuAuth) {
  let jwks = store.get<{keys: Record<string, any>[]}>('config','jwks');
  if (!jwks) {
    const {privateKey} = await generateKeyPair('RS256',{extractable:true});
    jwks = {keys:[{...await exportJWK(privateKey),kid:random(),use:'sig',alg:'RS256'}]};
    store.put('config','jwks',jwks);
  }
  let cookieKey = store.get<string>('config','cookie');
  if (!cookieKey) { cookieKey=random();store.put('config','cookie',cookieKey); }
  const resource = `${settings.publicUrl}/mcp`;
  const provider = new Provider(settings.publicUrl, {
    adapter:adapterFactory(store), jwks,
    cookies:{keys:[cookieKey],long:{secure:true,httpOnly:true,sameSite:'lax'},short:{secure:true,httpOnly:true,sameSite:'lax'}},
    routes:{authorization:'/authorize',token:'/token',registration:'/register',revocation:'/revoke',jwks:'/jwks'},
    scopes:['openid','offline_access'], responseTypes:['code'],
    pkce:{required:()=>true},
    ttl:{AccessToken:900,AuthorizationCode:120,RefreshToken:7*86400,Session:3600,Interaction:600,Grant:7*86400,IdToken:900},
    issueRefreshToken:(_ctx,client)=>client.grantTypeAllowed('refresh_token'),
    rotateRefreshToken:true,
    features:{devInteractions:{enabled:false},dPoP:{enabled:false},pushedAuthorizationRequests:{enabled:false},registration:{enabled:true},revocation:{enabled:true},
      resourceIndicators:{enabled:true,defaultResource:()=>resource,useGrantedResource:()=>true,
        getResourceServerInfo:(_ctx,requested)=>{
          if(requested!==resource) throw new errors.InvalidTarget();
          return {scope:'mcp',audience:resource,accessTokenTTL:900,accessTokenFormat:'opaque'};
        }}},
    extraClientMetadata:{properties:['bridge_policy'],validator:(_ctx,_key,_value,metadata)=>{
      if (!metadata.redirect_uris?.length || !metadata.redirect_uris.every(allowedRedirect) ||
          metadata.jwks_uri || metadata.sector_identifier_uri || metadata.request_uris ||
          metadata.initiate_login_uri) throw new errors.InvalidClientMetadata('仅允许 ChatGPT 官方回调，不允许远程客户端元数据地址');
      if (metadata.grant_types?.some(g=>g!=='authorization_code'&&g!=='refresh_token'))
        throw new errors.InvalidClientMetadata('仅支持授权码和刷新令牌');
    }},
    interactions:{url:(_ctx,interaction)=>`/interaction/${interaction.uid}`},
    findAccount:async (_ctx,sub)=>{
      try { feishu.person(sub); return {accountId:sub,claims:async()=>({sub})}; }
      catch { return undefined; }
    },
    renderError:async (ctx)=>{ctx.type='html';ctx.body='<h1>授权未完成</h1><p>请回到 ChatGPT 重新连接；若重复失败，请检查回调地址、权限和账号范围。</p>';},
  });
  provider.proxy = true;
  return provider;
}
export function installInteractions(app: Express,provider: Provider,settings: BridgeSettings,store: BridgeStore,feishu: FeishuAuth) {
  app.get('/interaction/:uid',asyncRoute(async(req,res)=>{
    const interaction = await provider.interactionDetails(req,res);
    if(interaction.uid!==req.params.uid) throw new BridgeError('INVALID_SESSION','授权会话无效',400);
    res.set('Cache-Control','no-store');
    if(interaction.prompt.name==='login') {
      const state=random(),verifier=random();
      store.put('login',state,{uid:interaction.uid,verifier},600);
      res.cookie('bridge_login',state,{secure:true,httpOnly:true,sameSite:'lax',maxAge:600000,path:'/feishu/callback'});
      const params=new URLSearchParams({client_id:settings.appId,response_type:'code',
        redirect_uri:`${settings.publicUrl}/feishu/callback`,state,scope:settings.scopes,
        code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
      res.redirect(`https://accounts.feishu.cn/open-apis/authen/v1/authorize?${params}`);return;
    }
    if(interaction.prompt.name!=='consent' || !interaction.session?.accountId) throw new BridgeError('LOGIN_REQUIRED','请重新连接',401);
    const person=feishu.person(interaction.session.accountId),csrf=random();
    store.put('consent',interaction.uid,csrf,600);
    // Browsers apply form-action to redirects following the consent POST too.
    // The final OAuth callback must be allowed, while all other destinations stay blocked.
    res.set('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'");
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>连接公司飞书助手</title>
      <main style="max-width:620px;margin:60px auto;font:18px/1.7 sans-serif"><h1>连接公司飞书助手</h1>
      <p>当前员工：${escape(person.name)}</p><p>允许 ChatGPT 根据你的指令访问配置范围内的知识库、群消息和多维表格。
      内容读取使用你的权限；消息发送显示应用机器人。此授权不增加你的飞书权限。</p>
      <form method="post"><input type="hidden" name="csrf" value="${csrf}">
      <button name="decision" value="allow">允许连接</button> <button name="decision" value="deny">取消</button></form></main>`);
  }));
  app.post('/interaction/:uid',express.urlencoded({extended:false,limit:'8kb'}),asyncRoute(async(req,res)=>{
    const interaction=await provider.interactionDetails(req,res);
    if(interaction.uid!==req.params.uid || typeof req.body.csrf!=='string' ||
      store.get('consent',interaction.uid)!==req.body.csrf) throw new BridgeError('INVALID_SESSION','授权确认已过期',400);
    store.delete('consent',interaction.uid);
    if(req.body.decision!=='allow') { await provider.interactionFinished(req,res,{error:'access_denied',error_description:'User cancelled'},{mergeWithLastSubmission:false});return; }
    const sub=interaction.session?.accountId;if(!sub) throw new BridgeError('LOGIN_REQUIRED','请重新连接',401);
    feishu.person(sub);
    const grant=interaction.grantId ? await provider.Grant.find(interaction.grantId) :
      new provider.Grant({accountId:sub,clientId:String(interaction.params.client_id)});
    if(!grant) throw new BridgeError('LOGIN_REQUIRED','授权已失效',401);
    grant.addOIDCScope('openid offline_access');grant.addResourceScope(`${settings.publicUrl}/mcp`,'mcp');
    await provider.interactionFinished(req,res,{consent:{grantId:await grant.save()}},{mergeWithLastSubmission:true});
  }));
  app.get('/feishu/callback',asyncRoute(async(req,res)=>{
    const state=typeof req.query.state==='string'?req.query.state:'';
    const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('bridge_login='))?.slice(13);
    const flow=store.get<{uid:string;verifier:string}>('login',state);
    if(!state||cookie!==state||!flow) throw new BridgeError('INVALID_STATE','飞书授权会话已过期，请重新连接',400);
    store.delete('login',state);res.clearCookie('bridge_login',{path:'/feishu/callback',secure:true,httpOnly:true,sameSite:'lax'});
    if(typeof req.query.code!=='string') throw new BridgeError('INVALID_SESSION','授权未完成',400);
    const person=await feishu.login(req.query.code,flow.verifier);
    const ticket=random();
    store.put('login_result',ticket,{uid:flow.uid,sub:person.sub},60);
    // The provider's interaction cookie is scoped to /interaction/:uid, so finish there.
    res.redirect(`/interaction/${encodeURIComponent(flow.uid)}/finish?ticket=${ticket}`);
  }));
  app.get('/interaction/:uid/finish',asyncRoute(async(req,res)=>{
    const ticket=typeof req.query.ticket==='string'?req.query.ticket:'';
    const result=store.get<{uid:string;sub:string}>('login_result',ticket);
    if(!result||result.uid!==req.params.uid) throw new BridgeError('INVALID_SESSION','授权会话已过期',400);
    const interaction=await provider.interactionDetails(req,res);
    if(interaction.uid!==result.uid) throw new BridgeError('INVALID_SESSION','授权会话不匹配',400);
    store.delete('login_result',ticket);
    const person=feishu.person(result.sub);
    await provider.interactionFinished(req,res,{login:{accountId:person.sub,remember:false}},{mergeWithLastSubmission:false});
  }));
}
