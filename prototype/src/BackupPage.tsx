import React,{useEffect,useRef,useState} from 'react';
import {ledgerCommand} from './ledger.ts';
import './backup.css';

type MaintenanceInfo={supported:boolean;backupConfigured:boolean;canReset:boolean;generation?:string;pendingReset?:{requestId:string;fromGeneration:string}|null};
type Request={requestId:string;generation:string};
type BackupResult={directory:string;summary?:{expenseCount?:number;advanceCount?:number;batchCount?:number;attachmentFileCount?:number}};
type Activity='info'|'backup'|'reset'|null;
const CONFIRMATION='清空当前账本';
const message=(error:unknown)=>error instanceof Error?error.message:'本地操作失败，请检查状态后重试。';

export default function BackupPage({onResetComplete}:{onResetComplete:()=>void}){
 const [info,setInfo]=useState<MaintenanceInfo|null>(null),[busy,setBusy]=useState<Activity>('info'),[error,setError]=useState('');
 const [backup,setBackup]=useState<BackupResult|null>(null),[confirming,setConfirming]=useState(false),[confirmation,setConfirmation]=useState('');
 const lock=useRef(false),mounted=useRef(true),backupRequest=useRef<Request|null>(null),resetRequest=useRef<Request|null>(null);
 const confirmationInput=useRef<HTMLInputElement>(null),resetComplete=useRef(onResetComplete);
 resetComplete.current=onResetComplete;
 const pending=info?.pendingReset;
 const canBackup=!!(info?.supported&&info.backupConfigured&&info.generation&&!pending);
 const canReset=!!(info?.supported&&(pending||(info.canReset&&info.generation)));

 function begin(activity:Activity){if(lock.current)return false;lock.current=true;if(mounted.current)setBusy(activity);return true;}
 function finish(){lock.current=false;if(mounted.current)setBusy(null);}
 async function readInfo(){
  const next=await ledgerCommand<MaintenanceInfo>({kind:'maintenance-info'});
  if(!next||typeof next.supported!=='boolean'||typeof next.backupConfigured!=='boolean'||typeof next.canReset!=='boolean'
   ||(next.pendingReset&&(typeof next.pendingReset.requestId!=='string'||typeof next.pendingReset.fromGeneration!=='string')))
   throw Error('本地维护状态无效，请检查服务后重新读取。');
  if(mounted.current){
   setInfo(next);
   if(backupRequest.current&&backupRequest.current.generation!==next.generation)backupRequest.current=null;
   if(next.pendingReset){
    const request={requestId:next.pendingReset.requestId,generation:next.pendingReset.fromGeneration};
    if(resetRequest.current?.requestId!==request.requestId||resetRequest.current?.generation!==request.generation)setConfirmation('');
    resetRequest.current=request;setConfirming(true);
   }
  }
  return next;
 }
 async function refresh(){
  if(!begin('info'))return;
  if(mounted.current)setError('');
  try{await readInfo();}catch(e){if(mounted.current){setInfo(null);setError(message(e));}}finally{finish();}
 }
 useEffect(()=>{mounted.current=true;void refresh();return()=>{mounted.current=false;};},[]);
 useEffect(()=>{
  if(confirming&&!busy){confirmationInput.current?.focus();confirmationInput.current?.scrollIntoView({block:'nearest'});}
 },[confirming,busy]);

 async function exportBackup(){
  if(!canBackup||!info?.generation||!begin('backup'))return;
  setError('');
  const request=backupRequest.current??{requestId:crypto.randomUUID(),generation:info.generation};backupRequest.current=request;
  try{
   const result=await ledgerCommand<BackupResult>({kind:'create-backup',...request});
   if(!result||typeof result.directory!=='string'||!result.directory)throw Error('未收到完整备份的保存位置，请检查状态后重试。');
   backupRequest.current=null;if(mounted.current)setBackup(result);
  }catch(e){if(mounted.current)setError(message(e));}finally{finish();}
 }
 function openConfirmation(){
  if(lock.current||!canReset)return;
  resetRequest.current=pending?{requestId:pending.requestId,generation:pending.fromGeneration}:resetRequest.current??{requestId:crypto.randomUUID(),generation:info!.generation!};
  setConfirmation('');setConfirming(true);setError('');
 }
 function cancelConfirmation(){if(lock.current)return;setConfirmation('');setConfirming(false);setError('');if(!pending)resetRequest.current=null;}
 async function reset(event:React.FormEvent){
  event.preventDefault();
  if(confirmation!==CONFIRMATION||!canReset||!resetRequest.current||!begin('reset'))return;
  const request=resetRequest.current;setError('');
  try{
   const result=await ledgerCommand<{reset:boolean;completed:boolean;generation:string}>({kind:'reset-ledger',...request,confirmation});
   if(result?.reset!==true||result?.completed!==true)throw Error('本地服务尚未确认清空完成，请检查状态后重试。');
   resetRequest.current=null;backupRequest.current=null;
   if(mounted.current){setConfirmation('');setConfirming(false);setInfo(null);}
   resetComplete.current();
  }catch(e){
   const original=message(e);
   try{await readInfo();if(mounted.current)setError(`清空尚未确认完成：${original}`);}
   catch{if(mounted.current){setInfo(null);setError(`清空结果未能确认：${original} 请重新读取维护状态后重试。`);}}
  }finally{finish();}
 }

 return <div className="backup-page" aria-busy={!!busy}>
  <div className="backup-status-row"><p>备份保存在本机；清空操作仅作用于当前隔离试用账本。</p><button type="button" disabled={!!busy} onClick={()=>void refresh()}>{busy==='info'?'正在读取…':'重新读取维护状态'}</button></div>
  {!info&&!error&&<p className="backup-message" role="status">正在确认当前账本的维护状态…</p>}
  {info&&!info.supported&&<p className="backup-message" role="status">当前账本入口不支持这里的备份与清空。不会接管、迁移或改写原账本，请使用已配置的隔离试用入口。</p>}
  {error&&<p className="error" role="alert">{error}</p>}
  {pending&&<div className="backup-pending" role="alert"><h2>清空尚未完成</h2><p>上次清空尚未确认完成，仍需后续清理与核对。记账及备份已锁定，请继续完成清空。</p><p>重新输入确认文字后，将继续同一次操作。</p></div>}

  <section className="backup-card" aria-labelledby="backup-export-title">
   <div className="backup-card-heading"><h2 id="backup-export-title">完整备份</h2><span className="backup-badge">本机保存</span></div>
   <p>保存账本、受管附件及校验清单。清空前如需保留记录，请先导出一份完整备份。</p>
   <div className="backup-actions"><button type="button" className="primary" disabled={!!busy||!canBackup} onClick={()=>void exportBackup()}>{busy==='backup'?'正在导出…':'导出完整备份'}</button></div>
   {info?.supported&&!info.backupConfigured&&<p className="backup-help">尚未设置本机备份位置，请先完成本地配置。</p>}
   {backup&&<div className="backup-result" role="status"><h3>最近保存的完整备份</h3><p className="backup-location">{backup.directory}</p>{backup.summary&&<p className="backup-help">{[
    ['费用',backup.summary.expenseCount,'笔'],['预支',backup.summary.advanceCount,'笔'],['报销批次',backup.summary.batchCount,'批'],['附件',backup.summary.attachmentFileCount,'个'],
   ].filter(([,value])=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0).map(([label,value,unit])=>`${label} ${value} ${unit}`).join(' · ')}</p>}</div>}
   <p className="backup-help backup-restore-help">恢复到新目录尚使用本地维护命令。</p>
  </section>

  <section className="backup-card backup-danger" aria-labelledby="backup-reset-title">
   <div className="backup-card-heading"><h2 id="backup-reset-title">清空所有数据</h2><span className="backup-badge backup-danger-badge">不可撤销</span></div>
   <p>清空当前账本的全部费用、预支、报销批次及分配、受管附件和业务数据，资金余额全部归零。</p>
   <p className="backup-help">外部原图、另存备份、其他账本和软件保留。操作无法在软件内撤销。</p>
   {!confirming?<div className="backup-actions"><button type="button" disabled={!!busy||!canBackup} onClick={()=>void exportBackup()}>先导出完整备份</button><button type="button" className="backup-danger-button" disabled={!!busy||!canReset} onClick={openConfirmation}>{pending?'继续完成清空':'清空所有数据'}</button></div>:
    <form className="backup-confirmation" onSubmit={event=>void reset(event)}>
     <p id="reset-confirm-help">{pending?'继续完成已开始的清空操作。':'确认后将永久清空当前账本。'}请准确输入 <strong>{CONFIRMATION}</strong>。</p>
     <label className="field" htmlFor="reset-confirmation">确认文字<input id="reset-confirmation" ref={confirmationInput} value={confirmation} onChange={event=>setConfirmation(event.target.value)} disabled={!!busy} autoComplete="off" spellCheck={false} aria-describedby="reset-confirm-help" placeholder={CONFIRMATION}/></label>
     <div className="backup-actions"><button type="button" disabled={!!busy} onClick={cancelConfirmation}>{pending?'稍后处理':'取消'}</button><button type="submit" className="backup-danger-button" disabled={!!busy||!canReset||confirmation!==CONFIRMATION}>{busy==='reset'?'正在清空…':pending?'继续完成清空':'永久清空当前账本'}</button></div>
    </form>}
  </section>
 </div>;
}
