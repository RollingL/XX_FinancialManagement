import React,{useEffect,useRef,useState} from 'react';
import {recognizeScreenshot} from './ocr.ts';
import type {OcrResult} from './ocr.ts';
import {ledgerCommand} from './ledger.ts';
import {decimal} from './model.ts';
type Fields={amount:string;date:string;merchant:string};
export default function ExpenseScreenshot({onFile,onFields,onBusy,disabled}:{onFile:(file:File|null)=>void;onFields:(fields:Fields)=>void;onBusy:(value:boolean)=>void;disabled:boolean}){
 const [preview,setPreview]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[result,setResult]=useState<OcrResult|null>(null),[zoom,setZoom]=useState(false);
 const controller=useRef<AbortController|null>(null),input=useRef<HTMLInputElement>(null);
 useEffect(()=>()=>controller.current?.abort(),[]);
 useEffect(()=>()=>{if(preview)URL.revokeObjectURL(preview);},[preview]);
 function cancel(){controller.current?.abort();controller.current=null;setBusy(false);onBusy(false);setMessage('已停止识别，可对照截图手动填写。');}
 function clear(){cancel();onFile(null);onFields({amount:'',date:'',merchant:''});setPreview('');setResult(null);setMessage('');if(input.current)input.current.value='';}
 async function upload(file?:File){
  if(!file)return;controller.current?.abort();onFile(null);onFields({amount:'',date:'',merchant:''});setResult(null);setPreview('');
  if(!['image/png','image/jpeg'].includes(file.type)||file.size===0||file.size>20*1024*1024){setMessage('请选择不超过 20 MiB 的 PNG 或 JPEG 图片');return;}
  const request=new AbortController();controller.current=request;setPreview(URL.createObjectURL(file));onFile(file);setBusy(true);onBusy(true);setMessage('正在本机识别… 首次加载可能需要一些时间。');
  try{
   const found=await recognizeScreenshot(file,request.signal);if(controller.current!==request||request.signal.aborted)return;
   setResult(found);const fields=found.expense_fields;
   onFields({amount:fields?.amount_cents?decimal(fields.amount_cents):'',date:fields?.date||'',merchant:fields?.merchant||''});
   setMessage('已填写能够确定的字段，请对照原图核对；留空项请手动补充。保存时才会登记费用并保留截图。');
  }catch(e){if(controller.current===request&&!request.signal.aborted)setMessage(`${(e as Error).message}。可以对照截图手动填写。`);}
  finally{if(controller.current===request){controller.current=null;setBusy(false);onBusy(false);}}
 }
 return <section className="expense-screenshot" aria-label="支付截图"><label className="field">上传支付截图（可选）<input ref={input} type="file" accept="image/png,image/jpeg" disabled={disabled||busy} onChange={e=>void upload(e.target.files?.[0])}/></label><p className="help">本机离线识别金额、日期和商户，可手动修正。支持 PNG / JPEG，最大 20 MiB。</p>{message&&<p role="status" className="help">{message}</p>}{preview&&<><div className="screenshot-actions">{busy?<button type="button" onClick={cancel}>停止识别，手动填写</button>:<button type="button" disabled={disabled} onClick={clear}>移除截图并清空识别字段</button>}<button type="button" onClick={()=>setZoom(!zoom)}>{zoom?'适应宽度':'放大原图'}</button></div><div className={`receipt-preview ${zoom?'zoom':''}`}><img src={preview} alt="待保存费用的支付截图原图"/></div></>}{result&&<details><summary>查看识别参考信息</summary><p className="help">账户余额：{result.extraction.fields.account_balance===null?'未确定':decimal(result.extraction.fields.account_balance)+' 元'} · 退款金额：{result.extraction.fields.refund===null?'未确定':decimal(result.extraction.fields.refund)+' 元'}。这些金额不会填入支出，也不自动冲减支出。</p><pre className="ocr-raw">{result.texts.join('\n')}</pre></details>}</section>;
}
export function ExpenseAttachment({id}:{id:string}){
 const [url,setUrl]=useState(''),[error,setError]=useState(''),[zoom,setZoom]=useState(false);
 useEffect(()=>{let active=true,objectUrl='';setUrl('');setError('');
  ledgerCommand<{mime:string;base64:string}>({kind:'attachment',id}).then(data=>{
   if(!active)return;const bytes=Uint8Array.from(atob(data.base64),c=>c.charCodeAt(0));objectUrl=URL.createObjectURL(new Blob([bytes],{type:data.mime}));setUrl(objectUrl);
  }).catch(()=>{if(active)setError('附件读取失败，请保留现有数据并重试。');});
  return ()=>{active=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[id]);
 return <section aria-label="已保存的支付截图"><h3>支付截图附件</h3>{error?<p role="alert" className="error">{error}</p>:url?<><button type="button" onClick={()=>setZoom(!zoom)}>{zoom?'适应宽度':'放大原图'}</button><div className={`receipt-preview ${zoom?'zoom':''}`}><img src={url} alt="该笔费用已保留的支付截图"/></div></>:<p role="status">正在读取附件…</p>}</section>;
}
