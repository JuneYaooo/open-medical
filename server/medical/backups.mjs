import { readdirSync, lstatSync, realpathSync, unlinkSync, mkdirSync, mkdtempSync, rmSync, linkSync, openSync, closeSync, readSync, writeSync, fstatSync, constants } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { check } from "../errors.mjs";
import { backupDatabase } from "../../scripts/backup.mjs";

const MAX_KEEP = 14, DAY = 86400000;
// Both the desktop manager and the standalone backup script have produced these names.
const managedName = /^medical-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-(?:\d+Z?|[a-f0-9]{12}))?\.sqlite$/;
export class Backups {
  constructor(databasePath, { maxKeep = MAX_KEEP } = {}) {
    this.memory = databasePath === ':memory:';
    this.databasePath = this.memory ? null : resolve(databasePath);
    this.directory = this.memory ? null : join(dirname(this.databasePath), 'backups');
    this.maxKeep = maxKeep;
    this.autoTimer = null;
  }
  // Daily automatic backup: runs once at start when the newest backup is older
  // than a day, then checks again every interval. Never throws; timers are
  // unref'd so they never keep the process alive.
  startAuto({ intervalMs = DAY, checkMs = 60 * 60 * 1000, onError = () => {} } = {}) {
    if (this.memory || this.autoTimer) return false;
    const tick = () => {
      try {
        const latest = this.list()[0];
        if (!latest || Date.now() - latest.createdAt >= intervalMs) this.run();
      } catch (error) { try { onError(error); } catch { /* ignore */ } }
    };
    this.autoTimer = setInterval(tick, Math.min(checkMs, intervalMs));
    this.autoTimer.unref?.();
    this.autoStartTimer = setTimeout(tick, 0);
    this.autoStartTimer.unref?.();
    return true;
  }
  stopAuto() {
    clearInterval(this.autoTimer); clearTimeout(this.autoStartTimer);
    this.autoTimer = null; this.autoStartTimer = null;
  }
  directoryReady(create = false) {
    if (this.memory) return false;
    try {
      const stat = lstatSync(this.directory);
      check(stat.isDirectory() && !stat.isSymbolicLink(), 'BACKUP_DIRECTORY', '备份位置不是普通目录，请检查数据目录中的 backups。', 409);
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      mkdirSync(this.directory, { mode: 0o700 });
      return this.directoryReady();
    }
  }
  list() {
    if (!this.directoryReady()) return [];
    return readdirSync(this.directory).filter(name => managedName.test(name)).flatMap(name => {
      const path = join(this.directory, name), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return [];
      return [{ name, path, size: stat.size, createdAt: stat.mtimeMs, type: 'database', dev: stat.dev, ino: stat.ino }];
    }).sort((a,b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name, 'en', {numeric:true}));
  }
  status() {
    if (!this.memory) check(lstatSync(this.databasePath).isFile(), 'BACKUP_SOURCE', '数据库文件不可用，请检查数据位置。', 409);
    const items = this.list(), latest = items[0], age = latest ? Date.now() - latest.createdAt : null;
    return { supported: !this.memory, autoBackup: Boolean(this.autoTimer), databasePath: this.databasePath, databaseName: this.memory ? null : basename(this.databasePath), directory: this.directory, retention: this.maxKeep,
      count: items.length, lastBackupAt: latest ? new Date(latest.createdAt).toISOString() : null,
      fresh: age !== null && age < DAY, warning: this.memory || age === null || age >= DAY,
      items: items.map(({name,size,createdAt,type}) => ({name,size,createdAt,type})) };
  }
  run() {
    check(!this.memory, 'BACKUP_UNSUPPORTED', '当前实例使用内存数据库，不支持文件备份。', 409);
    this.status(); this.directoryReady(true);
    const staging = mkdtempSync(join(this.directory, '.creating-'));
    let createdName;
    try {
      const temporary = join(staging, 'snapshot.sqlite');
      backupDatabase(this.databasePath, temporary);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      for (;;) {
        createdName = `medical-${stamp}-${randomBytes(6).toString('hex')}.sqlite`;
        try { linkSync(temporary, join(this.directory, createdName)); break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
    } finally { rmSync(staging, {recursive:true,force:true}); }
    const failures = [];
    for (const old of this.list().filter(item => item.name !== createdName).slice(this.maxKeep - 1)) {
      try { this.resolveItem(old.name); unlinkSync(old.path); } catch { failures.push(old.name); }
    }
    return { ...this.status(), createdName, ...(failures.length ? {cleanupWarning:'备份已创建，但部分较早备份未能清理，请检查目录权限。'} : {}) };
  }
  resolveItem(name) {
    check(typeof name === 'string' && name === basename(name) && managedName.test(name), 'INVALID_BACKUP', '请选择清单中的数据库备份。');
    const item = this.list().find(item => item.name === name);
    check(item, 'BACKUP_MISSING', '此备份已失效或不是可检查的普通文件，请刷新清单。', 404);
    check(dirname(realpathSync(item.path)) === realpathSync(this.directory), 'INVALID_BACKUP', '备份文件位置已改变。', 409);
    return item;
  }
  verify(name) {
    const item = this.resolveItem(name);
    const fd = openSync(item.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let temporary, output, database;
    try {
      const actual = fstatSync(fd);
      check(actual.isFile() && actual.dev === item.dev && actual.ino === item.ino && actual.nlink === 1, 'BACKUP_CHANGED', '备份文件已变化，请刷新后重新检查。', 409);
      const header = Buffer.alloc(100); readSync(fd, header, 0, 100, 0);
      check(header.subarray(0,16).toString() === 'SQLite format 3\0' && header[18] === 1 && header[19] === 1, 'BACKUP_FORMAT', '文件不是独立 SQLite 快照，无法确认其完整性。');
      // Check a copy of the verified file descriptor: SQLite can never create
      // journal sidecars beside, migrate, or modify the original snapshot.
      temporary = mkdtempSync(join(tmpdir(), 'omw-backup-check-'));
      const copy = join(temporary, 'snapshot.sqlite'); output = openSync(copy, 'wx', 0o600);
      const buffer = Buffer.alloc(65536); let offset = 0, bytes;
      while ((bytes = readSync(fd, buffer, 0, buffer.length, offset)) > 0) { let written = 0; while (written < bytes) written += writeSync(output, buffer, written, bytes-written); offset += bytes; }
      closeSync(output); output = undefined;
      const after = fstatSync(fd);
      check(actual.size === after.size && actual.mtimeMs === after.mtimeMs && actual.ctimeMs === after.ctimeMs, 'BACKUP_CHANGED', '检查时备份发生变化，请重试。', 409);
      database = new DatabaseSync(copy, {readOnly:true});
      const result = database.prepare('PRAGMA quick_check').all();
      check(result.length === 1 && result[0].quick_check === 'ok', 'BACKUP_CORRUPT', '数据库检查未通过。');
      const schemaVersion = database.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
      check(['2','3','4','5','6','7','8'].includes(schemaVersion), 'BACKUP_VERSION', '此备份的数据库版本不受当前应用支持。');
      for (const table of ['patients','sessions']) {
        const columns = database.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name);
        check(['id','data'].every(column=>columns.includes(column)), 'BACKUP_STRUCTURE', '此文件缺少患者或任务数据结构。');
      }
      const current = this.resolveItem(name);
      check(current.dev === actual.dev && current.ino === actual.ino && current.size === actual.size && current.createdAt === actual.mtimeMs, 'BACKUP_CHANGED', '备份文件已变化，请重新检查。', 409);
      return { name, checkedAt: new Date().toISOString(), schemaVersion, valid: true, size: actual.size };
    } finally {
      database?.close(); if (output !== undefined) closeSync(output); closeSync(fd);
      if (temporary) rmSync(temporary, {recursive:true,force:true});
    }
  }
}
export function backupRoutes(backups) {
  check(backups, 'INVALID_INPUT', '备份管理未初始化');
  return {status:()=>backups.status(),run:()=>backups.run()};
}
