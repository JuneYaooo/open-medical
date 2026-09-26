import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';

export function selectSigningIdentity(output, { identity = '', allowAdhoc = false } = {}) {
  const identities = [...output.matchAll(/\b([A-Fa-f0-9]{40})\s+"([^"\n]+)"/g)].map(m=>({hash:m[1],name:m[2]}));
  if (identity === '-') {
    if (!allowAdhoc) throw new Error('临时签名会改变授权身份；仅本地测试时显式传入 --allow-adhoc');
    return { identity:'-', mode:'local-ad-hoc', stableIdentity:false };
  }
  const matches = identities.filter(i=>identity ? i.hash.toLowerCase()===identity.toLowerCase() || i.name===identity : i.name.startsWith('Developer ID Application:'));
  if (matches.length===1) return { identity:matches[0].hash, mode:'certificate', stableIdentity:true };
  if (identity || matches.length>1) throw new Error('签名证书不存在或不唯一，请用 --sign-identity 或 MEDICAL_MAC_SIGN_IDENTITY 指定 security find-identity 返回的证书 SHA-1');
  if (allowAdhoc) return {identity:'-',mode:'local-ad-hoc',stableIdentity:false};
  throw new Error('没有可用的 Developer ID Application 签名证书。请先导入证书及私钥；本地测试可显式使用 --allow-adhoc，但更新可能需要重新授权。');
}
export function localSigningPreference(path=join(homedir(),'.open-medical-workbench/signing/local-codesign.json')) {
  let raw;try {raw=readFileSync(path,'utf8');} catch(error) {if(error.code==='ENOENT')return null;throw error;}
  const value=JSON.parse(raw);
  if(value.scope!=='local-only' || !/^[A-F0-9]{40}$/.test(value.identity) || typeof value.keychain!=='string' || typeof value.certificate!=='string')throw new Error('本机签名配置无效，已停止构建');
  if(createHash('sha1').update(readFileSync(value.certificate)).digest('hex').toUpperCase()!==value.identity)throw new Error('本机签名证书指纹与配置不一致，已停止构建');
  return value;
}
export function signingConfiguration({identity=process.env.MEDICAL_MAC_SIGN_IDENTITY||'',allowAdhoc=false}={}) {
  const local=identity?null:localSigningPreference();
  if(local) {
    const certificate=new X509Certificate(readFileSync(local.certificate));
    if(Date.now()<Date.parse(certificate.validFrom) || Date.now()>Date.parse(certificate.validTo) || !certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.3'))throw new Error('本机证书不在有效期内或不允许代码签名');
    // A pinned local identity need not be a trusted CA. codesign verifies the
    // signature and the update requirement binds the exact certificate.
    const identities=execFileSync('/usr/bin/security',['find-identity','-p','codesigning',local.keychain],{encoding:'utf8'});
    if(!identities.toUpperCase().includes(local.identity))throw new Error('本机签名私钥不可用，已停止构建');
    return {identity:local.identity,mode:'local-certificate',stableIdentity:true,keychain:local.keychain};
  }
  return selectSigningIdentity(execFileSync('/usr/bin/security',['find-identity','-v','-p','codesigning'],{encoding:'utf8'}),{identity,allowAdhoc});
}
export function signMacApp(bundle, config, {deep=false}={}) {
  execFileSync('/usr/bin/codesign',['--force',...(deep?['--deep']:[]),'--sign',config.identity,...(config.keychain?['--keychain',config.keychain,'--timestamp=none']:[]),'--identifier','local.openmedical.workbench','--preserve-metadata=entitlements,flags,runtime',bundle],{stdio:'pipe'});
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{stdio:'pipe'});
}

export function verifyUpdateIdentity(previous, candidate) {
  const result=spawnSync('/usr/bin/codesign',['-d','-r-',previous],{encoding:'utf8'});
  const requirement=(result.stderr+'\n'+result.stdout).match(/designated => (.+)/)?.[1];
  if(result.status!==0 || !requirement)throw new Error('无法核验原安装包签名身份，更新已停止');
  if(/^cdhash /.test(requirement))return {migration:true};
  execFileSync('/usr/bin/codesign',['--verify','-R','='+requirement,candidate],{stdio:'pipe'});
  return {migration:false};
}
