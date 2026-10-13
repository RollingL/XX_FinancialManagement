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
 |{kind:'invoice-link';id:number;expectedRevision:number;expenseIds:number[]}
 |{kind:'invoice-edit';id:number;expectedRevision:number;invoice:InvoiceFields}
 |{kind:'invoice-delete';id:number;expectedRevision:number}
 |{kind:'invoice-allocate';id:number;expectedRevision:number;allocations:Allocation[]};
export type InvoiceRequest=InvoiceRequestBody&{requestId:string};

export const invoiceCode=(id:number)=>`FP-${String(id).padStart(3,'0')}`;
export const invoiceExpenseIds=(invoice:Invoice)=>invoice.expenseIds??invoice.allocations.map(row=>row.expenseId);
export function validateInvoiceLinks(ids:number[],state:LedgerState){const seen=new Set<number>();for(const id of ids){if(!Number.isSafeInteger(id)||id<=0||seen.has(id))throw new Error('费用编号无效或重复关联');if(!state.expenses.some(expense=>expense.id===id))throw new Error('关联费用不存在，请重新核对');seen.add(id);}return [...ids].sort((a,b)=>a-b);}
export const invoiceAllocatedAmount=(invoice:Invoice)=>sum(invoice.allocations.map(row=>row.amount));
export function expenseHasInvoice(state:LedgerState,expenseId:number){return (state.expenses.find(expense=>expense.id===expenseId)?.invoice??0)>0||(state.invoices??[]).some(invoice=>invoiceExpenseIds(invoice).includes(expenseId));}
export function expenseInvoiceAmount(state:LedgerState,expenseId:number,excludeInvoiceId?:number){
 const expense=state.expenses.find(expense=>expense.id===expenseId);
 return (state.invoices??[]).some(invoice=>invoice.id!==excludeInvoiceId&&invoiceExpenseIds(invoice).includes(expenseId))?(expense?.amount??0):(expense?.invoice??0);
}
export function expenseHasInvoiceHistory(state:LedgerState,expenseId:number){
 const linked=(invoice:Invoice|null)=>invoice?invoiceExpenseIds(invoice).includes(expenseId):false;
 return (state.expenses.find(expense=>expense.id===expenseId)?.invoice??0)>0||(state.invoices??[]).some(linked)||(state.invoiceEvents??[]).some(event=>linked(event.before)||linked(event.after));
}
export function invoiceRecords(invoices:Invoice[],filters:{query:string;unallocatedOnly:boolean}){
 const key=filters.query.trim().toLocaleLowerCase();
 return invoices.filter(invoice=>(!filters.unallocatedOnly||invoiceExpenseIds(invoice).length===0)&&(!key||[invoiceCode(invoice.id),String(invoice.id),invoice.number,invoice.code,invoice.seller,invoice.buyer,invoice.note].some(value=>value.toLocaleLowerCase().includes(key)))).sort((a,b)=>b.date.localeCompare(a.date)||b.id-a.id);
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
export function invoiceAllocationChanges(before:Invoice|null,after:Invoice|null){
 const previous=new Map((before?.allocations??[]).map(row=>[row.expenseId,row.amount])),next=new Map((after?.allocations??[]).map(row=>[row.expenseId,row.amount]));
 return [...new Set([...previous.keys(),...next.keys()])].sort((a,b)=>a-b).map(expenseId=>({expenseId,before:previous.get(expenseId)??0,after:next.get(expenseId)??0})).filter(row=>row.before!==row.after);
}
export function validateInvoiceAllocations(rows:Allocation[],state:LedgerState,_invoice:Invoice){
 validateInvoiceLinks(rows.map(row=>row.expenseId),state);
 for(const row of rows)if(!Number.isSafeInteger(row.amount)||row.amount<=0)throw new Error('每笔历史分配金额须为安全范围内的正整数分');
 return sum(rows.map(row=>row.amount));
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
