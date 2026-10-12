// Pure stage-0 invoice rules. Invoice facts never modify expenses or cash facts.
const {isDeepStrictEqual}=require('node:util');
const INVOICE_KINDS=['invoice','invoice-identity','invoice-attachment','invoice-allocate'];
const fail=message=>{throw Object.assign(Error(message),{status:422});};
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.split(',').sort().join(','))fail('发票请求字段无效');}
function positive(value,label='金额'){if(!Number.isSafeInteger(value)||value<=0)fail(`${label}须为安全范围内的正整数`);return value;}
function text(value,max){if(typeof value!=='string'||value.length>max)fail('发票文本字段无效');return value.trim();}
function normalizeNumber(value){const normalized=text(value,100).normalize('NFKC').replace(/\s/g,'').toUpperCase().normalize('NFKC');if(normalized.length>100)fail('发票号码或代码过长');return normalized;}
function identity(value,confirmedOnly=false){
 exact(value,'identityType,number,code');
 const {identityType}=value,number=normalizeNumber(value.number),code=normalizeNumber(value.code);
 if(!['unconfirmed','number','code-number'].includes(identityType)||(confirmedOnly&&identityType==='unconfirmed')||(identityType==='number'&&(!number||code))||(identityType==='code-number'&&(!number||!code)))fail('发票身份无效，请核对号码和代码');
 return {identityType,number,code};
}
function fields(value){
 exact(value,'identityType,number,code,date,seller,buyer,amount,note');
 if(typeof value.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value.date)||!Number.isFinite(Date.parse(value.date))||new Date(value.date).toISOString().slice(0,10)!==value.date)fail('发票日期无效');
 return {...identity({identityType:value.identityType,number:value.number,code:value.code}),date:value.date,seller:text(value.seller,200),buyer:text(value.buyer,200),amount:positive(value.amount),note:text(value.note,500)};
}
function validateInvoiceCommand(input){
 const keys={invoice:'kind,requestId,invoice,image','invoice-identity':'kind,requestId,id,expectedRevision,identity','invoice-attachment':'kind,requestId,id,expectedRevision,image','invoice-allocate':'kind,requestId,id,expectedRevision,allocations'};
 exact(input,keys[input.kind]||'');
 if(input.kind==='invoice')fields(input.invoice);
 else{positive(input.id,'发票编号');positive(input.expectedRevision,'发票修订');}
 if(input.kind==='invoice-identity')identity(input.identity,true);
 if(input.kind==='invoice'||input.kind==='invoice-attachment'){exact(input.image,'base64');if(typeof input.image.base64!=='string')fail('发票原图无效');}
 if(input.kind==='invoice-allocate'){
  if(!Array.isArray(input.allocations))fail('发票分配无效');
  const seen=new Set();for(const row of input.allocations){exact(row,'expenseId,amount');positive(row.expenseId,'费用编号');positive(row.amount);if(seen.has(row.expenseId))fail('费用重复分配');seen.add(row.expenseId);}
 }
}
function collections(state){
 const invoices=state.invoices===undefined?[]:state.invoices,events=state.invoiceEvents===undefined?[]:state.invoiceEvents;
 if(!Array.isArray(invoices)||!Array.isArray(events))fail('现有发票数据无效，请保留账本');
 return {invoices,events};
}
function hasInvoiceHistory(state,expenseId){
 const {invoices,events}=collections(state);
 return [...invoices,...events.flatMap(event=>[event.before,event.after]).filter(Boolean)].some(invoice=>invoice.allocations.some(row=>row.expenseId===expenseId));
}
function uniqueIdentity(invoices,candidate){
 const duplicate=candidate.number&&invoices.find(invoice=>invoice.id!==candidate.id&&invoice.number===candidate.number&&(invoice.code===candidate.code||!invoice.code||!candidate.code));
 if(duplicate)fail(`发票身份可能重复，请打开已有发票 #${duplicate.id} 核对或补充原图`);
}
function uniqueAttachment(invoices,attachment,metadata){
 if(!attachment)fail('发票必须保存原图');
 const rows=new Map(metadata.map(row=>[row.id,row]));
 for(const invoice of invoices)for(const id of invoice.attachmentIds){const previous=rows.get(id);if(!previous)fail('现有发票附件缺失，请保留账本');if(previous.sha256===attachment.sha256)fail(`发票原图重复，请打开已有发票 #${invoice.id} 核对`);}
}
function allocationsFor(state,invoices,current,allocations){
 if(current.identityType==='unconfirmed'&&allocations.length)fail('请先核对发票身份再分配');
 const sum=allocations.reduce((value,row)=>value+BigInt(row.amount),0n);
 if(sum>BigInt(current.amount))fail('分配超过票面金额');
 for(const row of allocations){
  const expense=state.expenses.find(expense=>expense.id===row.expenseId);if(!expense)fail('费用不存在');
  if(!Number.isSafeInteger(expense.invoice)||expense.invoice<0||!Number.isSafeInteger(expense.amount)||expense.amount<=0)fail('现有费用票额无效，请保留账本');
  const other=invoices.filter(invoice=>invoice.id!==current.id).flatMap(invoice=>invoice.allocations.filter(item=>item.expenseId===row.expenseId));
  const covered=other.reduce((value,item)=>value+BigInt(positive(item.amount)),BigInt(expense.invoice));
  if(covered+BigInt(row.amount)>BigInt(expense.amount))fail('分配超过费用可用票额，请刷新后重试');
 }
 // A different row order represents the same allocation set.
 return allocations.map(row=>({expenseId:row.expenseId,amount:row.amount})).sort((a,b)=>a.expenseId-b.expenseId);
}
function applyInvoiceCommand(state,input,{attachment,createdAt,attachmentMetadata=[]}){
 validateInvoiceCommand(input);
 const {invoices,events}=collections(state);let before=null,after;
 if(input.kind==='invoice'){
  const id=Math.max(0,...invoices.map(invoice=>invoice.id),...events.map(event=>event.invoiceId))+1;positive(id,'发票编号');
  after={id,...fields(input.invoice),attachmentIds:[attachment?.id],allocations:[],revision:1,createdAt};
  if(invoices.reduce((sum,invoice)=>sum+BigInt(positive(invoice.amount)),BigInt(after.amount))>BigInt(Number.MAX_SAFE_INTEGER))fail('发票票面金额合计超出安全范围');
  uniqueIdentity(invoices,after);uniqueAttachment(invoices,attachment,attachmentMetadata);
 }else{
  before=invoices.find(invoice=>invoice.id===input.id);if(!before)fail('发票不存在');
  if(before.revision!==input.expectedRevision)fail('发票已变化，请刷新后重新核对');
  positive(before.revision+1,'发票修订');after=structuredClone(before);
  if(input.kind==='invoice-identity'){
   if(before.identityType!=='unconfirmed')fail('已核对的发票身份不能再次修改');
   Object.assign(after,identity(input.identity,true));uniqueIdentity(invoices,after);
  }else if(input.kind==='invoice-attachment'){
   uniqueAttachment(invoices,attachment,attachmentMetadata);after.attachmentIds.push(attachment.id);
  }else after.allocations=allocationsFor(state,invoices,before,input.allocations);
  if(isDeepStrictEqual(before,after))fail('发票内容没有变化');
  after.revision++;
 }
 state.invoices=before?invoices.map(invoice=>invoice.id===after.id?after:invoice):[...invoices,after];
 state.invoiceEvents=[...events,{requestId:input.requestId,action:input.kind,at:createdAt,invoiceId:after.id,revision:after.revision,before:before?structuredClone(before):null,after:structuredClone(after)}];
}
module.exports={INVOICE_KINDS,normalizeNumber,validateInvoiceCommand,hasInvoiceHistory,applyInvoiceCommand};
