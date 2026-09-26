import test from 'node:test';
import assert from 'node:assert/strict';
import {selectSigningIdentity,verifyUpdateIdentity} from '../scripts/macos-signing.mjs';
const a='A'.repeat(40),b='B'.repeat(40);
const identity=`  1) ${a} "Developer ID Application: Example (TEAM)"`;
test('macOS evaluates inline update requirements instead of treating them as filenames',{skip:process.platform!=='darwin'},()=>{
 assert.deepEqual(verifyUpdateIdentity('/usr/bin/true','/usr/bin/true'),{migration:false});
 assert.throws(()=>verifyUpdateIdentity('/usr/bin/true','/usr/bin/false'));
});
test('release signing never silently falls back to hash-bound temporary identity',()=>{
 assert.throws(()=>selectSigningIdentity('0 valid identities found'),/没有可用/);
 assert.throws(()=>selectSigningIdentity('',{identity:'-'}),/临时签名/);
 assert.deepEqual(selectSigningIdentity('',{allowAdhoc:true}),{identity:'-',mode:'local-ad-hoc',stableIdentity:false});
 assert.equal(selectSigningIdentity(identity).identity,a);
 assert.throws(()=>selectSigningIdentity(identity,{identity:'missing',allowAdhoc:true}),/不存在/);
 const multiple=identity+`\n2) ${b} "Developer ID Application: Other (TEAM2)"`;
 assert.throws(()=>selectSigningIdentity(multiple),/不唯一/);
 assert.equal(selectSigningIdentity(multiple,{identity:b.toLowerCase()}).identity,b);
});

test('local signing preference pins the certificate and never regenerates identity during updates',async t=>{
 const {localSigningPreference}=await import('../scripts/macos-signing.mjs');
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createHash}=await import('node:crypto');
 const dir=await mkdtemp(join(tmpdir(),'medical-signing-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'local.json'),certificate=join(dir,'cert.cer');
 assert.equal(localSigningPreference(path),null);const bytes=Buffer.from('synthetic certificate');await writeFile(certificate,bytes);
 const config={scope:'local-only',identity:createHash('sha1').update(bytes).digest('hex').toUpperCase(),keychain:'/synthetic/login.keychain-db',certificate};
 await writeFile(path,JSON.stringify(config));assert.deepEqual(localSigningPreference(path),config);
 await writeFile(certificate,'changed');assert.throws(()=>localSigningPreference(path),/指纹/);
});
