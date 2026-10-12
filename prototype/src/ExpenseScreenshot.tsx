import React,{useEffect,useRef,useState} from 'react';
import {recognizeScreenshot} from './ocr.ts';
import type {OcrResult} from './ocr.ts';
import {ledgerCommand} from './ledger.ts';
import {decimal} from './model.ts';
import {singleImage,validateImageFile} from './image-file.ts';
type Fields={amount:string;date:string;merchant:string};
type ScreenshotKind='expense'|'advance';
export default function ExpenseScreenshot({kind='expense',onFile,onFields,onBusy,disabled}:{kind?:ScreenshotKind;onFile:(file:File|null)=>void;onFields?:(fields:Fields)=>void;onBusy:(value:boolean)=>void;disabled:boolean}){
 const [preview,setPreview]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[result,setResult]=useState<OcrResult|null>(null),[zoom,setZoom]=useState(false),[dragging,setDragging]=useState(false);
 const controller=useRef<AbortController|null>(null),previewUrl=useRef(''),input=useRef<HTMLInputElement>(null),handlers=useRef({onFile,onFields,onBusy});
 handlers.current={onFile,onFields,onBusy};
 const advance=kind==='advance',label=advance?'到账截图':'支付截图';
 useEffect(()=>()=>{const pending=controller.current;controller.current=null;pending?.abort();if(previewUrl.current)URL.revokeObjectURL(previewUrl.current);handlers.current.onBusy(false);},[]);
 function showPreview(url:string){if(previewUrl.current)URL.revokeObjectURL(previewUrl.current);previewUrl.current=url;setPreview(url);}
 function cancel(){const pending=controller.current;controller.current=null;pending?.abort();setBusy(false);onBusy(false);setMessage('已停止识别，可对照截图手动填写。');}
 function clear(){
  if(disabled||controller.current)return;
  onFile(null);if(!advance)onFields?.({amount:'',date:'',merchant:''});showPreview('');setResult(null);setMessage('');setZoom(false);if(input.current)input.current.value='';
 }
 async function upload(files:File[]){
  // The ref also blocks a second drop before React has rendered the busy state.
  if(disabled||controller.current)return;
  let file:File;
  try{file=singleImage(files);}catch(e){setMessage((e as Error).message);return;}
  const request=new AbortController();controller.current=request;setBusy(true);onBusy(true);setMessage('正在检查图片…');
  try{
   await validateImageFile(file,request.signal);if(controller.current!==request||request.signal.aborted)return;
   showPreview(URL.createObjectURL(file));setZoom(false);setResult(null);handlers.current.onFile(file);
   if(advance){setMessage('到账截图已准备好，确认保存预支时才会保留附件；请手动填写到账金额和日期。');return;}
   handlers.current.onFields?.({amount:'',date:'',merchant:''});setMessage('正在本机识别… 首次加载可能需要一些时间。');
   try{
    const found=await recognizeScreenshot(file,request.signal);if(controller.current!==request||request.signal.aborted)return;
    setResult(found);const fields=found.expense_fields;
    handlers.current.onFields?.({amount:fields?.amount_cents?decimal(fields.amount_cents):'',date:fields?.date||'',merchant:fields?.merchant||''});
    setMessage('已填写能够确定的字段，请对照原图核对；留空项请手动补充。保存时才会登记费用并保留截图。');
   }catch(e){if(controller.current===request&&!request.signal.aborted)setMessage(`${(e as Error).message}。可以对照截图手动填写。`);}
  }catch(e){if(controller.current===request&&!request.signal.aborted)setMessage((e as Error).message);}
  finally{if(controller.current===request){controller.current=null;setBusy(false);handlers.current.onBusy(false);}}
 }
 function dragOver(event:React.DragEvent<HTMLElement>){event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect=disabled||busy?'none':'copy';if(!disabled&&!controller.current)setDragging(true);}
 function drop(event:React.DragEvent<HTMLElement>){event.preventDefault();event.stopPropagation();setDragging(false);void upload(Array.from(event.dataTransfer.files));}
 return <section className={`expense-screenshot${dragging?' dragging':''}`} aria-label={label} aria-busy={busy} onDragOver={dragOver} onDragLeave={()=>setDragging(false)} onDrop={drop}>
  <label className="field">上传{label}（可选）<input ref={input} type="file" accept="image/png,image/jpeg" disabled={disabled||busy} onChange={e=>{const files=Array.from(e.target.files??[]);e.target.value='';if(files.length)void upload(files);}}/></label>
  <p className="help">点击选择或拖入单张 PNG / JPEG，最大 20 MiB、2000 万像素；不支持 PDF、SVG 或多图。{advance?'仅保留到账凭证，不识别或自动填写金额。':'本机离线识别金额、日期和商户，可手动修正。'}</p>
  {message&&<p role="status" className="help">{message}</p>}
  {preview&&<><div className="screenshot-actions">{busy&&!advance?<button type="button" onClick={cancel}>停止识别，手动填写</button>:<button type="button" disabled={disabled||busy} onClick={clear}>{advance?'移除到账截图':'移除截图并清空识别字段'}</button>}<button type="button" onClick={()=>setZoom(!zoom)}>{zoom?'适应宽度':'放大原图'}</button></div><div className={`receipt-preview ${zoom?'zoom':''}`}><img src={preview} alt={`待保存${advance?'预支的到账':'费用的支付'}截图原图`}/></div></>}
  {result&&<details><summary>查看识别参考信息</summary><p className="help">账户余额：{result.extraction.fields.account_balance===null?'未确定':decimal(result.extraction.fields.account_balance)+' 元'} · 退款金额：{result.extraction.fields.refund===null?'未确定':decimal(result.extraction.fields.refund)+' 元'}。这些金额不会填入支出，也不自动冲减支出。</p><pre className="ocr-raw">{result.texts.join('\n')}</pre></details>}
 </section>;
}
export function ExpenseAttachment({id,kind='expense'}:{id:string;kind?:ScreenshotKind}){
 const [url,setUrl]=useState(''),[error,setError]=useState(''),[zoom,setZoom]=useState(false);
 const label=kind==='advance'?'到账截图':'支付截图';
 useEffect(()=>{let active=true,objectUrl='';setUrl('');setError('');setZoom(false);
  ledgerCommand<{mime:string;base64:string}>({kind:'attachment',id}).then(data=>{
   if(!active)return;const bytes=Uint8Array.from(atob(data.base64),c=>c.charCodeAt(0));objectUrl=URL.createObjectURL(new Blob([bytes],{type:data.mime}));setUrl(objectUrl);
  }).catch(()=>{if(active)setError('附件读取失败，请保留现有数据并重试。');});
  return ()=>{active=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[id]);
 return <section aria-label={`已保存的${label}`}><h3>{label}附件</h3>{error?<p role="alert" className="error">{error}</p>:url?<><button type="button" onClick={()=>setZoom(!zoom)}>{zoom?'适应宽度':'放大原图'}</button><div className={`receipt-preview ${zoom?'zoom':''}`}><img src={url} alt={`该笔${kind==='advance'?'预支':'费用'}已保留的${label}`}/></div></>:<p role="status">正在读取附件…</p>}</section>;
}
