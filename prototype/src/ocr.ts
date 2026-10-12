import {decimal,rowCents} from './model.ts';
export type OcrField='actual_paid'|'account_balance'|'refund';
export type OcrResult={expense_fields?:{amount_cents:number|null;date:string|null;merchant:string|null};texts:string[];extraction:{payment_status:string;fields:Record<string,number|null>;suggested_expense_cents:number|null;warnings:string[];candidates:{role:string;source_texts:string[];ocr_confidence:number}[];auto_bookkeeping:false;requires_confirmation:true}};
declare global{interface Window{localOcr?:{recognize:(id:string,bytes:ArrayBuffer)=>Promise<OcrResult>;cancel:(id:string)=>void}}}
export function initialOcrValues(result:OcrResult):Record<OcrField,string>{
 const extraction=result.extraction;
 const foreign=extraction.warnings.includes('unsupported_currency');
 const values={actual_paid:extraction.suggested_expense_cents,account_balance:extraction.fields.account_balance,refund:extraction.fields.refund};
 return Object.fromEntries(Object.entries(values).map(([key,value])=>[key,!foreign&&Number.isSafeInteger(value)&&value!==null?decimal(value):''])) as Record<OcrField,string>;
}
export function manualAmount(value:string,field:OcrField):number|null{
 if(!value.trim())return null;
 const negative=field==='account_balance'&&value.trim().startsWith('-');
 if(negative&&!value.trim().slice(1).trim())throw Error('请填写完整金额');
 return rowCents(negative?value.trim().slice(1):value.trim())*(negative?-1:1);
}
export async function recognizeScreenshot(file:File,signal:AbortSignal):Promise<OcrResult>{
 if(file.size===0||file.size>20*1024*1024||!['image/png','image/jpeg'].includes(file.type))throw Error('请选择不超过 20 MiB 的 PNG 或 JPEG 图片');
 const bytes=await file.arrayBuffer();signal.throwIfAborted();
 if(window.localOcr){
  const id=crypto.randomUUID();const cancel=()=>window.localOcr?.cancel(id);
  signal.addEventListener('abort',cancel,{once:true});
  try{return await window.localOcr.recognize(id,bytes);}finally{signal.removeEventListener('abort',cancel);}
 }
 const response=await fetch('/api/ocr',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-OCR-Request':'1'},body:bytes,signal,cache:'no-store'});
 const type=response.headers.get('content-type')||'';
 if(!type.includes('application/json'))throw Error('本地 OCR 未启动，请使用 npm run dev 或更新后的 Electron 原型');
 const result=await response.json();if(!response.ok)throw Error(result.error||'本地识别失败');
 return result;
}
