import React,{useState} from 'react';
import {cents,decimal,money} from './model.ts';
import {ledgerCommand} from './ledger.ts';
import type {LedgerState} from './ledger.ts';
import {ExpenseAttachment} from './ExpenseScreenshot.tsx';

export default function AdvanceEditor({state,id,onState,onClose,onBusy}:{state:LedgerState;id:number;onState:(next:LedgerState)=>void;onClose:()=>void;onBusy?:(busy:boolean)=>void}){
 const [original]=useState(()=>({amount:state.advances[id],details:structuredClone(state.advanceDetails?.[id]??null),revision:state.advanceEvents?.filter(event=>event.advanceId===id).length??0}));
 const [editing,setEditing]=useState(false),[deleting,setDeleting]=useState(false),[amount,setAmount]=useState(decimal(original.amount)),[date,setDate]=useState(original.details?.date??''),[note,setNote]=useState(original.details?.note??''),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const [attempts]=useState(new Map<string,{requestId:string;[key:string]:unknown}>());
 async function save(remove=false){
  if(saving)return;setError('');
  try{
   const payload={kind:remove?'delete-advance':'correct-advance',id,expectedAmount:original.amount,expected:original.details,expectedRevision:original.revision,...(!remove?{advance:{amount:cents(amount),date,note}}:{})};
   const key=JSON.stringify(payload),request=attempts.get(key)??{...payload,requestId:crypto.randomUUID()};attempts.set(key,request);setSaving(true);onBusy?.(true);
   const next=await ledgerCommand(request);onState(next);onBusy?.(false);onClose();
  }catch(error){setError(error instanceof Error?error.message:'保存失败，请重试');}finally{setSaving(false);onBusy?.(false);}
 }
 return <div><div className="drawer-body"><h3>YZ-{String(id+1).padStart(3,'0')} · ¥{money(original.amount)}</h3>
 {editing?<form id="advance-editor" onSubmit={event=>{event.preventDefault();void save();}}><fieldset className="expense-fields" disabled={saving}><label className="field">到账金额（元）<input required inputMode="decimal" value={amount} onChange={event=>setAmount(event.target.value)}/></label><label className="field">到账日期<input required type="date" value={date} onChange={event=>setDate(event.target.value)}/></label><label className="field">备注<textarea maxLength={500} value={note} onChange={event=>setNote(event.target.value)}/></label></fieldset><p className="help">修改用于纠正录入错误，保存后资金余额按新到账金额计算；原附件保留。</p></form>:<p className="help">到账日期 {original.details?.date??'未记录'} · {original.details?.note||'无备注'}</p>}
 {original.details?.attachmentId&&<ExpenseAttachment id={original.details.attachmentId} kind="advance"/>}
 {deleting&&<section role="alert" className="error"><p>确认删除这笔预支记录？资金余额将减少 ¥{money(original.amount)}；软件内不可恢复，原附件与删除审计保留。</p><button type="button" disabled={saving} onClick={()=>setDeleting(false)}>保留记录</button><button type="button" disabled={saving} onClick={()=>void save(true)}>确认删除预支</button></section>}
 {error&&<p role="alert" className="error">{error}。草稿已保留；结果不确定时保持内容重试，记录变化时关闭后重新核对。</p>}</div>
 <footer className="drawer-footer"><button type="button" disabled={saving} onClick={onClose}>返回记录</button>{editing?<button key="advance-save" className="primary" type="submit" form="advance-editor" disabled={saving}>{saving?'保存中…':'保存修改'}</button>:<button key="advance-edit" type="button" disabled={saving||deleting} onClick={()=>setEditing(true)}>编辑预支</button>}<button type="button" disabled={saving||deleting} onClick={()=>setDeleting(true)}>删除记录</button></footer></div>;
}
