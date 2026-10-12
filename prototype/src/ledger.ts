import type {Expense,Batch} from './model.ts';
export type AdvanceDetails={date:string;note:string;createdAt:string;attachmentId?:string};
// Optional metadata keyed by the immutable index in advances; never another amount source.
export type LedgerState={expenses:Expense[];batches:Batch[];advances:number[];advanceDetails?:Record<number,AdvanceDetails>};
declare global{interface Window{localLedger?:{command:(payload:unknown)=>Promise<unknown>}}}
export async function ledgerCommand<T=LedgerState>(payload:unknown):Promise<T>{
 if(window.localLedger)return await window.localLedger.command(payload) as T;
 const response=await fetch('/api/ledger',{method:'POST',headers:{'Content-Type':'application/json','X-Ledger-Request':'1'},body:JSON.stringify(payload),cache:'no-store'});
 if(!response.headers.get('content-type')?.includes('application/json'))throw Error('本地保存服务未启动，请重新启动原型');
 const result=await response.json();if(!response.ok)throw Error(result.error||'本地读写失败');return result;
}
export async function imagePayload(file:File){
 const bytes=new Uint8Array(await file.arrayBuffer());let value='';
 for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));
 return {base64:btoa(value)};
}
