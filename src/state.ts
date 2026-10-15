import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const runtimeRequire = createRequire(import.meta.url);

export type SendState = 'ready' | 'sending' | 'sent' | 'uncertain';
export type UploadState = 'uploading' | 'uploaded' | 'committed' | 'uncertain';
export interface SendReceipt { state: SendState; message_id?: string }
export interface UploadReceipt { state: UploadState; file_id?: string; feishu_url?: string }

/** SQLite 只保存幂等锁和恢复回执；飞书多维表仍是正式业务台账。 */
export class StateStore {
  private db: DatabaseSync;

  constructor(path = config.stateDbPath) {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    const SqliteDatabase = (runtimeRequire('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
    this.db = new SqliteDatabase(absolute, { timeout: 5000 });
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS locks (key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sends (business_date TEXT PRIMARY KEY, state TEXT NOT NULL, message_id TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads (archive_key TEXT PRIMARY KEY, state TEXT NOT NULL, file_id TEXT, feishu_url TEXT, updated_at TEXT NOT NULL);
    `);
  }

  close(): void { this.db.close(); }

  acquire(key: string, ttlMs = 600_000): string | null {
    const owner = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT expires_at FROM locks WHERE key = ?').get(key) as
        { expires_at: number } | undefined;
      if (current && current.expires_at > Date.now()) {
        this.db.exec('ROLLBACK');
        return null;
      }
      this.db.prepare('INSERT OR REPLACE INTO locks(key, owner, expires_at) VALUES (?, ?, ?)')
        .run(key, owner, Date.now() + ttlMs);
      this.db.exec('COMMIT');
      return owner;
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  release(key: string, owner: string): void {
    this.db.prepare('DELETE FROM locks WHERE key = ? AND owner = ?').run(key, owner);
  }

  getSend(date: string): SendReceipt | null {
    const row = this.db.prepare('SELECT state, message_id FROM sends WHERE business_date = ?').get(date) as
      { state: SendState; message_id: string | null } | undefined;
    return row ? { state: row.state, message_id: row.message_id ?? undefined } : null;
  }

  beginSend(date: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.getSend(date);
      if (row && row.state !== 'ready') {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.prepare('INSERT OR REPLACE INTO sends(business_date, state, message_id, updated_at) VALUES (?, ?, NULL, ?)')
        .run(date, 'sending', new Date().toISOString());
      this.db.exec('COMMIT');
      return true;
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  markSent(date: string, messageId: string): void {
    this.db.prepare('UPDATE sends SET state = ?, message_id = ?, updated_at = ? WHERE business_date = ?')
      .run('sent', messageId, new Date().toISOString(), date);
  }

  markSendUncertain(date: string): void {
    this.db.prepare('UPDATE sends SET state = ?, updated_at = ? WHERE business_date = ? AND state = ?')
      .run('uncertain', new Date().toISOString(), date, 'sending');
  }

  reconcileSend(date: string, deliveredMessageId?: string): void {
    const state = deliveredMessageId ? 'sent' : 'ready';
    this.db.prepare('INSERT OR REPLACE INTO sends(business_date, state, message_id, updated_at) VALUES (?, ?, ?, ?)')
      .run(date, state, deliveredMessageId ?? null, new Date().toISOString());
  }

  getUpload(key: string): UploadReceipt | null {
    const row = this.db.prepare('SELECT state, file_id, feishu_url FROM uploads WHERE archive_key = ?').get(key) as
      { state: UploadState; file_id: string | null; feishu_url: string | null } | undefined;
    return row ? { state: row.state, file_id: row.file_id ?? undefined,
      feishu_url: row.feishu_url ?? undefined } : null;
  }

  beginUpload(key: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.getUpload(key);
      if (row) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.prepare('INSERT OR REPLACE INTO uploads(archive_key, state, file_id, feishu_url, updated_at) VALUES (?, ?, NULL, NULL, ?)')
        .run(key, 'uploading', new Date().toISOString());
      this.db.exec('COMMIT');
      return true;
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  recordUpload(key: string, fileId: string, url: string): void {
    this.db.prepare('UPDATE uploads SET state = ?, file_id = ?, feishu_url = ?, updated_at = ? WHERE archive_key = ?')
      .run('uploaded', fileId, url, new Date().toISOString(), key);
  }

  markUploadCommitted(key: string): void {
    this.db.prepare('UPDATE uploads SET state = ?, updated_at = ? WHERE archive_key = ?')
      .run('committed', new Date().toISOString(), key);
  }

  markUploadUncertain(key: string): void {
    this.db.prepare('UPDATE uploads SET state = ?, updated_at = ? WHERE archive_key = ? AND state = ?')
      .run('uncertain', new Date().toISOString(), key, 'uploading');
  }

  reconcileUpload(key: string, fileId?: string, url?: string): void {
    if (fileId && url) {
      this.db.prepare('INSERT OR REPLACE INTO uploads(archive_key, state, file_id, feishu_url, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(key, 'uploaded', fileId, url, new Date().toISOString());
    } else {
      this.db.prepare('DELETE FROM uploads WHERE archive_key = ?').run(key);
    }
  }
}
