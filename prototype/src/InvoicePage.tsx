import React,{useEffect,useRef,useState} from 'react';
import type {Invoice,InvoiceEvent,LedgerState} from './ledger.ts';
import {imagePayload,ledgerCommand} from './ledger.ts';
import {decimal,money} from './model.ts';
import {localDate} from './local-date.ts';
import {matchesExpense} from './records.ts';
import Pagination,{usePagination} from './Pagination.tsx';
import ExpenseScreenshot,{ExpenseAttachment} from './ExpenseScreenshot.tsx';
import {invoiceExpenseIds,validateInvoiceLinks,invoiceCode,invoiceRecords,invoiceRequest,parseInvoiceDraft,parseInvoiceIdentity} from './invoice-model.ts';
import type {InvoiceDraft,InvoiceIdentityDraft,InvoiceRequest,InvoiceRequestBody} from './invoice-model.ts';
import './invoice.css';

type Panel='new'|'detail'|'identity'|'attachment'|'allocate'|'edit'|'delete'|null;
type Props={state:LedgerState;onState:(state:LedgerState)=>void;onExpense:(id:number)=>void;disabled?:boolean};
const emptyDraft=():InvoiceDraft=>({identityType:'unconfirmed',number:'',code:'',date:localDate(),seller:'',buyer:'',amount:'',note:''});
const identityLabel=(invoice:Invoice)=>invoice.identityType==='unconfirmed'?'待核对身份':invoice.identityType==='number'?'号码已核对':'代码及号码已核对';
const identityText=(invoice:Invoice)=>`${identityLabel(invoice)} · ${invoice.code?`${invoice.code} / `:''}${invoice.number||'未填号码'}`;
const actionLabels:Record<InvoiceEvent['action'],string>={'invoice':'归档发票','invoice-identity':'核对身份','invoice-attachment':'补充原票扫描件','invoice-allocate':'编辑费用关联','invoice-link':'编辑费用关联','invoice-edit':'修改发票','invoice-delete':'删除发票','batch-invoice-link':'报销关联发票','expense-invoice-unlink':'费用删除解除关联'};

function IdentityFields({value,onChange,confirmedOnly=false}:{value:InvoiceIdentityDraft;onChange:(value:InvoiceIdentityDraft)=>void;confirmedOnly?:boolean}){
 return <>
  <label className="field">发票身份类型<select value={value.identityType} onChange={event=>onChange({...value,identityType:event.target.value as InvoiceIdentityDraft['identityType']})}>
   {!confirmedOnly&&<option value="unconfirmed">仅归档，身份待核对</option>}<option value="number">以发票号码确认</option><option value="code-number">以发票代码和号码确认</option>
  </select></label>
  <label className="field">{value.identityType==='unconfirmed'?'发票号码（选填，待核对）':'发票号码'}<input value={value.number} maxLength={100} required={value.identityType!=='unconfirmed'} onChange={event=>onChange({...value,number:event.target.value})}/></label>
  {value.identityType!=='number'&&<label className="field">{value.identityType==='unconfirmed'?'发票代码（选填，待核对）':'发票代码'}<input value={value.code} maxLength={100} required={value.identityType==='code-number'} onChange={event=>onChange({...value,code:event.target.value})}/></label>}
  <p className="help">{value.identityType==='unconfirmed'?'先保留原图，号码可以稍后核对。':'请按原票核对号码及适用的代码；可通过修改发票纠正误填信息。'} 不预设固定号码位数，不进行税务验真。</p>
 </>;
}

function AuditEntry({event}:{event:InvoiceEvent}){
 const before=event.before,after=event.after;
 return <article className="invoice-audit-entry"><header><strong>{actionLabels[event.action]} · 第 {event.revision} 次修订</strong><time dateTime={event.at}>{new Date(event.at).toLocaleString('zh-CN',{hour12:false})}</time></header>
  <p>身份：{before?identityText(before):'尚未归档'} → {after?identityText(after):'已删除'}</p>
  <p>原票扫描件：{before?.attachmentIds.length??0} → {after?.attachmentIds.length??0} 份</p>
  <p>关联费用：{before?invoiceExpenseIds(before).join('、')||'无':'无'} → {after?invoiceExpenseIds(after).join('、')||'无':'无'}</p>
  <p>票面金额：{before?money(before.amount):'无'} → {after?money(after.amount):'已删除'}</p>
  {before&&after&&(['date','seller','buyer','note'] as const).filter(key=>before[key]!==after[key]).map(key=><p key={key}>{({date:'开票日期',seller:'销售方',buyer:'购买方',note:'备注'})[key]}：{before[key]||'未填写'} → {after[key]||'未填写'}</p>)}
 </article>;
}

export default function InvoicePage({state,onState,onExpense,disabled=false}:Props){
 const [query,setQuery]=useState(''),[unallocatedOnly,setUnallocatedOnly]=useState(false),[panel,setPanel]=useState<Panel>(null),[selectedId,setSelectedId]=useState<number|null>(null);
 const [draft,setDraft]=useState<InvoiceDraft>(emptyDraft),[identity,setIdentity]=useState<InvoiceIdentityDraft>({identityType:'number',number:'',code:''}),[snapshot,setSnapshot]=useState<Invoice|null>(null);
 const [rows,setRows]=useState<Record<number,string>>({}),[expenseQuery,setExpenseQuery]=useState(''),[expenseCategory,setExpenseCategory]=useState('全部');
 const [file,setFile]=useState<File|null>(null),[saving,setSaving]=useState(false),[imageBusy,setImageBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[expandedAttachment,setExpandedAttachment]=useState<string|null>(null);
 const dialog=useRef<HTMLDialogElement>(null),saveLock=useRef(false),imageBusyRef=useRef(false),attempts=useRef<InvoiceRequest[]>([]),imageCache=useRef(new WeakMap<File,Promise<{base64:string}>>());
 const invoices=state.invoices??[],current=invoices.find(invoice=>invoice.id===selectedId),filtered=invoiceRecords(invoices,{query,unallocatedOnly});
 const listPages=usePagination(filtered,JSON.stringify([query,unallocatedOnly]));
 const allocationPages=usePagination(current?invoiceExpenseIds(current):[],String(selectedId));
 const attachmentPages=usePagination(current?.attachmentIds??[],String(selectedId));
 const events=(state.invoiceEvents??[]).filter(event=>event.invoiceId===selectedId).sort((a,b)=>b.revision-a.revision||b.at.localeCompare(a.at));
 const auditPages=usePagination(events,String(selectedId));
 const picker=state.expenses.filter(expense=>(expenseCategory==='全部'||expense.category===expenseCategory)&&matchesExpense(expense,expenseQuery));
 const pickerPages=usePagination(picker,JSON.stringify([panel,selectedId,expenseQuery,expenseCategory]));


 useEffect(()=>{if(panel){dialog.current?.showModal();dialog.current?.querySelector<HTMLHeadingElement>('#invoice-panel-title')?.focus();}else dialog.current?.close();},[panel,selectedId]);
 function begin(){attempts.current=[];setError('');setFile(null);setExpandedAttachment(null);}
 function openNew(){if(disabled||saveLock.current)return;begin();setDraft(emptyDraft());setSnapshot(null);setPanel('new');}
 function openDetail(id:number){if(saveLock.current)return;begin();setSelectedId(id);setSnapshot(null);setPanel('detail');}
 function openAction(action:'identity'|'attachment'|'allocate'|'edit'|'delete'){
  if(disabled||saveLock.current||!current)return;begin();setSnapshot(structuredClone(current));
  if(action==='identity')setIdentity({identityType:current.code?'code-number':'number',number:current.number,code:current.code});
  if(action==='edit')setDraft({...current,amount:decimal(current.amount)});
  if(action==='allocate'){setRows(Object.fromEntries(invoiceExpenseIds(current).map(id=>[id,'selected'])));setExpenseQuery('');setExpenseCategory('全部');}
  setPanel(action);
 }
 function close(){if(saveLock.current)return;setPanel(null);setFile(null);setError('');setSnapshot(null);}
 function back(){if(saveLock.current)return;setFile(null);setError('');setSnapshot(null);setPanel('detail');}
 function viewExpense(id:number){if(saveLock.current)return;dialog.current?.close();close();onExpense(id);}
 function fileBusy(value:boolean){imageBusyRef.current=value;setImageBusy(value);}
 function changeRows(id:number,value:string|undefined){if(saveLock.current)return;setRows(previous=>{const next={...previous};if(value===undefined)delete next[id];else next[id]=value;return next;});setError('');}
 async function savedImage(){
  if(!file)throw new Error('请上传一张 PNG / JPEG 发票原图');
  let payload=imageCache.current.get(file);
  if(!payload){payload=imagePayload(file);imageCache.current.set(file,payload);}
  try{return await payload;}catch(e){imageCache.current.delete(file);throw e;}
 }
 async function save(event:React.FormEvent){
  event.preventDefault();if(disabled||saveLock.current||imageBusyRef.current)return;saveLock.current=true;setSaving(true);setError('');
  try{
   let body:InvoiceRequestBody;
   if(panel==='new'){const invoice=parseInvoiceDraft(draft);body={kind:'invoice',invoice,image:await savedImage()};}
   else{
    if(!snapshot)throw new Error('发票尚未加载，请重新打开详情');
    const expected={id:snapshot.id,expectedRevision:snapshot.revision};
    if(panel==='identity'){
     const value=parseInvoiceIdentity(identity);if(value.identityType==='unconfirmed')throw new Error('请选择已核对的身份类型');
     body={kind:'invoice-identity',...expected,identity:{...value,identityType:value.identityType}};
    }else if(panel==='attachment')body={kind:'invoice-attachment',...expected,image:await savedImage()};
    else if(panel==='allocate')body={kind:'invoice-link',...expected,expenseIds:validateInvoiceLinks(Object.keys(rows).map(Number),state)};
    else if(panel==='edit')body={kind:'invoice-edit',...expected,invoice:parseInvoiceDraft(draft)};
    else if(panel==='delete')body={kind:'invoice-delete',...expected};
    else throw new Error('请重新打开操作面板');
   }
   const request=invoiceRequest(body,attempts.current);if(!attempts.current.includes(request))attempts.current.push(request);
   const next=await ledgerCommand(request);onState(next);
   const nextId=body.kind==='invoice'?next.invoiceEvents?.find(event=>event.requestId===request.requestId)?.invoiceId:body.id;
   setNotice(body.kind==='invoice'?'发票已归档；资金和报销进度不变。':body.kind==='invoice-identity'?'发票身份已核对，可以关联费用。':body.kind==='invoice-attachment'?'已补充同一原票的扫描件，票面金额不变。':body.kind==='invoice-delete'?'发票已删除，资金和报销进度不变。':body.kind==='invoice-edit'?'发票修改已保存。':'发票关联已保存，资金和报销进度不变。');
   setFile(null);setSnapshot(null);setSelectedId(nextId??null);setPanel(body.kind==='invoice-delete'||nextId===undefined?null:'detail');
  }catch(e){setError((e as Error).message);}finally{saveLock.current=false;setSaving(false);}
 }
 const fieldBusy=saving||imageBusy;
 return <section className="invoice-page" aria-label="发票管理">
  <div className="invoice-page-heading"><div><h2>发票档案</h2><p>归档原票并关联已有费用，不新增支出或收付款。</p></div><button className="primary" disabled={disabled||saving} onClick={openNew}>归档发票</button></div>
  {notice&&<div className="notice" role="status">{notice}<button aria-label="关闭发票提示" onClick={()=>setNotice('')}>关闭</button></div>}
  <div className="workspace">
   <div className="invoice-filters"><label className="field"><span className="sr-only">搜索发票</span><input placeholder="搜索编号、号码、代码、销售方、购买方或备注" value={query} onChange={event=>setQuery(event.target.value)}/></label><label className="check"><input type="checkbox" checked={unallocatedOnly} onChange={event=>setUnallocatedOnly(event.target.checked)}/>仅未关联费用</label></div>
   <div className="table-scroll"><table className="invoice-table"><thead><tr><th>编号 / 身份</th><th>开票日期 / 销售方</th><th className="num">票面金额</th><th className="num">关联费用</th><th><span className="sr-only">详情</span></th></tr></thead><tbody>{listPages.items.map(invoice=>{const linked=invoiceExpenseIds(invoice);return <tr key={invoice.id}><td><button className="expense-name" onClick={()=>openDetail(invoice.id)}>{invoiceCode(invoice.id)}</button><small className="subline">{identityLabel(invoice)}</small><small className="subline">{invoice.number||'号码待核对'}</small></td><td>{invoice.date}<small className="subline">{invoice.seller||'销售方未填写'}</small></td><td className="num">¥{money(invoice.amount)}</td><td className="num">{linked.length} 笔</td><td><button className="link" aria-label={`查看发票 ${invoiceCode(invoice.id)} 详情`} onClick={()=>openDetail(invoice.id)}>详情</button></td></tr>;})}</tbody></table></div>
   {!filtered.length&&<div className="empty"><h2>{invoices.length?'没有符合条件的发票':'还没有发票档案'}</h2><p>{invoices.length?'调整搜索条件或未关联筛选。':'先上传原图并核对票面金额和日期。'}</p></div>}
   <Pagination pager={listPages} label="发票列表"/><footer className="table-footer"><span>筛选结果 {filtered.length} 张</span><span>金额单位：人民币元</span></footer>
  </div>
  <p className="help invoice-scope">当前仅支持 PNG / JPEG 原图；PDF、材料导出尚未开放；发票关联仅记录证明关系，不分配额度。</p>
  <dialog ref={dialog} className={`drawer invoice-drawer ${panel==='allocate'?'wide':''}`} aria-labelledby="invoice-panel-title" onCancel={event=>{if(saveLock.current)event.preventDefault();else close();}} onClose={()=>{if(!dialog.current?.open)setPanel(null);}}>
   <header className="drawer-header"><div><h2 id="invoice-panel-title" tabIndex={-1}>{panel==='new'?'归档发票':panel==='identity'?'核对发票身份':panel==='attachment'?'补充原票扫描件':panel==='allocate'?'编辑费用关联':panel==='edit'?'修改发票':panel==='delete'?'删除发票':'发票详情'}</h2><p>{panel==='detail'?'原图、身份和费用关联独立保存':'只保存票据及关联，不改变资金和报销进度'}</p></div><button type="button" disabled={saving} aria-label="关闭发票面板" onClick={close}>关闭</button></header>
   {panel==='detail'&&current&&<div className="invoice-detail"><div className="drawer-body">
    <p className="muted">{invoiceCode(current.id)} · {identityLabel(current)} · 修订 {current.revision}</p><h3 className="detail-merchant">{current.seller||'销售方未填写'}</h3><div className="detail-amount">{money(current.amount)}<small> 元</small></div>
    <dl className="invoice-details"><div><dt>发票号码</dt><dd>{current.number||'未填写'}</dd></div><div><dt>发票代码</dt><dd>{current.code||'未填写 / 不适用'}</dd></div><div><dt>开票日期</dt><dd>{current.date}</dd></div><div><dt>购买方</dt><dd>{current.buyer||'未填写'}</dd></div><div><dt>关联费用</dt><dd>{invoiceExpenseIds(current).length} 笔</dd></div><div><dt>归档时间</dt><dd>{new Date(current.createdAt).toLocaleString('zh-CN',{hour12:false})}</dd></div></dl>
    <p className="help">{current.note||'无备注'}</p>
    <div className="invoice-actions">{current.identityType==='unconfirmed'&&<button disabled={disabled||saving} onClick={()=>openAction('identity')}>核对身份</button>}<button className="primary" disabled={disabled||saving} onClick={()=>openAction('allocate')}>编辑费用关联</button><button disabled={disabled||saving} onClick={()=>openAction('attachment')}>补充原票扫描件</button><button disabled={disabled||saving} onClick={()=>openAction('edit')}>修改发票</button><button disabled={disabled||saving} onClick={()=>openAction('delete')}>删除发票</button></div>
    {current.identityType==='unconfirmed'&&<p className="invoice-warning">这张票的身份尚未核对，请对照原图确认号码及适用的代码。</p>}
    <section className="invoice-section" aria-label="发票关联费用"><h3>关联费用</h3>{allocationPages.items.map(expenseId=>{const expense=state.expenses.find(expense=>expense.id===expenseId);return <div className="history" key={expenseId}><div><strong>{expense?.merchant??`费用 #${expenseId}`}</strong><p>{expense?`${expense.category} · ${expense.date} · `:''}#{expenseId}</p></div><button className="link" disabled={!expense||saving} onClick={()=>viewExpense(expenseId)}>查看费用</button></div>;})}{!invoiceExpenseIds(current).length&&<p className="help">尚未关联费用。</p>}<Pagination pager={allocationPages} label="发票关联费用" disabled={saving}/></section>
    <section className="invoice-section" aria-label="发票原票扫描件"><h3>原票扫描件</h3>{attachmentPages.items.map(id=><div className="invoice-scan" key={id}><button type="button" aria-expanded={expandedAttachment===id} onClick={()=>setExpandedAttachment(expandedAttachment===id?null:id)}>{expandedAttachment===id?'收起':'查看'}原票扫描件 {current.attachmentIds.indexOf(id)+1}</button>{expandedAttachment===id&&<ExpenseAttachment id={id} kind="invoice"/>}</div>)}<Pagination pager={attachmentPages} label="发票原票扫描件" disabled={saving}/></section>
    <section className="invoice-section" aria-label="发票操作记录"><h3>操作记录</h3>{auditPages.items.map(event=><AuditEntry key={event.requestId} event={event}/>)}{!events.length&&<p className="help">暂无可显示的操作记录。</p>}<Pagination pager={auditPages} label="发票操作记录" disabled={saving}/></section>
   </div><footer className="drawer-footer"><button type="button" onClick={close}>返回发票列表</button></footer></div>}
   {(panel==='new'||panel==='identity'||panel==='attachment'||panel==='allocate'||panel==='edit'||panel==='delete')&&<form onSubmit={save}>
    <div className="drawer-body">
     {(panel==='new'||panel==='edit')&&<>
      {panel==='new'&&<ExpenseScreenshot key="new-invoice" kind="invoice" onFile={setFile} onBusy={fileBusy} disabled={saving}/>}
      <fieldset className="expense-fields" disabled={fieldBusy}><label className="field">价税合计（元）<input inputMode="decimal" required value={draft.amount} className="amount-input" onChange={event=>{setDraft({...draft,amount:event.target.value});setError('');}}/></label><label className="field">开票日期<input type="date" required value={draft.date} onChange={event=>{setDraft({...draft,date:event.target.value});setError('');}}/></label>
       <IdentityFields value={draft} onChange={value=>{setDraft({...draft,...value});setError('');}}/>
       <label className="field">销售方（选填）<input maxLength={200} value={draft.seller} onChange={event=>setDraft({...draft,seller:event.target.value})}/></label><label className="field">购买方（选填）<input maxLength={200} value={draft.buyer} onChange={event=>setDraft({...draft,buyer:event.target.value})}/></label><label className="field">备注（选填）<textarea maxLength={500} value={draft.note} onChange={event=>setDraft({...draft,note:event.target.value})}/></label>
      </fieldset><p className="invoice-warning">保存前请核对金额、日期、销售方和购买方。修改保留编号、原图和关联；不改变资金或报销金额。</p>
     </>}
     {panel==='identity'&&snapshot&&<><p className="help">{invoiceCode(snapshot.id)} · 核对后可关联费用，同一原票只能归档一次。</p><fieldset className="expense-fields" disabled={saving}><IdentityFields value={identity} onChange={value=>{setIdentity(value);setError('');}} confirmedOnly/></fieldset></>}
     {panel==='attachment'&&snapshot&&<><p className="invoice-warning">仅补充 {invoiceCode(snapshot.id)} 这张原票的扫描件。请勿上传另一张发票；补图不会改变票面金额。</p><ExpenseScreenshot key="invoice-supplement" kind="invoice" onFile={setFile} onBusy={fileBusy} disabled={saving}/></>}
     {panel==='allocate'&&snapshot&&<>
      <p className="help">勾选相关费用即可，可跨页选择。已选 {Object.keys(rows).length} 笔，不分配票面额度。</p>
      <fieldset className="expense-picker invoice-picker" disabled={saving}><legend>选择关联费用</legend><div className="picker-filters"><label className="field"><span className="sr-only">搜索发票关联费用</span><input placeholder="搜索商户、摘要、备注或费用编号" value={expenseQuery} onChange={event=>setExpenseQuery(event.target.value)}/></label><select aria-label="发票关联费用类别" value={expenseCategory} onChange={event=>setExpenseCategory(event.target.value)}>{['全部','接待','办公'].map(category=><option key={category}>{category}</option>)}</select></div>
       <div className="picker-heading"><span>跨页已选 {Object.keys(rows).length} 笔</span><button type="button" className="link" disabled={!Object.keys(rows).length} onClick={()=>{setRows({});setError('');}}>清空全部选择</button></div><p className="help">搜索或翻页保留已选费用。取消勾选会解除该费用关联；清空全部选择后保存会解除本票全部关联。</p>
       <div className="invoice-allocation-list">{pickerPages.items.map(expense=>{const checked=Object.hasOwn(rows,expense.id);return <div className="invoice-allocation-row" key={expense.id}><label><input type="checkbox" checked={checked} aria-label={`关联费用 ${expense.id} ${expense.merchant}`} onChange={()=>changeRows(expense.id,checked?undefined:'selected')}/><span><strong>{expense.merchant}</strong><small>{expense.category} · {expense.date} · #{expense.id}</small><small>支出 ¥{money(expense.amount)}</small></span></label></div>;})}</div>
       {!picker.length&&<p className="help">{state.expenses.length?'没有符合条件的费用。':'请先登记已经实际支付的费用，再关联发票。'}</p>}<Pagination pager={pickerPages} label="发票关联选择" disabled={saving}/>
      </fieldset>
     </>}
     {panel==='delete'&&snapshot&&<div className="invoice-warning">确定删除 {invoiceCode(snapshot.id)}？将移除该发票和当前费用关联，软件内不可恢复。费用、报销与资金金额不变；原图保留在审计备份中。</div>}
     {error&&<div className="error" role="alert"><p>{error}</p><p>草稿已保留。结果未确认时保持内容不变可重试；若提示记录已变化，请刷新后重新核对。</p></div>}
    </div>
    <footer className="drawer-footer"><button type="button" disabled={saving} onClick={panel==='new'?close:back}>取消</button><button type="submit" className="primary" disabled={fieldBusy}>{saving?'保存中…':panel==='new'?'确认归档发票':panel==='identity'?'确认发票身份':panel==='attachment'?'保存原票扫描件':panel==='edit'?'确认修改发票':panel==='delete'?'确认删除发票':'保存完整关联'}</button></footer>
   </form>}
  </dialog>
 </section>;
}
