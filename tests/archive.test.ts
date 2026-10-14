import { describe, expect, it, beforeEach } from 'vitest';
import { MockFeishuClient } from '../src/clients/feishu.js';
import { ArchiveService, assertSpaceAccess, sha256, AppError } from '../src/services/archive.js';
import { MAX_FILE_BYTES } from '../src/config.js';

describe('文件归档闭环（T1–T4）', () => {
  let feishu: MockFeishuClient;
  let service: ArchiveService;

  beforeEach(() => {
    feishu = new MockFeishuClient();
    service = new ArchiveService(feishu);
  });

  it('T1 上传成功：校验类型/大小后写台账全字段', async () => {
    const buffer = Buffer.from('hello sales doc');
    const result = await service.archive(
      {
        fileName: 'sales.txt',
        buffer,
        department: '销售',
        confidentiality: 'dept',
        spaceId: 'space_sales',
        operator: 'user:alice',
        owner: 'user:alice',
        source: 'api',
      },
      'req-t1',
    );
    expect(result.status).toBe('success');
    expect(result.deduplicated).toBe(false);
    expect(result.version).toBe(1);
    expect(result.content_hash).toBe(sha256(buffer));
    expect(result.feishu_url).toContain('mock.feishu.local');
    expect(result.file_type).toBe('txt');
    expect(result.department).toBe('销售');
    expect(result.confidentiality).toBe('dept');
    expect(result.space_id).toBe('space_sales');
    expect(result.uploader).toBe('user:alice');
    expect(result.owner).toBe('user:alice');
    expect(result.source).toBe('api');
    expect(result.archive_key).toBe(`hash:${result.content_hash}|space:space_sales`);
    expect(result.file_id).toBeTruthy();
    expect(result.uploaded_at).toBeTruthy();

    const saved = await service.getStatus(result.archive_id);
    expect(saved.file_id).toBe(result.file_id);
    expect(saved.status).toBe('success');
  });

  it('T1b 非法类型与超限大小被拒绝', async () => {
    await expect(
      service.archive(
        {
          fileName: 'malware.exe',
          buffer: Buffer.from('x'),
          department: '销售',
          confidentiality: 'public',
          spaceId: 'space_public',
          operator: 'user:alice',
        },
        'req-t1b',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION', status: 400 });

    await expect(
      service.archive(
        {
          fileName: 'big.txt',
          buffer: Buffer.alloc(MAX_FILE_BYTES + 1, 1),
          department: '销售',
          confidentiality: 'public',
          spaceId: 'space_public',
          operator: 'user:alice',
        },
        'req-t1c',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION', status: 400 });
  });

  it('T2 普通用户访问财务空间被拒绝并记审计；财务身份可写', async () => {
    await expect(
      service.archive(
        {
          fileName: '预算.xlsx',
          buffer: Buffer.from('budget'),
          department: '财务',
          confidentiality: 'finance',
          spaceId: 'space_finance_test',
          operator: 'user:alice',
          fileType: 'xlsx',
        },
        'req-t2',
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_SPACE', status: 403 });

    const audits = await feishu.listAudits();
    expect(audits.some((a) => a.result === 'deny' && a.action === 'archive')).toBe(true);

    const ok = await service.archive(
      {
        fileName: '预算.xlsx',
        buffer: Buffer.from('budget-ok'),
        department: '财务',
        confidentiality: 'finance',
        spaceId: 'space_finance_test',
        operator: 'finance:cfo',
        fileType: 'xlsx',
      },
      'req-t2b',
    );
    expect(ok.status).toBe('success');
  });

  it('T3 同哈希去重：不新建飞书文件，原台账仍为 success', async () => {
    const buffer = Buffer.from('same-bytes');
    const first = await service.archive(
      {
        fileName: 'a.txt',
        buffer,
        department: '销售',
        confidentiality: 'public',
        spaceId: 'space_public',
        operator: 'user:alice',
      },
      'req-t3a',
    );
    const second = await service.archive(
      {
        fileName: 'a-copy.txt',
        buffer,
        department: '销售',
        confidentiality: 'public',
        spaceId: 'space_public',
        operator: 'user:bob',
      },
      'req-t3b',
    );
    expect(second.deduplicated).toBe(true);
    expect(second.status).toBe('duplicate');
    expect(second.file_id).toBe(first.file_id);
    expect(second.archive_id).toBe(first.archive_id);

    const kept = await service.getStatus(first.archive_id);
    expect(kept.status).toBe('success');
    expect(kept.content_hash).toBe(sha256(buffer));
  });

  it('T4 同名内容变化生成可追踪新版本', async () => {
    const v1 = await service.archive(
      {
        fileName: '流程.docx',
        buffer: Buffer.from('version-1'),
        department: '销售',
        confidentiality: 'dept',
        spaceId: 'space_sales',
        operator: 'user:alice',
        fileType: 'docx',
      },
      'req-t4a',
    );
    const v2 = await service.archive(
      {
        fileName: '流程.docx',
        buffer: Buffer.from('version-2-changed'),
        department: '销售',
        confidentiality: 'dept',
        spaceId: 'space_sales',
        operator: 'user:alice',
        fileType: 'docx',
      },
      'req-t4b',
    );
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v2.previous_file_id).toBe(v1.file_id);
    expect(v2.file_id).not.toBe(v1.file_id);
    expect(v2.content_hash).not.toBe(v1.content_hash);
  });

  it('assertSpaceAccess 单元规则', () => {
    expect(() => assertSpaceAccess('user:x', 'space_finance_test', 'public')).toThrow(AppError);
    expect(() => assertSpaceAccess('finance:x', 'space_finance_test', 'finance')).not.toThrow();
  });
});
