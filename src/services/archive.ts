import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { ALLOWED_EXTENSIONS, config, MAX_FILE_BYTES } from '../config.js';
import type { FeishuClient } from '../clients/feishu.js';
import { logger } from '../logger.js';
import type { ArchiveInput, ArchiveRecord, Confidentiality } from '../types.js';

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

const CONFIDENTIALITIES = new Set<Confidentiality>(['public', 'dept', 'mgmt', 'finance']);

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function inferFileType(fileName: string, explicit?: string): string {
  if (explicit) return explicit.replace(/^\./, '').toLowerCase();
  const ext = path.extname(fileName).toLowerCase();
  return ext.replace(/^\./, '') || 'bin';
}

function assertAllowedFile(fileName: string, size: number) {
  const ext = path.extname(fileName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new AppError('VALIDATION', `不支持的文件类型：${ext || '(无扩展名)'}，仅支持 PDF/DOCX/XLSX/TXT`, 400);
  }
  if (size <= 0) throw new AppError('VALIDATION', '文件为空', 400);
  if (size > MAX_FILE_BYTES) {
    throw new AppError('VALIDATION', `文件超过上限 ${MAX_FILE_BYTES} 字节`, 400);
  }
}

/** 业务层权限：财务空间不可被普通用户写入（不因 API 成功而放行） */
export function assertSpaceAccess(operator: string, spaceId: string, confidentiality: Confidentiality, financeAuthorized?: boolean) {
  const financeSpace = config.feishu.financeSpaceId;
  const isFinanceTarget = spaceId === financeSpace || confidentiality === 'finance';
  const elevated = financeAuthorized ?? (
    operator.startsWith('finance:') ||
    operator.startsWith('boss:') ||
    operator.includes('财务') ||
    operator.includes('老板'));

  if (isFinanceTarget && !elevated) {
    throw new AppError('FORBIDDEN_SPACE', '普通用户无权访问财务测试空间', 403);
  }
}

export class ArchiveService {
  constructor(private feishu: FeishuClient) {}

  async archive(input: ArchiveInput, requestId: string): Promise<ArchiveRecord & { deduplicated: boolean }> {
    const started = Date.now();
    assertAllowedFile(input.fileName, input.buffer.length);

    if (!CONFIDENTIALITIES.has(input.confidentiality)) {
      throw new AppError('VALIDATION', 'confidentiality 无效', 400);
    }
    if (!input.department?.trim()) throw new AppError('VALIDATION', 'department 必填', 400);
    if (!input.spaceId?.trim()) throw new AppError('VALIDATION', 'space_id 必填', 400);
    if (!input.operator?.trim()) throw new AppError('VALIDATION', 'operator 必填', 400);

    try {
      assertSpaceAccess(input.operator, input.spaceId, input.confidentiality, input.financeAuthorized);
    } catch (err) {
      if (err instanceof AppError && err.code === 'FORBIDDEN_SPACE') {
        await this.feishu.writeAudit({
          id: randomUUID(),
          request_id: requestId,
          operator: input.operator,
          action: 'archive',
          resource: input.spaceId,
          result: 'deny',
          detail: err.message,
          at: new Date().toISOString(),
        });
      }
      throw err;
    }

    const contentHash = sha256(input.buffer);
    const fileType = inferFileType(input.fileName, input.fileType);
    const now = new Date().toISOString();

    // 同空间同哈希 → 去重：保留原台账 success，响应标记 duplicate，不新建飞书文件
    const existing = await this.feishu.findLedgerByHash(contentHash, input.spaceId);
    if (existing && (existing.status === 'success' || existing.status === 'duplicate')) {
      await this.feishu.writeAudit({
        id: randomUUID(),
        request_id: requestId,
        operator: input.operator,
        action: 'archive_dedup',
        resource: existing.archive_id,
        result: 'success',
        detail: `hash=${contentHash};keep_status=${existing.status}`,
        at: now,
      });
      logger.info('归档去重命中', {
        request_id: requestId,
        operator: input.operator,
        resource: existing.archive_id,
        duration_ms: Date.now() - started,
        status: 'duplicate',
      });
      return {
        ...existing,
        status: 'duplicate',
        updated_at: now,
        deduplicated: true,
      };
    }

    // 同名同部门同空间但哈希不同 → 新版本
    const prev = await this.feishu.findLatestByName({
      fileName: input.fileName,
      department: input.department,
      spaceId: input.spaceId,
    });
    const version = prev ? prev.version + 1 : 1;

    const uploaded = await this.feishu.uploadFile({
      fileName: input.fileName,
      buffer: input.buffer,
    });

    const archiveId = randomUUID();
    const record: ArchiveRecord = {
      archive_id: archiveId,
      file_name: input.fileName,
      file_id: uploaded.file_id,
      feishu_url: uploaded.feishu_url,
      content_hash: contentHash,
      department: input.department,
      file_type: fileType,
      confidentiality: input.confidentiality,
      uploader: input.operator,
      source: input.source ?? 'api',
      uploaded_at: now,
      status: 'success',
      owner: input.owner ?? input.operator,
      version,
      previous_file_id: prev?.file_id,
      space_id: input.spaceId,
      archive_key: `hash:${contentHash}|space:${input.spaceId}`,
      updated_at: now,
    };

    await this.feishu.writeLedger(record);
    await this.feishu.writeAudit({
      id: randomUUID(),
      request_id: requestId,
      operator: input.operator,
      action: 'archive',
      resource: archiveId,
      result: 'success',
      detail: `file_id=${uploaded.file_id};version=${version}`,
      at: now,
    });

    logger.info('归档成功', {
      request_id: requestId,
      operator: input.operator,
      resource: archiveId,
      duration_ms: Date.now() - started,
      status: 'success',
      version,
    });

    return { ...record, deduplicated: false };
  }

  async getStatus(archiveId: string): Promise<ArchiveRecord> {
    const record = await this.feishu.getLedger(archiveId);
    if (!record) throw new AppError('NOT_FOUND', `归档不存在：${archiveId}`, 404);
    return record;
  }
}
