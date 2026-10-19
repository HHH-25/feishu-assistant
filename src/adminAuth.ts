import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { ApiActor } from './auth.js';
import { config } from './config.js';
import { AppError } from './services/archive.js';

interface WebActor extends ApiActor { open_id: string }
interface FeishuEnvelope { code: number; data?: Record<string, unknown> }

function webActors(): WebActor[] {
  let parsed: unknown;
  try { parsed = JSON.parse(config.adminWebActorsJson); }
  catch { throw new Error('ADMIN_WEB_ACTORS_JSON 必须是有效 JSON'); }
  if (!Array.isArray(parsed) || !parsed.every((item) =>
    item && typeof item === 'object' &&
    typeof item.open_id === 'string' && /^ou_[A-Za-z0-9_-]+$/.test(item.open_id) &&
    typeof item.operator === 'string' && item.operator.length > 0 &&
    Array.isArray(item.spaces) && item.spaces.every((space: unknown) => typeof space === 'string') &&
    item.can_run_summary === true && typeof item.finance === 'boolean')) {
    throw new Error('ADMIN_WEB_ACTORS_JSON 只接受包含 open_id、operator、spaces、finance 的管理者');
  }
  const actors = parsed as WebActor[];
  if (new Set(actors.map((actor) => actor.open_id)).size !== actors.length) {
    throw new Error('ADMIN_WEB_ACTORS_JSON 中 open_id 不得重复');
  }
  return actors;
}

export class AdminWebAuth {
  private actors: WebActor[];
  private appToken: { value: string; expiresAt: number } | null = null;

  constructor(private fetcher: typeof fetch = fetch) {
    if (!config.feishu.appId || !config.feishu.appSecret) throw new Error('管理员网页需要飞书应用凭证');
    if (config.adminWebSessionSecret.length < 32) throw new Error('ADMIN_WEB_SESSION_SECRET 至少 32 字符');
    this.actors = webActors();
  }

  private sign(input: string): string {
    return createHmac('sha256', config.adminWebSessionSecret).update(input).digest('base64url');
  }

  private async post(path: string, body: unknown, authorization?: string): Promise<FeishuEnvelope & Record<string, unknown>> {
    const response = await this.fetcher(`${config.feishu.baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json().catch(() => ({})) as FeishuEnvelope & Record<string, unknown>;
    if (!response.ok || result.code !== 0) throw new AppError('UPSTREAM', '飞书登录验证失败', 502);
    return result;
  }

  private async appAccessToken(): Promise<string> {
    if (this.appToken && Date.now() < this.appToken.expiresAt) return this.appToken.value;
    const result = await this.post('/auth/v3/app_access_token/internal', {
      app_id: config.feishu.appId, app_secret: config.feishu.appSecret,
    });
    if (typeof result.app_access_token !== 'string') throw new AppError('UPSTREAM', '飞书登录凭证响应无效', 502);
    this.appToken = { value: result.app_access_token,
      expiresAt: Date.now() + Math.max(0, Number(result.expire ?? 7200) - 120) * 1000 };
    return this.appToken.value;
  }

  async exchangeCode(code: string): Promise<WebActor> {
    if (!code || code.length > 2048) throw new AppError('VALIDATION', '飞书登录码无效', 400);
    const token = await this.post('/authen/v1/access_token', {
      grant_type: 'authorization_code', code,
    }, await this.appAccessToken());
    const userToken = token.data?.access_token;
    if (typeof userToken !== 'string') throw new AppError('UPSTREAM', '飞书用户凭证响应无效', 502);
    const response = await this.fetcher(`${config.feishu.baseUrl.replace(/\/$/, '')}/authen/v1/user_info`, {
      headers: { authorization: `Bearer ${userToken}` }, signal: AbortSignal.timeout(15_000),
    });
    const user = await response.json().catch(() => ({})) as FeishuEnvelope;
    if (!response.ok || user.code !== 0 || typeof user.data?.open_id !== 'string') {
      throw new AppError('UPSTREAM', '飞书用户身份验证失败', 502);
    }
    const actor = this.actors.find((entry) => entry.open_id === user.data?.open_id);
    if (!actor) throw new AppError('FORBIDDEN', '此飞书账号未获管理入口授权', 403);
    return actor;
  }

  createSession(actor: WebActor): { cookie: string; csrf: string } {
    const payload = Buffer.from(JSON.stringify({ open_id: actor.open_id,
      expires_at: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url');
    const cookie = `${payload}.${this.sign(payload)}`;
    return { cookie, csrf: this.sign(`csrf:${cookie}`) };
  }

  session(req: Request): { actor: WebActor; csrf: string } {
    const cookie = req.headers.cookie?.split(';').map((part) => part.trim())
      .find((part) => part.startsWith('mvp_admin='))?.slice('mvp_admin='.length);
    if (!cookie) throw new AppError('UNAUTHORIZED', '请在飞书中登录管理入口', 401);
    const [payload, signature, extra] = cookie.split('.');
    if (!payload || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(signature)) {
      throw new AppError('UNAUTHORIZED', '管理登录态无效', 401);
    }
    const expected = this.sign(payload);
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
      throw new AppError('UNAUTHORIZED', '管理登录态无效', 401);
    }
    let value: { open_id?: string; expires_at?: number };
    try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
    catch { throw new AppError('UNAUTHORIZED', '管理登录态无效', 401); }
    if (typeof value.expires_at !== 'number' || Date.now() >= value.expires_at) {
      throw new AppError('UNAUTHORIZED', '管理登录态已过期', 401);
    }
    const actor = this.actors.find((entry) => entry.open_id === value.open_id);
    if (!actor) throw new AppError('FORBIDDEN', '此飞书账号未获管理入口授权', 403);
    return { actor, csrf: this.sign(`csrf:${cookie}`) };
  }
}
