import {cents,decimal,sum} from './model.ts';
import type {Allocation} from './model.ts';
import type {Invoice,LedgerState} from './ledger.ts';

export type InvoiceIdentityType=Invoice['identityType'];
export type InvoiceIdentityDraft={identityType:InvoiceIdentityType;number:string;code:string};
export type InvoiceDraft=InvoiceIdentityDraft&{date:string;seller:string;buyer:string;amount:string;note:string};
export type InvoiceFields=Omit<InvoiceDraft,'amount'>&{amount:number};
export type InvoiceRequestBody=
 |{kind:'invoice';invoice:InvoiceFields;image:{base64:string}}
 |{kind:'invoice-identity';id:number;expectedRevision:number;identity:{identityType:'number'|'code-number';number:string;code:string}}
 |{kind:'invoice-attachment';id:number;expectedRevision:number;image:{base64:string}}
 |{kind:'invoice-allocate';id:number;expectedRevision:number;allocations:Allocation[]};
export type InvoiceRequest=InvoiceRequestBody&{requestId:string};

export const invoiceCode=(id:number)=>`FP-${String(id).padStart(3,'0')}`;
export const invoiceAllocatedAmount=(invoice:Invoice)=>sum(invoice.allocations.map(row=>row.amount));
export function expenseInvoiceAmount(state:LedgerState,expenseId:number,excludeInvoiceId?:number){
 return sum([state.expenses.find(expense=>expense.id===expenseId)?.invoice??0,...(state.invoices??[]).filter(invoice=>invoice.id!==excludeInvoiceId).flatMap(invoice=>invoice.allocations.filter(row=>row.expenseId===expenseId).map(row=>row.amount))]);
}
export function expenseHasInvoiceHistory(state:LedgerState,expenseId:number){
 const linked=(invoice:Invoice|null)=>invoice?.allocations.some(row=>row.expenseId===expenseId)??false;
 return (state.expenses.find(expense=>expense.id===expenseId)?.invoice??0)>0||(state.invoices??[]).some(linked)||(state.invoiceEvents??[]).some(event=>linked(event.before)||linked(event.after));
}
export function invoiceRecords(invoices:Invoice[],filters:{query:string;unallocatedOnly:boolean}){
 const key=filters.query.trim().toLocaleLowerCase();
 return invoices.filter(invoice=>(!filters.unallocatedOnly||invoice.allocations.length===0)&&(!key||[invoiceCode(invoice.id),String(invoice.id),invoice.number,invoice.code,invoice.seller,invoice.buyer,invoice.note].some(value=>value.toLocaleLowerCase().includes(key)))).sort((a,b)=>b.date.localeCompare(a.date)||b.id-a.id);
}
export function normalizeInvoiceIdentifier(value:string){
 if(value.length>100)throw new Error('发票号码或代码不能超过 100 个字符');
 const normalized=value.trim().normalize('NFKC').replace(/\s/g,'').toUpperCase().normalize('NFKC');
 if(normalized.length>100)throw new Error('发票号码或代码不能超过 100 个字符');
 return normalized;
}
export function parseInvoiceIdentity(draft:InvoiceIdentityDraft){
 if(!['unconfirmed','number','code-number'].includes(draft.identityType))throw new Error('请选择发票身份类型');
 const number=normalizeInvoiceIdentifier(draft.number),code=draft.identityType==='number'?'':normalizeInvoiceIdentifier(draft.code);
 if(draft.identityType!=='unconfirmed'&&!number)throw new Error('请填写并核对发票号码');
 if(draft.identityType==='code-number'&&!code)throw new Error('请填写并核对发票代码');
 return {identityType:draft.identityType,number,code};
}
export function parseInvoiceDraft(draft:InvoiceDraft):InvoiceFields{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)||!Number.isFinite(Date.parse(draft.date))||new Date(draft.date).toISOString().slice(0,10)!==draft.date)throw new Error('请填写有效的开票日期');
 if(draft.seller.length>200||draft.buyer.length>200)throw new Error('销售方或购买方不能超过 200 个字符');
 if(draft.note.length>500)throw new Error('备注不能超过 500 个字符');
 return {...parseInvoiceIdentity(draft),date:draft.date,seller:draft.seller.trim(),buyer:draft.buyer.trim(),amount:cents(draft.amount),note:draft.note.trim()};
}
export function invoiceAllocationRows(invoice:Invoice){return Object.fromEntries(invoice.allocations.map(row=>[row.expenseId,decimal(row.amount)]));}
export function invoiceAllocationChanges(before:Invoice|null,after:Invoice){
 const previous=new Map((before?.allocations??[]).map(row=>[row.expenseId,row.amount])),next=new Map(after.allocations.map(row=>[row.expenseId,row.amount]));
 return [...new Set([...previous.keys(),...next.keys()])].sort((a,b)=>a-b).map(expenseId=>({expenseId,before:previous.get(expenseId)??0,after:next.get(expenseId)??0})).filter(row=>row.before!==row.after);
}
export function validateInvoiceAllocations(rows:Allocation[],state:LedgerState,invoice:Invoice){
 if(invoice.identityType==='unconfirmed')throw new Error('请先核对发票身份，再关联费用');
 const seen=new Set<number>();
 for(const row of rows){
  if(!Number.isSafeInteger(row.expenseId)||row.expenseId<=0||seen.has(row.expenseId))throw new Error('费用编号无效或重复分配');
  seen.add(row.expenseId);
  const expense=state.expenses.find(item=>item.id===row.expenseId);
  if(!expense)throw new Error('关联费用不存在，请重新核对');
  if(!Number.isSafeInteger(row.amount)||row.amount<=0)throw new Error('每笔分配金额须为安全范围内的正整数分');
  if(sum([expenseInvoiceAmount(state,expense.id,invoice.id),row.amount])>expense.amount)throw new Error(`费用 #${expense.id} 的分配超过未覆盖票额`);
 }
 const total=sum(rows.map(row=>row.amount));
 if(total>invoice.amount)throw new Error('分配合计超过发票金额');
 return total;
}
export function parseInvoiceAllocations(rows:Record<number,string>,state:LedgerState,invoice:Invoice){
 const allocations=Object.entries(rows).map(([id,value])=>({expenseId:Number(id),amount:cents(value)})).sort((a,b)=>a.expenseId-b.expenseId);
 validateInvoiceAllocations(allocations,state,invoice);return allocations;
}
export function invoiceRequest(body:InvoiceRequestBody,attempts:readonly InvoiceRequest[],createId:()=>string=()=>crypto.randomUUID()):InvoiceRequest{
 const key=JSON.stringify(body);
 const previous=attempts.find(attempt=>{const {requestId,...payload}=attempt;return JSON.stringify(payload)===key;});
 return previous??{...structuredClone(body),requestId:createId()};
}
