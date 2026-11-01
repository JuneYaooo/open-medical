// One-click restore: pure file logic, kept out of main.cjs so it can be tested.
const {join,dirname,basename}=require('node:path');
const {lstatSync,realpathSync,existsSync,mkdirSync,copyFileSync,renameSync,rmSync,chmodSync}=require('node:fs');
// Same names server/medical/backups.mjs lists as managed backups.
const managedName=/^medical-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-(?:\d+Z?|[a-f0-9]{12}))?\.sqlite$/;
const SIDE=['','-wal','-shm'];
const pad=value=>String(value).padStart(2,'0');
const stamp=date=>`${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;

// Accept only a bare file name listed in the managed backups directory.
function resolveBackup(databasePath,name) {
  if(typeof name!=='string'||name!==basename(name)||!managedName.test(name))throw Error('请选择清单中的数据库备份');
  const directory=join(dirname(databasePath),'backups'),path=join(directory,name);
  const dir=lstatSync(directory);
  if(!dir.isDirectory()||dir.isSymbolicLink())throw Error('备份位置不是普通目录');
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink())throw Error('备份不是普通文件，请刷新清单');
  if(dirname(realpathSync(path))!==realpathSync(directory))throw Error('备份文件位置已改变');
  return path;
}

function sqliteIntegrity(path) {
  let DatabaseSync;
  try {({DatabaseSync}=require('node:sqlite'));} catch {return true;}
  const database=new DatabaseSync(path,{readOnly:true});
  try {const rows=database.prepare('PRAGMA integrity_check').all();return rows.length===1&&rows[0].integrity_check==='ok';}
  finally {database.close();}
}

// Call only after the runtime has closed the database. Saves the current
// database and sidecars, swaps in the backup, and rolls back if the check fails.
function restoreBackup({databasePath,name,now=new Date(),check=sqliteIntegrity}) {
  const source=resolveBackup(databasePath,name);
  const savedTo=join(dirname(databasePath),`restore-before-${stamp(now)}`);
  mkdirSync(savedTo,{mode:0o700});
  const current=basename(databasePath);
  for(const suffix of SIDE)if(existsSync(databasePath+suffix))copyFileSync(databasePath+suffix,join(savedTo,current+suffix));
  const temporary=`${databasePath}.restoring`;
  copyFileSync(source,temporary);chmodSync(temporary,0o600);
  for(const suffix of SIDE.slice(1))rmSync(databasePath+suffix,{force:true});
  renameSync(temporary,databasePath);
  let ok=false;
  try {ok=check(databasePath);} catch {ok=false;}
  if(!ok){
    for(const suffix of SIDE){
      rmSync(databasePath+suffix,{force:true});
      const saved=join(savedTo,current+suffix);if(existsSync(saved))copyFileSync(saved,databasePath+suffix);
    }
    throw Error(`备份完整性检查未通过，已保留原数据。原数据副本：${savedTo}`);
  }
  return {savedTo};
}
module.exports={resolveBackup,restoreBackup,sqliteIntegrity};
