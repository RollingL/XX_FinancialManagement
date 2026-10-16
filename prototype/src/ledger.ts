import type {Expense,Batch,Allocation} from './model.ts';
export type AdvanceDetails={date?:string;note?:string;createdAt?:string;attachmentId?:string;deleted?:boolean};
// Optional metadata keyed by the immutable index in advances; never another amount source.
export type BatchEvent={requestId:string;action:'delete-batch';at:string;batchId:number;before:Batch;after:null};
export type ExpenseEvent={requestId:string;action:'correct-expense'|'delete-expense'|'set-invoice-issued';at:string;expenseId:number;revision:number;before:Expense;after:Expense|null};
export type InvoiceIdentityType='unconfirmed'|'number'|'code-number';
export type Invoice={id:number;identityType:InvoiceIdentityType;number:string;code:string;date:string;seller:string;buyer:string;amount:number;note:string;attachmentIds:string[];allocations:Allocation[];expenseIds?:number[];revision:number;createdAt:string};
export type InvoiceEvent={requestId:string;action:'invoice'|'invoice-identity'|'invoice-attachment'|'invoice-allocate'|'invoice-link'|'invoice-edit'|'invoice-delete'|'batch-invoice-link'|'expense-invoice-unlink';at:string;invoiceId:number;revision:number;before:Invoice|null;after:Invoice|null};
export type AdvanceEvent={requestId:string;action:'correct-advance'|'delete-advance';at:string;advanceId:number;revision:number;before:{amount:number;details:AdvanceDetails|null};after:{amount:number;details:AdvanceDetails|null}|null};
export type LedgerState={expenses:Expense[];batches:Batch[];advances:number[];advanceDetails?:Record<number,AdvanceDetails>;batchEvents?:BatchEvent[];expenseEvents?:ExpenseEvent[];advanceEvents?:AdvanceEvent[];invoices?:Invoice[];invoiceEvents?:InvoiceEvent[];generation?:string;resetReceipt?:{requestId:string;fromGeneration:string;at:string}};
declare global{interface Window{localLedger?:{command:(payload:unknown)=>Promise<unknown>}}}
// A tab retains the generation it loaded. Maintenance-info must never silently refresh
// this token: drafts and retries from before another tab's reset must stay stale.
let loadedGeneration:string|undefined;
export async function ledgerCommand<T=LedgerState>(payload:unknown):Promise<T>{
 const input=payload as Record<string,unknown>;
 const request=input&&typeof input==='object'&&input.kind!=='read'&&input.kind!=='maintenance-info'&&loadedGeneration&&!Object.hasOwn(input,'generation')?{...input,generation:loadedGeneration}:payload;
 let result:any;
 if(window.localLedger)result=await window.localLedger.command(request);
 else{
  const response=await fetch('/api/ledger',{method:'POST',headers:{'Content-Type':'application/json','X-Ledger-Request':'1'},body:JSON.stringify(request),cache:'no-store'});
  if(!response.headers.get('content-type')?.includes('application/json'))throw Error('本地账本服务暂时不可用，请关闭并重新打开钱来');
  result=await response.json();if(!response.ok)throw Error(result.error||'本地读写失败');
 }
 if(input?.kind==='read')loadedGeneration=typeof result?.generation==='string'?result.generation:undefined;
 return result as T;
}
export async function imagePayload(file:File){
 const bytes=new Uint8Array(await file.arrayBuffer());let value='';
 for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));
 return {base64:btoa(value)};
}
