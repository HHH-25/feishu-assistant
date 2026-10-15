import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { config } from './config.js';
import { AppError } from './services/archive.js';

export interface ApiActor {
  operator: string;
  spaces: string[];
  can_run_summary: boolean;
  finance: boolean;
}

interface ApiCredential extends ApiActor {
  key: string;
}

function credentials(): ApiCredential[] {
  if (!config.apiActorsJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(config.apiActorsJson);
  } catch {
    throw new Error('API_ACTORS_JSON 必须是有效 JSON');
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) =>
    entry && typeof entry === 'object' &&
    typeof entry.key === 'string' && entry.key.length >= 24 &&
    typeof entry.operator === 'string' && entry.operator.length > 0 &&
    Array.isArray(entry.spaces) && entry.spaces.every((space: unknown) => typeof space === 'string') &&
    typeof entry.can_run_summary === 'boolean' && typeof entry.finance === 'boolean'
  )) {
    throw new Error('API_ACTORS_JSON 中每项需包含长度至少 24 的 key、operator、spaces、can_run_summary、finance');
  }
  return parsed as ApiCredential[];
}

const actorCredentials = credentials();

export function authenticate(req: Request): ApiActor {
  if (config.clientMode === 'mock') {
    return {
      operator: String(req.header('x-operator') ?? req.body?.operator ?? ''),
      spaces: ['*'],
      can_run_summary: true,
      finance: true,
    };
  }
  const match = /^Bearer (\S+)$/i.exec(req.header('authorization') ?? '');
  if (!match) throw new AppError('UNAUTHORIZED', '缺少 API 凭证', 401);
  const provided = createHash('sha256').update(match[1]).digest();
  const credential = actorCredentials.find((entry) =>
    timingSafeEqual(provided, createHash('sha256').update(entry.key).digest()),
  );
  if (!credential) throw new AppError('UNAUTHORIZED', 'API 凭证无效', 401);
  return credential;
}

export function authorizeSpace(actor: ApiActor, spaceId: string, confidentiality?: string): void {
  if (config.clientMode === 'mock') return;
  if (!actor.spaces.includes(spaceId) ||
      (spaceId === config.feishu.financeSpaceId || confidentiality === 'finance') && !actor.finance) {
    throw new AppError('FORBIDDEN_SPACE', '当前身份无权访问目标空间', 403);
  }
}

export function authorizeSummary(actor: ApiActor): void {
  if (!actor.can_run_summary) throw new AppError('FORBIDDEN', '当前身份无权触发日报汇总', 403);
}
