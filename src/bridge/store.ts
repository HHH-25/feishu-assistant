import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export class BridgeStore {
  private db: DatabaseSync;
  private key: Buffer;
  constructor(path: string, keyPath?: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    if (keyPath) {
      mkdirSync(dirname(keyPath), { recursive: true });
      if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
      this.key = readFileSync(keyPath);
    } else this.key = randomBytes(32);
    if (this.key.length !== 32) throw new Error('授权加密密钥必须为 32 字节');
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS bridge_records (kind TEXT, id TEXT, payload TEXT NOT NULL,
        expires INTEGER NOT NULL, uid TEXT, grant_id TEXT, PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS bridge_uid ON bridge_records(kind,uid);
      CREATE INDEX IF NOT EXISTS bridge_grant ON bridge_records(grant_id);
      CREATE TABLE IF NOT EXISTS bridge_audit (at TEXT, actor TEXT, action TEXT, result TEXT);`);
  }
  private encrypt(value: unknown) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  private decrypt<T>(payload: string): T {
    const bytes = Buffer.from(payload, 'base64'), cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0,12));
    cipher.setAuthTag(bytes.subarray(12,28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString()) as T;
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT payload,expires FROM bridge_records WHERE kind=? AND id=?').get(kind,id) as
      { payload: string; expires: number } | undefined;
    if (!row) return undefined;
    if (row.expires && row.expires <= Date.now()) { this.delete(kind,id); return undefined; }
    return this.decrypt<T>(row.payload);
  }
  put(kind: string, id: string, value: unknown, seconds = 0, uid?: string, grant?: string) {
    this.db.prepare('INSERT OR REPLACE INTO bridge_records VALUES (?,?,?,?,?,?)')
      .run(kind,id,this.encrypt(value),seconds ? Date.now()+seconds*1000 : 0,uid || null,grant || null);
  }
  reserve(kind: string, id: string, value: unknown): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO bridge_records(kind,id,payload,expires) VALUES (?,?,?,0)')
      .run(kind,id,this.encrypt(value)).changes === 1;
  }
  delete(kind: string, id: string) { this.db.prepare('DELETE FROM bridge_records WHERE kind=? AND id=?').run(kind,id); }
  find<T>(kind: string, column: 'uid' | 'grant_id', value: string): T | undefined {
    const row = this.db.prepare(`SELECT id FROM bridge_records WHERE kind=? AND ${column}=?`).get(kind,value) as {id: string}|undefined;
    return row ? this.get<T>(kind,row.id) : undefined;
  }
  revokeGrant(id: string) { this.db.prepare('DELETE FROM bridge_records WHERE grant_id=? OR (kind=? AND id=?)').run(id,'Grant',id); }
  audit(actor: string, action: string, result: string) {
    this.db.prepare('INSERT INTO bridge_audit VALUES (?,?,?,?)').run(new Date().toISOString(),actor,action,result);
  }
  close() { this.db.close(); }
}
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
