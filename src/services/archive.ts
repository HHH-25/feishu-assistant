import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { ALLOWED_EXTENSIONS, config, MAX_FILE_BYTES } from '../config.js';
import type { FeishuClient } from '../clients/feishu.js';
import { logger } from '../logger.js';
import type { ArchiveInput, ArchiveRecord, Confidentiality } from '../types.js';
import type { StateStore } from '../state.js';

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
  const ext = path.extname(fileName).toLowerCase();
  if (explicit) {
    const declared = explicit.replace(/^\./, '').toLowerCase();
    if (declared !== ext.replace(/^\./, '')) {
      throw new AppError('VALIDATION', 'file_type 与文件扩展名不一致', 400);
    }
    return declared;
  }
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
  if ((confidentiality === 'finance') !== (spaceId === financeSpace)) {
    throw new AppError('VALIDATION', '财务密级文件必须归入财务空间，财务空间只接收财务密级文件', 400);
  }
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
  private inFlight = new Set<string>();
  constructor(private feishu: FeishuClient, private state?: StateStore) { }

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
    const archiveKey = `hash:${contentHash}|space:${input.spaceId}`;
    if (this.inFlight.has(archiveKey)) {
      throw new AppError('CONFLICT', '该文件正在归档，请稍后查询或重试', 409);
    }
    const lockOwner = this.state?.acquire(`archive:${archiveKey}`);
    if (this.state && !lockOwner) throw new AppError('CONFLICT', '该文件正在其他进程归档', 409);
    this.inFlight.add(archiveKey);
    try {
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
      const prev = existing ? null : await this.feishu.findLatestByName({
        fileName: input.fileName,
        department: input.department,
        spaceId: input.spaceId,
      });
      const version = existing?.version ?? (prev ? prev.version + 1 : 1);
      const archiveId = existing?.archive_id ?? randomUUID();
      const record: ArchiveRecord = existing ?? {
        archive_id: archiveId,
        file_name: input.fileName,
        file_id: '',
        feishu_url: '',
        content_hash: contentHash,
        department: input.department,
        file_type: fileType,
        confidentiality: input.confidentiality,
        uploader: input.operator,
        source: input.source ?? 'api',
        uploaded_at: now,
        status: 'pending',
        owner: input.owner ?? input.operator,
        version,
        previous_file_id: prev?.file_id,
        space_id: input.spaceId,
        archive_key: archiveKey,
        updated_at: now,
      };
      if (!existing) {
        try { await this.feishu.writeLedger(record); }
        catch {
          throw new AppError('UPSTREAM', '台账写入失败，文件尚未上传，请重试', 503);
        }
      }
      const receipt = this.state?.getUpload(archiveKey);
      if (!record.file_id && receipt && !receipt.file_id) {
        throw new AppError('UPLOAD_UNCERTAIN', `上传结果待核对，archive_id=${archiveId}`, 409);
      }
      try {
        if (!record.file_id) {
          const uploaded = receipt?.file_id && receipt.feishu_url
            ? { file_id: receipt.file_id, feishu_url: receipt.feishu_url }
            : await (async () => {
              if (this.state && !this.state.beginUpload(archiveKey)) {
                throw new AppError('UPLOAD_UNCERTAIN', `上传结果待核对，archive_id=${archiveId}`, 409);
              }
              try {
                const result = await this.feishu.uploadFile({
                  fileName: input.fileName, buffer: input.buffer, spaceId: input.spaceId,
                });
                this.state?.recordUpload(archiveKey, result.file_id, result.feishu_url);
                return result;
              } catch (err) {
                this.state?.markUploadUncertain(archiveKey);
                throw err;
              }
            })();
          record.file_id = uploaded.file_id;
          record.feishu_url = uploaded.feishu_url;
          record.updated_at = new Date().toISOString();
          // 上传结果先落台账；后续成功态写入失败时，重试可复用文件标识。
          await this.feishu.writeLedger(record);
        }
        record.status = 'success';
        record.error_message = undefined;
        record.updated_at = new Date().toISOString();
        await this.feishu.writeLedger(record);
        this.state?.markUploadCommitted(archiveKey);
      } catch (err) {
        record.status = 'failed';
        record.error_message = '归档未完成，请使用原文件重试';
        record.updated_at = new Date().toISOString();
        try { await this.feishu.writeLedger(record); } catch { /* 保留此前的 pending 记录 */ }
        logger.error('归档失败', {
          request_id: requestId, operator: input.operator, resource: archiveId, status: 'failed',
        });
        try {
          await this.feishu.writeAudit({
            id: randomUUID(), request_id: requestId, operator: input.operator,
            action: 'archive', resource: archiveId, result: 'failed',
            detail: '上传或台账写入失败', at: new Date().toISOString(),
          });
        } catch { /* 上游故障时不覆盖原始失败 */ }
        throw new AppError('UPSTREAM', `归档未完成，archive_id=${archiveId}，请重试`, 503);
      }
      await this.feishu.writeAudit({
        id: randomUUID(),
        request_id: requestId,
        operator: input.operator,
        action: 'archive',
        resource: archiveId,
        result: 'success',
        detail: `file_id=${record.file_id};version=${version}`,
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
    } finally {
      this.inFlight.delete(archiveKey);
      if (lockOwner) this.state?.release(`archive:${archiveKey}`, lockOwner);
    }
  }

  async getStatus(archiveId: string): Promise<ArchiveRecord> {
    const record = await this.feishu.getLedger(archiveId);
    if (!record) throw new AppError('NOT_FOUND', `归档不存在：${archiveId}`, 404);
    return record;
  }

  async list(): Promise<ArchiveRecord[]> {
    return this.feishu.listLedgers();
  }
}
