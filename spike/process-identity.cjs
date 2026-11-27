// Local, read-only process queries. Signal 0 only checks existence; this module never terminates a process.
const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const output=(file,args,extra={})=>execFileSync(file,args,{encoding:'utf8',timeout:4000,windowsHide:true,stdio:['ignore','pipe','ignore'],...extra}).trim();
function powershell(script,environment={}){
 const systemRoot=process.env.SystemRoot;
 if(!systemRoot||!path.win32.isAbsolute(systemRoot))throw Error('Windows system directory unavailable');
 return output(path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,...environment}});
}
let cachedHost;
function hostIdentity(){
 if(cachedHost!==undefined)return cachedHost;
 let machine;
 try{
  if(process.platform==='win32')machine=powershell("(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid");
  else if(process.platform==='darwin')machine=output('/usr/sbin/ioreg',['-rd1','-c','IOPlatformExpertDevice']).match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
  else if(process.platform==='linux')machine=fs.readFileSync('/etc/machine-id','utf8').trim();
 }catch{}
 // No hostname-only fallback: names can be duplicated and copied ledgers can come from other hosts.
 cachedHost=typeof machine==='string'&&/^[a-f\d-]{16,64}$/i.test(machine)?createHash('sha256').update(process.platform+':'+machine.toLowerCase()).digest('hex'):null;
 return cachedHost;
}
function existence(pid){
 if(!Number.isSafeInteger(pid)||pid<=0)return 'unknown';
 try{process.kill(pid,0);return 'alive';}catch(error){return error.code==='ESRCH'?'absent':'unknown';}
}
function processIdentity(pid){
 const state=existence(pid);if(state!=='alive')return {state};
 let startedAt=null;
 try{
  if(process.platform==='win32'){
   const value=powershell("$ErrorActionPreference='Stop'; $p=Get-Process -Id ([int]$env:QIANLAI_LOCK_PID); $p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)",{QIANLAI_LOCK_PID:String(pid)});
   if(/^\d{15,20}$/.test(value))startedAt='windows:'+value;
  }else if(process.platform==='linux'){
   const raw=fs.readFileSync(`/proc/${pid}/stat`,'utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).split(' '),boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
   if(/^[a-f\d-]{36}$/.test(boot)&&/^\d+$/.test(fields[19]||''))startedAt='linux:'+boot+':'+fields[19];
  }else if(process.platform==='darwin'){
   const value=output('/bin/ps',['-p',String(pid),'-o','lstart='],{env:{...process.env,TZ:'UTC',LC_ALL:'C'}});
   if(/^[A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(value))startedAt='darwin:'+value;
  }
 }catch{}
 // The process may have exited during the read. An unreadable live PID is never presumed stale.
 const latest=existence(pid);return latest==='alive'?{state:'alive',startedAt}:{state:latest};
}
function isLocalVolume(root){
 try{
  if(process.platform==='win32'){
   if(root.startsWith('\\\\')||!path.win32.isAbsolute(root))return false;
   const drive=powershell("$ErrorActionPreference='Stop'; $root=[IO.Path]::GetPathRoot($env:QIANLAI_LOCK_ROOT); ([IO.DriveInfo]::new($root)).DriveType.ToString()",{QIANLAI_LOCK_ROOT:root});
   return drive==='Fixed'||drive==='Removable';
  }
  const type=fs.statfsSync(root).type;
  return process.platform==='darwin'?type===26:process.platform==='linux'&&[0xef53,0x01021994].includes(type);
 }catch{return false;}
}
module.exports={hostIdentity,processIdentity,isLocalVolume};
