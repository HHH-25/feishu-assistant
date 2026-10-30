import { BridgeError } from './errors.js';
import { BridgeStore, digest } from './store.js';
import type { BridgeSettings } from './settings.js';

export interface Person { sub: string; openId: string; tenant: string; name: string }
interface Credentials { person: Person; access: string; refresh?: string; expires: number }
export interface FeishuApi { call(method: string, path: string, body?: unknown): Promise<Record<string, any>> }
const base = 'https://open.feishu.cn/open-apis';
export class FeishuAuth {
  private refreshes = new Map<string, Promise<Credentials>>();
  private botToken?: { value: string; expires: number };
  constructor(private settings: BridgeSettings, private store: BridgeStore, private fetcher: typeof fetch = fetch) {}
  allowed(person: Person) {
    return !!this.settings.tenant && !!person.openId && person.tenant === this.settings.tenant &&
      (this.settings.accessMode === 'tenant' || this.settings.users.includes(person.openId));
  }
  person(sub: string) {
    const value = this.store.get<Credentials>('feishu', sub);
    if (!value || !this.allowed(value.person)) throw new BridgeError('LOGIN_REQUIRED', '请重新连接飞书，或联系负责人核对企业和接入权限', 401);
    return value.person;
  }
  private async token(body: Record<string, string>) {
    const response = await this.fetcher(`${base}/authen/v2/oauth/token`, {
      method: 'POST', headers: {'content-type':'application/json'}, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ client_id:this.settings.appId, client_secret:this.settings.appSecret,...body }),
    });
    const value = await response.json() as Record<string, any>;
    if (!response.ok || value.code !== 0 || typeof value.access_token !== 'string' || !Number.isFinite(value.expires_in)) {
      throw new BridgeError('FEISHU_AUTH_FAILED', `飞书授权失败（code=${Number(value.code) || response.status}），请重新授权并核对应用权限`, 401);
    }
    return value;
  }
  async login(code: string, verifier: string): Promise<Person> {
    const value = await this.token({ grant_type:'authorization_code', code, code_verifier:verifier,
      redirect_uri:`${this.settings.publicUrl}/feishu/callback` });
    const response = await this.fetcher(`${base}/authen/v1/user_info`, {
      headers:{authorization:`Bearer ${value.access_token}`}, signal:AbortSignal.timeout(15_000),
    });
    const user = await response.json() as Record<string, any>;
    const info = user.data;
    if (!response.ok || user.code !== 0 || !info?.open_id || !info?.tenant_key) {
      throw new BridgeError('FEISHU_IDENTITY_FAILED', '无法核实飞书企业和员工身份',401);
    }
    const person: Person = { sub:digest([this.settings.appId,info.tenant_key,info.open_id]),
      tenant:info.tenant_key,openId:info.open_id,name:info.name || '飞书员工' };
    if (!this.allowed(person)) throw new BridgeError('FORBIDDEN', '当前企业或员工不在服务接入范围内',403);
    this.store.put('feishu',person.sub,{person,access:value.access_token,refresh:value.refresh_token,
      expires:Date.now()+value.expires_in*1000} satisfies Credentials);
    this.store.audit(person.sub,'feishu_login','success');
    return person;
  }
  private async credentials(sub: string): Promise<Credentials> {
    this.person(sub);
    const value = this.store.get<Credentials>('feishu',sub)!;
    if (value.expires > Date.now()+60_000) return value;
    if (!value.refresh) throw new BridgeError('LOGIN_REQUIRED','飞书授权已过期，请重新连接',401);
    const current = this.refreshes.get(sub); if (current) return current;
    // A refresh may finish after disconnect or a replacement login. Only the
    // exact credential snapshot that started it may be updated or removed.
    const stillCurrent = () => {
      const saved=this.store.get<Credentials>('feishu',sub);
      return !!saved && digest(saved)===digest(value);
    };
    const promise = (async () => {
      try {
        const next = await this.token({grant_type:'refresh_token',refresh_token:value.refresh!});
        if (!stillCurrent() || !this.allowed(value.person)) {
          throw new BridgeError('LOGIN_REQUIRED','授权在刷新期间发生变化，请重新连接飞书',401);
        }
        const updated = {...value,access:next.access_token,refresh:next.refresh_token || value.refresh,
          expires:Date.now()+next.expires_in*1000};
        this.store.put('feishu',sub,updated); return updated;
      } catch (error) {
        // Do not retry a rotating refresh token after an uncertain response.
        if(stillCurrent())this.store.delete('feishu',sub); throw error;
      } finally { this.refreshes.delete(sub); }
    })();
    this.refreshes.set(sub,promise); return promise;
  }
  async bot(): Promise<string> {
    if (this.botToken && this.botToken.expires > Date.now()) return this.botToken.value;
    const response = await this.fetcher(`${base}/auth/v3/tenant_access_token/internal`, {
      method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(15_000),
      body:JSON.stringify({app_id:this.settings.appId,app_secret:this.settings.appSecret}),
    });
    const data = await response.json() as Record<string, any>;
    if (!response.ok || data.code !== 0 || !data.tenant_access_token) throw new BridgeError('BOT_AUTH_FAILED','机器人授权失败',502);
    this.botToken = {value:data.tenant_access_token,expires:Date.now()+Math.max(0,data.expire-120)*1000};
    return this.botToken.value;
  }
  private async request(token: string, method: string, path: string, body?: unknown) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid API path');
    const response = await this.fetcher(`${base}${path}`, {method,signal:AbortSignal.timeout(25_000),
      headers:{authorization:`Bearer ${token}`,...(body instanceof FormData ? {} : {'content-type':'application/json'})},
      body:body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const data = await response.json() as Record<string, any>;
    if (!response.ok || data.code !== 0) {
      const code=Number(data.code)||0,rawLogId=response.headers.get('x-tt-logid');
      const logId=rawLogId&&/^[A-Za-z0-9_-]{1,128}$/.test(rawLogId)?`，request_id=${rawLogId}`:'';
      // Do not relay arbitrary upstream text: it can contain credentials or untrusted content.
      const wikiMove=method==='POST'&&/^\/wiki\/v2\/spaces\/[^/]+\/nodes\/move_docs_to_wiki$/.test(path);
      const reason=code===93101&&wikiMove?'；知识库移入被拒绝，请检查企业知识库权益及文档所有者权益是否过期，并核对资源权限。原文件已上传不等于归档成功，请保留回执，不要重新上传':
        code===93101?'；invalid operation，飞书拒绝此操作，原因尚未确认，请保留回执核查，不要重复写入':
        '；请核对本人权限及应用授权';
      throw new BridgeError('FEISHU_API_ERROR',`飞书拒绝或未完成此操作（HTTP ${response.status}，code=${code}${logId}）${reason}`,502);
    }
    return (data.data || {}) as Record<string, any>;
  }
  user(sub: string): FeishuApi {
    return {call:async (method,path,body) => this.request((await this.credentials(sub)).access,method,path,body)};
  }
  async identity(sub: string) {
    const person = this.person(sub);
    let organization: { status: 'verified'; name: string; source: 'feishu_tenant_api' } |
      { status: 'unavailable'; error: { code: string; message: string } };
    try {
      // This endpoint only supports tenant tokens. Keep this read fixed to enterprise
      // metadata; never use the application token as a fallback for user resources.
      const { tenant } = await this.request(await this.bot(), 'GET', '/tenant/v2/tenant/query');
      if (tenant?.tenant_key !== person.tenant) {
        throw new BridgeError('TENANT_MISMATCH', '企业信息与当前授权员工的企业不一致，未显示企业名称', 502);
      }
      if (typeof tenant.name !== 'string' || !tenant.name.trim()) {
        throw new BridgeError('BAD_TENANT_RESPONSE', '企业接口未返回有效企业名称', 502);
      }
      organization = { status: 'verified', name: tenant.name.trim(), source: 'feishu_tenant_api' };
    } catch (error) {
      organization = { status: 'unavailable', error: error instanceof BridgeError ? {
        code: error.code,
        message: error.message + (error.code === 'FEISHU_API_ERROR' ?
          '；企业信息查询使用应用身份，请检查获取企业信息（tenant:tenant:readonly）权限及应用版本发布状态' : ''),
      } : { code: 'TENANT_LOOKUP_FAILED', message: '企业信息查询暂时失败，请稍后重试；员工身份来自已授权会话' } };
    }
    // A disconnect or identity change while the remote call was pending must win.
    const current = this.person(sub);
    if (current.tenant !== person.tenant || current.openId !== person.openId) {
      throw new BridgeError('LOGIN_REQUIRED', '查询期间授权身份发生变化，请重新连接飞书', 401);
    }
    return { name: current.name, identity: 'feishu_user', identity_source: 'authorized_session',
      organization_scope: 'current_authorized_tenant', organization };
  }
  // The only other application-identity operation is explicit message writes.
  async sendAsBot(path: string, body: unknown) {
    if (!/^\/im\/v1\/messages(?:\?receive_id_type=(?:chat_id|open_id)|\/[A-Za-z0-9_-]+\/reply)$/.test(path)) {
      throw new Error('Bot API path denied');
    }
    return this.request(await this.bot(),'POST',path,body);
  }
  disconnect(sub: string) { this.store.delete('feishu',sub); }
}
