// Pure stage-0 invoice rules. Invoice facts never modify expenses or cash facts.
const {isDeepStrictEqual}=require('node:util');
const INVOICE_KINDS=['invoice','invoice-identity','invoice-attachment','invoice-allocate','invoice-link','invoice-edit','invoice-delete'];
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
 const keys={invoice:'kind,requestId,invoice,image','invoice-identity':'kind,requestId,id,expectedRevision,identity','invoice-attachment':'kind,requestId,id,expectedRevision,image','invoice-allocate':'kind,requestId,id,expectedRevision,allocations','invoice-link':'kind,requestId,id,expectedRevision,expenseIds','invoice-edit':'kind,requestId,id,expectedRevision,invoice','invoice-delete':'kind,requestId,id,expectedRevision'};
 exact(input,keys[input.kind]||'');
 if(input.kind==='invoice'||input.kind==='invoice-edit')fields(input.invoice);
 if(input.kind==='invoice-link')validateExpenseIds(input.expenseIds);
 if(input.kind!=='invoice'){positive(input.id,'发票编号');positive(input.expectedRevision,'发票修订');}
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
 return [...invoices,...events.flatMap(event=>[event.before,event.after]).filter(Boolean)].some(invoice=>invoiceExpenseIds(invoice).includes(expenseId));
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
function invoiceExpenseIds(invoice){return invoice.expenseIds??(invoice.allocations??[]).map(row=>row.expenseId);}
function validateExpenseIds(ids){
 if(!Array.isArray(ids))fail('发票关联费用无效');
 const seen=new Set();for(const id of ids){positive(id,'费用编号');if(seen.has(id))fail('费用重复关联');seen.add(id);}
 return [...ids].sort((a,b)=>a-b);
}
function linksFor(state,ids){const normalized=validateExpenseIds(ids);for(const id of normalized)if(!state.expenses.some(expense=>expense.id===id))fail('关联费用不存在');return normalized;}
function applyBatchInvoiceLinks(state,input,{createdAt}){
 if(input.invoiceLinks===undefined)return;
 if(!Array.isArray(input.invoiceLinks))fail('报销发票关联无效');
 const seen=new Set(),allowed=new Set(input.allocations.filter(row=>row.amount>0).map(row=>row.expenseId));
 for(const link of input.invoiceLinks){
  exact(link,'invoiceId,expectedRevision,expenseIds');positive(link.invoiceId,'发票编号');positive(link.expectedRevision,'发票修订');
  if(seen.has(link.invoiceId))fail('发票重复关联');seen.add(link.invoiceId);
  const ids=linksFor(state,link.expenseIds);if(!ids.length||ids.some(id=>!allowed.has(id)))fail('发票仅可关联本批次已分配的费用');
  const {invoices,events}=collections(state),before=invoices.find(invoice=>invoice.id===link.invoiceId);if(!before)fail('发票不存在');
  if(before.revision!==link.expectedRevision)fail('发票已变化，请刷新后重新核对');
  const expenseIds=[...new Set([...invoiceExpenseIds(before),...ids])].sort((a,b)=>a-b);
  if(isDeepStrictEqual(invoiceExpenseIds(before).slice().sort((a,b)=>a-b),expenseIds))continue;
  const revision=positive(before.revision+1,'发票修订'),after={...structuredClone(before),expenseIds,allocations:[],revision};
  state.invoices=invoices.map(invoice=>invoice.id===before.id?after:invoice);
  state.invoiceEvents=[...events,{requestId:input.requestId,action:'batch-invoice-link',at:createdAt,invoiceId:before.id,revision,before:structuredClone(before),after:structuredClone(after)}];
 }
 return input.invoiceLinks.map(({invoiceId,expenseIds})=>({invoiceId,expenseIds:expenseIds.slice().sort((a,b)=>a-b)}));
}
function removeExpenseInvoiceLinks(state,expenseId,{requestId,createdAt}){
 const {invoices}=collections(state);
 for(const before of invoices){if(!invoiceExpenseIds(before).includes(expenseId))continue;const revision=positive(before.revision+1,'发票修订'),after={...structuredClone(before),allocations:[],expenseIds:invoiceExpenseIds(before).filter(id=>id!==expenseId),revision};
 state.invoices=state.invoices.map(invoice=>invoice.id===before.id?after:invoice);state.invoiceEvents=[...(state.invoiceEvents??[]),{requestId,action:'expense-invoice-unlink',at:createdAt,invoiceId:before.id,revision,before:structuredClone(before),after:structuredClone(after)}];
 }
}
function applyInvoiceCommand(state,input,{attachment,createdAt,attachmentMetadata=[]}){
 validateInvoiceCommand(input);
 const {invoices,events}=collections(state);let before=null,after;
 if(input.kind==='invoice'){
  const id=Math.max(0,...invoices.map(invoice=>invoice.id),...events.map(event=>event.invoiceId))+1;positive(id,'发票编号');
  after={id,...fields(input.invoice),attachmentIds:[attachment?.id],allocations:[],expenseIds:[],revision:1,createdAt};
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
  }else if(input.kind==='invoice-delete')after=null;
  else if(input.kind==='invoice-edit'){Object.assign(after,fields(input.invoice));uniqueIdentity(invoices,after);if(invoices.filter(invoice=>invoice.id!==before.id).reduce((sum,invoice)=>sum+BigInt(positive(invoice.amount)),BigInt(after.amount))>BigInt(Number.MAX_SAFE_INTEGER))fail('发票票面金额合计超出安全范围');}
  else {after.expenseIds=linksFor(state,input.kind==='invoice-link'?input.expenseIds:input.allocations.map(row=>row.expenseId));after.allocations=[];}
  if(isDeepStrictEqual(before,after))fail('发票内容没有变化');
  if(after)after.revision++;
 }
 state.invoices=before?(after?invoices.map(invoice=>invoice.id===before.id?after:invoice):invoices.filter(invoice=>invoice.id!==before.id)):[...invoices,after];
 state.invoiceEvents=[...events,{requestId:input.requestId,action:input.kind,at:createdAt,invoiceId:before?.id??after.id,revision:after?.revision??before.revision+1,before:before?structuredClone(before):null,after:structuredClone(after)}];
}
module.exports={INVOICE_KINDS,normalizeNumber,validateInvoiceCommand,hasInvoiceHistory,applyInvoiceCommand,invoiceExpenseIds,applyBatchInvoiceLinks,removeExpenseInvoiceLinks};
