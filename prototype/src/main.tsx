import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {allocate,balance,cents,decimal,money,paid,remaining,rowCents,sum,validateAllocation} from './model.ts';
import type {Category,Expense} from './model.ts';
import './style.css';
import ExpenseScreenshot,{ExpenseAttachment} from './ExpenseScreenshot.tsx';
import {ledgerCommand,imagePayload} from './ledger.ts';
import type {LedgerState} from './ledger.ts';
import {localDate as today,localDateLabel} from './local-date.ts';
import {reimbursementRows} from './reimbursement-draft.ts';
import {expenseSummary} from './expense-summary.ts';
import Pagination,{usePagination} from './Pagination.tsx';
import {matchesExpense,selectScope} from './records.ts';
import ReimbursementRecords,{BatchDetail,CancelConfirmation} from './ReimbursementRecords.tsx';
function Icon({name}:{name:'home'|'meal'|'work'|'receipt'|'wallet'|'clock'|'chart'|'plus'|'scan'|'chevron'|'bulb'|'backup'|'search'}){
 const paths={home:'M3 10 12 3l9 7v11h-6v-7H9v7H3Z',meal:'M5 3v6m4-6v6M3 3v5a4 4 0 0 0 8 0V3M7 12v9M18 3c-4 3-4 9 0 10h2V3Zm0 10v8',work:'M8 7V4h8v3M3 8h18v13H3ZM3 13h18M10 12v3h4v-3',receipt:'M5 3h14v18l-3-2-4 2-4-2-3 2ZM8 7h8M8 11h8M8 15h4',wallet:'M4 7V4h14v3M4 7h17v14H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Zm17 5h-7v5h7m-4-3.5h.1',clock:'M12 7v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',chart:'M5 20V12m7 8V4m7 16V8',plus:'M12 4v16M4 12h16',scan:'M8 3H4v4m12-4h4v4M4 17v4h4m12-4v4h-4M4 12h16',chevron:'m9 5 7 7-7 7',bulb:'M8 17c0-3-4-3-4-8a8 8 0 0 1 16 0c0 5-4 5-4 8M8 17h8m-8 3h8m-6 3h4',backup:'M7 18H5a4 4 0 0 1-1-8 7 7 0 0 1 14-2 5 5 0 0 1 1 10h-2M12 12v9m-3-3 3 3 3-3',search:'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0'};
 return <svg className="icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}
function App(){
 const [state,setState]=useState<LedgerState>({expenses:[],batches:[],advances:[]}),[category,setCategory]=useState('全部费用'),[query,setQuery]=useState(''),[status,setStatus]=useState('全部状态'),[month,setMonth]=useState(''),[missing,setMissing]=useState(false);
 const [selected,setSelected]=useState<number[]>([]),[panel,setPanel]=useState<'new'|'advance'|'advance-detail'|'reimburse'|'detail'|'batch-detail'|null>(null),[detail,setDetail]=useState<number>(1001),[notice,setNotice]=useState(''),[error,setError]=useState('');
 const [newCategory,setNewCategory]=useState<Category>('接待'),[date,setDate]=useState(today),[merchant,setMerchant]=useState(''),[amount,setAmount]=useState(''),[note,setNote]=useState('');
 const [total,setTotal]=useState(''),[rows,setRows]=useState<Record<number,string>>({}),[batchDate,setBatchDate]=useState(today),[saving,setSaving]=useState(false),[cancelId,setCancelId]=useState<number|null>(null);
 const [attachment,setAttachment]=useState<File|null>(null),[ocrBusy,setOcrBusy]=useState(false),[loaded,setLoaded]=useState(false);
 const [pickerQuery,setPickerQuery]=useState(''),[pickerCategory,setPickerCategory]=useState('全部');
 const [currentDay,setCurrentDay]=useState(today);
 const [batchAction,setBatchAction]=useState<{id:number;kind:'delete-batch'}|null>(null);
 const [batchDetailId,setBatchDetailId]=useState<number|null>(null),[returnBatchId,setReturnBatchId]=useState<number|null>(null);
 useEffect(()=>{
  const preventFileNavigation=(event:DragEvent)=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();};
  window.addEventListener('dragover',preventFileNavigation);window.addEventListener('drop',preventFileNavigation);
  return ()=>{window.removeEventListener('dragover',preventFileNavigation);window.removeEventListener('drop',preventFileNavigation);};
 },[]);
 useEffect(()=>{
  const refresh=()=>setCurrentDay(today());
  const timer=window.setInterval(refresh,60_000);
  window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
  return ()=>{window.clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
 },[]);
 const requestId=useRef(crypto.randomUUID());
 useEffect(()=>{ledgerCommand({kind:'read'}).then(value=>{setState(value);setLoaded(true);}).catch(e=>setNotice(`账本未加载：${e.message}。请重新启动服务后刷新。`));},[]);
 const dialog=useRef<HTMLDialogElement>(null),saveLock=useRef(false);
 const {expenses,batches,advances}=state,bal=balance(expenses,advances),outstanding=sum(expenses.map(e=>remaining(e,batches)));
 const label=(e:Expense)=>paid(e.id,batches)===0?'未报销':remaining(e,batches)===0?'已报销':'部分报销';
 const visible=expenses.filter(e=>(category==='全部费用'||e.category===category)&&matchesExpense(e,query)&&(!month||e.date.startsWith(month))&&(status==='全部状态'||label(e)===status)&&(!missing||e.invoice<e.amount));
 const isOverview=category==='全部费用',isAdvances=category==='预支',isBatches=category==='报销记录';
 const chosen=expenses.filter(e=>Object.hasOwn(rows,e.id)),chosenRemaining=sum(chosen.map(e=>remaining(e,batches)));
 const listChosenRemaining=sum(expenses.filter(e=>selected.includes(e.id)).map(e=>remaining(e,batches)));
 useEffect(()=>{if(panel){dialog.current?.showModal();if(panel==='new'||panel==='advance')dialog.current?.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.focus();else dialog.current?.querySelector<HTMLHeadingElement>('#panel-title')?.focus();}else dialog.current?.close();},[panel]);
 function close(){if(saveLock.current)return;setOcrBusy(false);setAttachment(null);setPanel(null);setError('');setCancelId(null);setBatchAction(null);}
 function toggle(id:number){setSelected(s=>s.includes(id)?s.filter(x=>x!==id):[...s,id]);}
 function openNew(){requestId.current=crypto.randomUUID();setAttachment(null);setOcrBusy(false);setNewCategory(category==='办公'?'办公':'接待');setDate(today());setMerchant('');setAmount('');setNote('');setError('');setPanel('new');}
 function openAdvance(){requestId.current=crypto.randomUUID();setOcrBusy(false);setAttachment(null);setDate(today());setAmount('');setNote('');setError('');setPanel('advance');}
 async function saveAdvance(event:React.FormEvent){event.preventDefault();if(saveLock.current||ocrBusy)return;try{
  const value=cents(amount);sum([...advances,value]);if(!date)throw new Error('请选择实际到账日期');
  saveLock.current=true;setSaving(true);
  const next=await ledgerCommand({kind:'advance',requestId:requestId.current,advance:{date,amount:value,note},...(attachment?{image:await imagePayload(attachment)}:{})});
  setState(next);setNotice(`已登记预支到账 ${money(value)} 元；费用报销进度未改变。`);saveLock.current=false;close();
 }catch(e){setError((e as Error).message);}finally{saveLock.current=false;setSaving(false);}}
 function suggest(value:string,items=chosen){setTotal(value);try{const result=allocate(cents(value),items,batches);setRows(Object.fromEntries(items.map(e=>[e.id,decimal(result.find(a=>a.expenseId===e.id)?.amount||0)])));setError('');}catch(e){setError((e as Error).message);}}
 function setBatchSelection(ids:number[],previous=rows){
  const next=reimbursementRows(expenses,batches,ids,previous);setRows(next);
  try{setTotal(Object.keys(next).length?decimal(sum(Object.values(next).map(rowCents))):'');setError('');}catch(e){setTotal('');setError((e as Error).message);}
 }
 function openReimburse(ids:number[]=[]){setPickerQuery('');setPickerCategory(category==='接待'||category==='办公'?category:'全部');requestId.current=crypto.randomUUID();setBatchDate(today());setBatchSelection(ids,{});setPanel('reimburse');}
 function openDetail(id:number,fromBatch:number|null=null){setReturnBatchId(fromBatch);setBatchAction(null);setCancelId(null);setDetail(id);setError('');setPanel('detail');}
 function openBatchDetail(id:number){if(saveLock.current)return;setBatchDetailId(id);setBatchAction(null);setCancelId(null);setError('');setPanel('batch-detail');}
 function askCancel(id:number){if(saveLock.current)return;requestId.current=crypto.randomUUID();setBatchAction(null);setError('');setCancelId(id);}
 function askBatchAction(id:number,kind:'delete-batch'){if(saveLock.current)return;requestId.current=crypto.randomUUID();setCancelId(null);setError('');setBatchAction({id,kind});}
 function keepBatchAction(){if(saveLock.current)return;setBatchAction(null);setError('');}
 async function runBatchAction(){if(saveLock.current||!batchAction)return;saveLock.current=true;setSaving(true);setError('');try{setState(await ledgerCommand({...batchAction,requestId:requestId.current}));setNotice('报销批次已删除，相关核销已撤销；资金余额未改变。');setBatchAction(null);setPanel(null);setBatchDetailId(null);}catch(e){setError((e as Error).message);}finally{saveLock.current=false;setSaving(false);}}
 function keepBatch(){if(saveLock.current)return;setCancelId(null);setError('');}
 function changeRow(id:number,value:string){const next={...rows,[id]:value};setRows(next);try{const amounts=chosen.map(e=>rowCents(next[e.id]||''));setTotal(decimal(sum(amounts)));setError('');}catch(e){setTotal('');setError((e as Error).message);}}
 async function saveExpense(event:React.FormEvent){event.preventDefault();if(saveLock.current||ocrBusy)return;try{
  const value=cents(amount);if(!merchant.trim()||!date)throw new Error('请填写商户或采购摘要，并确认日期');sum([...expenses.map(e=>e.amount),value]);
  saveLock.current=true;setSaving(true);
  const next=await ledgerCommand({kind:'expense',requestId:requestId.current,expense:{date,category:newCategory,merchant:merchant.trim(),amount:value,note},...(attachment?{image:await imagePayload(attachment)}:{})});
  setState(next);setNotice('费用已保存到本地试用账本'+(attachment?'，支付截图已作为附件保留。':'。'));saveLock.current=false;close();
 }catch(e){setError((e as Error).message);}finally{saveLock.current=false;setSaving(false);}}
 async function saveBatch(event:React.FormEvent){event.preventDefault();if(saveLock.current)return;try{
  if(error)throw new Error(error);if(!batchDate)throw new Error('请选择报销日期');
  const allocations=chosen.flatMap(e=>rowCents(rows[e.id]||'')===0?[]:[{expenseId:e.id,amount:rowCents(rows[e.id])}]);
  const valid=validateAllocation(allocations,chosen,batches);if(valid!==cents(total))throw new Error('总额与逐行分配不一致，请重新核对');
  saveLock.current=true;setSaving(true);const next=await ledgerCommand({kind:'batch',requestId:requestId.current,date:batchDate,allocations});
  setState(next);setNotice(`已登记报销 ${money(valid)} 元；资金余额未改变。`);setSelected([]);saveLock.current=false;close();
 }catch(e){setError((e as Error).message);}finally{saveLock.current=false;setSaving(false);}}
 async function cancelBatch(){if(saveLock.current||cancelId===null)return;saveLock.current=true;setSaving(true);setError('');try{setState(await ledgerCommand({kind:'cancel',requestId:requestId.current,id:cancelId}));setCancelId(null);setNotice('报销批次已撤销，资金余额未改变。');}catch(e){setError((e as Error).message);}finally{saveLock.current=false;setSaving(false);}}
 const current=expenses.find(e=>e.id===detail),currentBatch=batches.find(b=>b.id===batchDetailId);
 let after:number|null=null;try{if(amount)after=sum([bal,-cents(amount)]);}catch{}
 let afterAdvance:number|null=null;try{if(amount)afterAdvance=sum([sum([...advances,cents(amount)]),-sum(expenses.map(e=>e.amount))]);}catch{}
 const spending=expenseSummary(expenses);
 const pending=expenses.filter(e=>remaining(e,batches)>0),uncovered=expenses.filter(e=>e.invoice<e.amount);
 const expensePages=usePagination(visible,JSON.stringify([category,query,status,month,missing]));
 const pagePending=expensePages.items.filter(e=>remaining(e,batches)>0).map(e=>e.id);
 const advancePages=usePagination(advances.map((value,index)=>({value,index})).reverse(),category);
 const pickerFiltered=expenses.filter(e=>(pickerCategory==='全部'||e.category===pickerCategory)&&matchesExpense(e,pickerQuery));
 const pickerPending=pickerFiltered.filter(e=>remaining(e,batches)>0).map(e=>e.id);
 const pickerPages=usePagination(pickerFiltered,JSON.stringify([panel,pickerQuery,pickerCategory]));
 const allocationPages=usePagination(chosen,String(panel));
 const history=batches.filter(b=>b.allocations.some(a=>a.expenseId===detail));
 const historyPages=usePagination(history,String(detail));
 const currentAdvance=state.advanceDetails?.[detail];
 const spendingCategory=category==='接待'||category==='办公'?category:null;


 return <div className="app">
  <aside className="sidebar">
   <div className="brand">钱来<small>财务管理系统</small></div>
   <nav aria-label="主导航">{(['全部费用','接待','办公'] as const).map(n=><button key={n} aria-current={category===n?'page':undefined} className={category===n?'active':''} onClick={()=>{setCategory(n);setSelected([]);}}><Icon name={n==='全部费用'?'home':n==='接待'?'meal':'work'}/><span>{n==='全部费用'?'总览':`${n}费用`}</span></button>)}
    <button aria-current={isBatches?'page':undefined} className={isBatches?'active':''} onClick={()=>{setCategory('报销记录');setSelected([]);}}><Icon name="receipt"/><span>报销记录</span></button><button aria-current={isAdvances?'page':undefined} className={isAdvances?'active':''} onClick={()=>{setCategory('预支');setSelected([]);}}><Icon name="wallet"/><span>预支</span></button><button disabled><Icon name="receipt"/><span>发票</span><small>未开放</small></button>
   </nav>
   <div className="sidebar-bottom"><button disabled><Icon name="backup"/><span>备份</span><small>未开放</small></button><p><span className="dot"/>本地试用账本<small>阶段 0 · Windows 未验证</small></p></div>
  </aside>
  <main>
   <header className="page-header"><div><h1>{isOverview?'你好，小徐同学':isAdvances?'预支到账':isBatches?'报销记录':`${category}费用`}</h1><p><time dateTime={currentDay}>{localDateLabel(currentDay)}</time></p></div><div className="header-actions">{isAdvances?<button className="primary" disabled={!loaded} onClick={openAdvance}><Icon name="plus"/>登记预支到账</button>:isBatches?<button className="primary" disabled={!loaded} onClick={()=>openReimburse()}><Icon name="receipt"/>登记报销</button>:<><button className="primary" disabled={!loaded} onClick={()=>openNew()}><Icon name="plus"/>新增费用</button><button disabled={!loaded} onClick={()=>openReimburse()}><Icon name="receipt"/>登记报销</button></>}</div></header>
   <section className="summary" aria-label="资金与费用统计">
    <div className="summary-card balance-card"><div className="metric"><span className="icon-disc"><Icon name="wallet"/></span><div><h2>预支资金余额 <small>全账本</small></h2><strong>{bal<0?'−':''}<span className="currency">¥</span>{money(Math.abs(bal))}</strong>{bal<0&&<p>本人垫付 ¥{money(-bal)}</p>}</div></div></div>
    <div className="summary-card"><div className="metric"><span className="icon-disc mint"><Icon name="chart"/></span><div><h2>{spendingCategory?`${spendingCategory}费用支出`:'总费用支出'} <small>全部时间</small></h2><strong><span className="currency">¥</span>{money(spendingCategory?spending.byCategory[spendingCategory]:spending.total)}</strong></div></div></div>
    <div className="summary-card"><div className="metric"><span className="icon-disc peach"><Icon name="clock"/></span><div><h2>待报销 <small>报账进度</small></h2><strong><span className="currency">¥</span>{money(outstanding)}</strong></div></div></div>
   </section>
   {notice&&<div className="notice" role="status">{notice}<button aria-label="关闭提示" onClick={()=>setNotice('')}>关闭</button></div>}
   {isBatches?<ReimbursementRecords batches={batches} expenses={expenses} onOpen={openBatchDetail}/>:isAdvances?<section className="workspace advance-workspace" aria-label="预支到账记录">
    <div className="workspace-heading"><h2>到账记录</h2><span>{advances.length} 笔</span></div>
    <p className="advance-help">只登记公司已经实际拨入的款项；每笔到账增加同一资金余额，不自动核销费用。</p>
    <div className="table-scroll"><table className="advance-table"><thead><tr><th>编号 / 到账日期</th><th className="num">到账金额</th><th>备注</th><th>记录时间</th><th>到账截图</th></tr></thead><tbody>{advancePages.items.map(({value,index})=>{const info=state.advanceDetails?.[index];return <tr key={index}><td><strong>YZ-{String(index+1).padStart(3,'0')}</strong><small className="subline">{info?.date??'日期未记录'}</small></td><td className="num">+¥{money(value)}</td><td className="advance-note">{info?info.note||'—':'旧记录，仅保留原金额'}</td><td className="muted">{info?.createdAt?new Date(info.createdAt).toLocaleString('zh-CN',{hour12:false}):'未记录'}</td><td>{info?.attachmentId?<button className="link" aria-label={`查看预支 ${index+1} 到账截图`} onClick={()=>{setDetail(index);setError('');setPanel('advance-detail');}}>查看截图</button>:<span className="muted">未附截图</span>}</td></tr>;})}</tbody></table>{!advances.length&&<div className="empty"><span className="icon-disc"><Icon name="wallet"/></span><h2>还没有预支到账</h2><p>公司实际拨款后，再登记金额和到账日期。</p><button disabled={!loaded} onClick={openAdvance}>登记预支到账</button></div>}</div>
    <Pagination pager={advancePages} label="预支到账"/><footer className="table-footer"><span>累计预支 <b>¥{money(sum(advances))}</b></span><span>人民币元</span></footer>
    <p className="advance-help">当前支持新增与查看；可选保留到账截图，纠错、作废、退还尚未开放。旧记录缺失的日期不会补填为今天。</p>
   </section>:<div className="content-grid">
    <section className="workspace" aria-label="费用列表">
     <div className="workspace-heading"><h2>{category==='全部费用'?'费用记录':`${category}记录`}</h2><span>{visible.length} 笔</span></div>
     <div className="filters"><label className="search"><Icon name="search"/><span className="sr-only">搜索商户或摘要</span><input placeholder="搜索商户或摘要" value={query} onChange={e=>setQuery(e.target.value)}/></label><label><span className="sr-only">月份</span><input aria-label="月份" type="month" value={month} onChange={e=>setMonth(e.target.value)}/></label><select aria-label="报销状态筛选" value={status} onChange={e=>setStatus(e.target.value)}>{['全部状态','未报销','部分报销','已报销'].map(x=><option key={x}>{x}</option>)}</select><label className="check"><input type="checkbox" checked={missing} onChange={e=>setMissing(e.target.checked)}/>缺发票</label>{(query||month||status!=='全部状态'||missing)&&<button className="link" onClick={()=>{setQuery('');setMonth('');setStatus('全部状态');setMissing(false);}}>清除筛选</button>}</div>
     <div className="table-scroll"><table className={`expense-table ${isOverview?'overview-table':''}`}><thead><tr>{!isOverview&&<th className="check-cell"><input type="checkbox" aria-label="选择本页待报销费用" checked={pagePending.length>0&&pagePending.every(id=>selected.includes(id))} disabled={!pagePending.length} onChange={ev=>setSelected(selectScope(selected,pagePending,ev.target.checked))}/></th>}<th>费用</th><th className="num">支出金额</th><th>报销进度</th><th><span className="sr-only">详情</span></th></tr></thead><tbody>{expensePages.items.map(e=><tr key={e.id} className={!isOverview&&selected.includes(e.id)?'selected':''} onClick={event=>{if(isOverview&&!(event.target as Element).closest('button,input,label,a,select,textarea'))openDetail(e.id);}}>{!isOverview&&<td><input aria-label={`选择费用 ${e.id}`} type="checkbox" checked={selected.includes(e.id)} disabled={remaining(e,batches)===0} onChange={()=>toggle(e.id)}/></td>}<td><div className="expense-info"><span className={`icon-disc ${e.category==='办公'?'blue':''}`}><Icon name={e.category==='办公'?'work':'meal'}/></span><div><button className="expense-name" onClick={()=>openDetail(e.id)}>{e.merchant}</button><small className="subline">{e.date} · {e.category} · #{e.id}</small></div></div></td><td className="num amount">¥{money(e.amount)}<small className="subline invoice-warning">{e.invoice===0?'无发票':e.invoice<e.amount?'票额不足':'票额已覆盖'}</small></td><td><span className={`status ${label(e)==='已报销'?'done':label(e)==='部分报销'?'partial':''}`}>{label(e)}</span><small className="subline">待 ¥{money(remaining(e,batches))} · 已 ¥{money(paid(e.id,batches))}</small></td><td><button className="row-detail" aria-label={`查看费用 ${e.id} 详情`} onClick={()=>openDetail(e.id)}><Icon name="chevron"/></button></td></tr>)}</tbody></table>{!visible.length&&<div className="empty"><span className="icon-disc"><Icon name="receipt"/></span><h2>{expenses.length?'没有符合条件的费用':'从第一笔费用开始'}</h2><p>{expenses.length?'调整筛选条件，或记录一笔新费用。':'手动录入，或上传支付截图辅助填写。'}</p><button disabled={!loaded} onClick={()=>openNew()}>新增费用</button></div>}</div>
     <Pagination pager={expensePages} label="费用列表"/><footer className="table-footer"><span>筛选结果 {visible.length} 笔 · 支出合计 <b>¥{money(sum(visible.map(e=>e.amount)))}</b></span><span>人民币元</span></footer>
     {!isOverview&&<div className="selection-bar"><span>{selected.length?<>已选 <b>{selected.length}</b> 笔 · 待报销 <b>¥{money(listChosenRemaining)}</b></>:'勾选费用，可合并登记报销'}</span><div>{selected.length>0&&<button onClick={()=>setSelected([])}>取消选择</button>}<button className="primary" disabled={!selected.length||listChosenRemaining===0} onClick={()=>openReimburse(selected)}>登记报销</button></div></div>}
    </section>
    <aside className="tasks" aria-label="待处理"><h2>待处理</h2><div className="task-item"><span className="icon-disc"><Icon name="receipt"/></span><div><h3>{pending.length} 笔费用待报销</h3><p>其中 {pending.filter(e=>paid(e.id,batches)>0).length} 笔部分报销</p><button className="soft-button" disabled={!pending.length} onClick={()=>openReimburse()}>选择费用并登记 <span aria-hidden="true">→</span></button><small>在报销面板中选择费用及金额</small></div></div><div className="task-item"><span className="icon-disc rose"><Icon name="receipt"/></span><div><h3>{uncovered.length} 笔费用缺发票</h3><ul>{uncovered.slice(0,2).map(e=><li key={e.id}>{e.merchant}</li>)}</ul><button className="soft-button" disabled>补充发票 · 未开放</button></div></div><div className="rule"><Icon name="bulb"/><div><h3>资金与报销分开记录</h3><p>公司到账统一记预支，报销只更新报账进度，不增加余额。</p></div></div></aside>
   </div>}
   <p className="prototype-note">阶段 0 · 本地试用 · 保存后保留。预支纠错／退还、发票与完整备份尚未开放；Windows 未验证。</p>
  </main>
  <dialog ref={dialog} className={`drawer ${panel==='reimburse'||panel==='batch-detail'?'wide':''}`} onCancel={e=>{if(saveLock.current)e.preventDefault();else close();}} onClose={()=>{if(!dialog.current?.open)setPanel(null);}} aria-labelledby="panel-title">
   <header className="drawer-header"><div><h2 id="panel-title" tabIndex={-1}>{panel==='new'?'记一笔费用':panel==='advance'?'登记预支到账':panel==='reimburse'?'登记报销':panel==='advance-detail'?'预支到账详情':panel==='batch-detail'?'报销批次详情':'费用详情'}</h2><p>{panel==='new'?'只记录已经实际支付的费用':panel==='advance'?'记录公司实际拨款，不自动核销费用':panel==='reimburse'?'仅登记报账进度，不产生收付款':panel==='advance-detail'?'查看实际拨款及其凭证':panel==='batch-detail'?'仅登记报账进度，不产生收付款':'查看支出事实与独立的报销记录'}</p></div><button aria-label="关闭面板" onClick={close}>关闭</button></header>
   {panel==='advance'&&<form onSubmit={saveAdvance}><div className="drawer-body"><ExpenseScreenshot kind="advance" onFile={setAttachment} onBusy={setOcrBusy} disabled={saving}/><fieldset className="expense-fields" disabled={saving||ocrBusy}>
    <label className="field">实际到账金额（元）<input inputMode="decimal" placeholder="0.00" value={amount} onChange={e=>{setAmount(e.target.value);setError('');}} required className="amount-input"/></label>
    <label className="field">实际到账日期<input type="date" required value={date} onChange={e=>{setDate(e.target.value);setError('');}}/></label>
    <label className="field">备注（选填）<textarea value={note} maxLength={500} placeholder="例如：公司补充业务资金" onChange={e=>setNote(e.target.value)}/></label>
    <div className="calculation"><span>登记后资金余额</span><strong>{afterAdvance===null?'填写有效金额后计算':`${money(afterAdvance)} 元`}</strong>{afterAdvance!==null&&afterAdvance<0&&<small>本人垫付 {money(-afterAdvance)} 元</small>}</div>
    </fieldset><p className="help">仅保存本地到账记录，不发起转账。请核对金额与日期；本阶段暂不支持修改或删除已保存的预支。</p>{error&&<p role="alert" className="error">{error}</p>}</div><footer className="drawer-footer"><button type="button" onClick={close}>取消</button><button type="submit" className="primary" disabled={saving||ocrBusy}>{saving?'保存中…':'确认登记到账'}</button></footer></form>}
   {panel==='new'&&<form onSubmit={saveExpense}><div className="drawer-body"><ExpenseScreenshot onFile={setAttachment} onFields={fields=>{setAmount(fields.amount);setDate(fields.date);setMerchant(fields.merchant);}} onBusy={setOcrBusy} disabled={saving}/><fieldset className="expense-fields" disabled={saving||ocrBusy}><div className="segmented" role="group" aria-label="费用类别">{(['接待','办公'] as const).map(c=><button key={c} type="button" aria-pressed={newCategory===c} className={newCategory===c?'active':''} onClick={()=>setNewCategory(c)}>{c}费用</button>)}</div><label className="field">实际支出金额（元）<input inputMode="decimal" placeholder="0.00" value={amount} onChange={e=>setAmount(e.target.value)} required className="amount-input"/></label><label className="field">实际支出日期<input type="date" required value={date} onChange={e=>setDate(e.target.value)}/></label><label className="field">{newCategory==='接待'?'商户':'采购摘要'}<input required maxLength={100} placeholder={newCategory==='接待'?'例如：青禾餐厅':'例如：打印纸及墨盒'} value={merchant} onChange={e=>setMerchant(e.target.value)}/></label><details><summary>补充备注</summary><label className="field"><span className="sr-only">备注</span><textarea value={note} maxLength={500} onChange={e=>setNote(e.target.value)}/></label></details>{newCategory==='办公'&&<p className="help">当前演示“摘要＋总额”录入；物品明细在阶段 1 实现。</p>}<div className="calculation"><span>保存后资金余额</span><strong>{after===null?'填写金额后计算':`${money(after)} 元`}</strong>{after!==null&&after<0&&<small>本人垫付 {money(-after)} 元，允许继续登记。</small>}</div></fieldset><p className="help">请确认金额、日期和商户。截图仅作为支付凭证，不自动视为发票；取消不会保存。</p>{error&&<p role="alert" className="error">{error}</p>}</div><footer className="drawer-footer"><button type="button" onClick={close}>取消</button><button className="primary" disabled={saving||ocrBusy} type="submit">{saving?'保存中…':'确认并保存费用'}</button></footer></form>}
   {panel==='reimburse'&&<form onSubmit={saveBatch}>
    <div className="drawer-body">
     <fieldset className="expense-picker" disabled={saving}>
      <legend>1. 选择费用</legend>
      <div className="picker-filters"><label className="search"><Icon name="search"/><span className="sr-only">搜索报销费用</span><input placeholder="搜索商户、摘要或备注" value={pickerQuery} onChange={e=>setPickerQuery(e.target.value)}/></label><select aria-label="报销费用类别" value={pickerCategory} onChange={e=>setPickerCategory(e.target.value)}>{['全部','接待','办公'].map(c=><option key={c} value={c}>{c==='全部'?'全部类别':c}</option>)}</select></div>
      <div className="picker-heading"><span>跨页已选 {chosen.length} 笔 · 可登记 ¥{money(chosenRemaining)}</span><div><button type="button" className="link" disabled={!pickerPending.length} onClick={()=>setBatchSelection(selectScope(chosen.map(e=>e.id),pickerPending,true))}>全选筛选结果（{pickerPending.length} 笔）</button><button type="button" className="link" disabled={!chosen.length} onClick={()=>setBatchSelection([])}>清空全部选择</button></div></div>
      <p className="help">全选包含当前搜索和类别下的所有页；翻页或更改筛选不会清除已选费用。</p>
      <div className="picker-list">{pickerPages.items.map(e=>{const rest=remaining(e,batches),checked=Object.hasOwn(rows,e.id);return <label key={e.id} className={`picker-option ${checked?'selected':''} ${rest===0?'unavailable':''}`}><input type="checkbox" aria-label={`报销选择费用 ${e.id} ${e.merchant}`} checked={checked} disabled={rest===0} onChange={()=>setBatchSelection(checked?chosen.filter(x=>x.id!==e.id).map(x=>x.id):[...chosen.map(x=>x.id),e.id])}/><span className="picker-name">{e.merchant}<small>{e.date} · {e.category}</small></span><span className="picker-remaining">{rest===0?'已全部报销':`待报销 ¥${money(rest)}`}</span></label>;})}{!pickerFiltered.length&&<p className="help">{expenses.length?'没有匹配的费用，请调整搜索或类别。':'账本中还没有费用，请先记录实际支出。'}</p>}</div><Pagination pager={pickerPages} label="报销选择" disabled={saving}/>
      {!pending.length&&expenses.length>0&&<p className="help">所有费用已全部报销，没有可登记的剩余额度。</p>}
     </fieldset>
     <h3 className="allocation-step">2. 填写分配金额</h3>
     {!chosen.length?<p className="help selection-help">先在上方选择一笔或多笔待报销费用，再填写本次金额。</p>:<>
      <div className="form-row"><label className="field">报销日期<input type="date" disabled={saving} value={batchDate} onChange={e=>setBatchDate(e.target.value)} required/></label><label className="field">本次报销登记金额（元）<input inputMode="decimal" disabled={saving} value={total} onChange={e=>suggest(e.target.value)} required/></label></div>
      <p className="help">新增选择默认填入该费用的剩余额度，其他行已填金额保留。改总额按费用日期从早到晚分配；改逐行金额则同步总额。</p>
      <div className="table-scroll"><table className="allocation"><thead><tr><th>费用 / 原额</th><th className="num">此前已报销</th><th className="num">当前待报销</th><th className="num">本次分配</th><th className="num">登记后剩余</th></tr></thead><tbody>{allocationPages.items.map(e=>{let n=0;try{n=rowCents(rows[e.id]||'');}catch{}return <tr key={e.id}><td>{e.merchant}<small className="subline">{e.category} · {money(e.amount)} 元</small></td><td className="num">{money(paid(e.id,batches))}</td><td className="num">{money(remaining(e,batches))}</td><td><input disabled={saving} aria-label={`${e.merchant}本次分配`} inputMode="decimal" value={rows[e.id]||''} onChange={ev=>changeRow(e.id,ev.target.value)}/></td><td className="num">{money(remaining(e,batches)-n)}</td></tr>})}</tbody></table></div><Pagination pager={allocationPages} label="报销分配" disabled={saving}/>
     </>}
     {error&&<p role="alert" className="error">{error}</p>}
    </div>
    <footer className="drawer-footer"><span>合计 <b>{total||'—'}</b> 元</span><button type="button" onClick={close}>取消</button><button className="primary" type="submit" disabled={saving||!!error||!chosen.length}>{saving?'保存中…':'确认登记'}</button></footer>
   </form>}
   {panel==='advance-detail'&&currentAdvance?.attachmentId&&<div><div className="drawer-body"><h3>YZ-{String(detail+1).padStart(3,'0')} · ¥{money(advances[detail])}</h3><p className="help">到账日期 {currentAdvance.date} · {currentAdvance.note||'无备注'}</p><ExpenseAttachment key={currentAdvance.attachmentId} id={currentAdvance.attachmentId} kind="advance"/></div><footer className="drawer-footer"><button onClick={close}>返回记录</button></footer></div>}
   {panel==='batch-detail'&&currentBatch&&<BatchDetail batch={currentBatch} batches={batches} expenses={expenses} onExpense={id=>openDetail(id,currentBatch.id)} onAskCancel={()=>askCancel(currentBatch.id)} onClose={close} cancelId={cancelId} onKeep={keepBatch} onConfirm={()=>void cancelBatch()} saving={saving} error={error} deleting={batchAction?.id===currentBatch.id} onAskDelete={()=>askBatchAction(currentBatch.id,'delete-batch')} onKeepDelete={keepBatchAction} onConfirmDelete={()=>void runBatchAction()}/>}
   {panel==='detail'&&current&&<div><div className="drawer-body"><span className="muted">{current.category}费用 · #{current.id}</span><h3 className="detail-merchant">{current.merchant}</h3><div className="detail-amount">{money(current.amount)}<small> 元</small></div><dl><div><dt>实际付款日期</dt><dd>{current.date}</dd></div><div><dt>已报销</dt><dd>{money(paid(current.id,batches))} 元</dd></div><div><dt>待报销</dt><dd>{money(remaining(current,batches))} 元</dd></div><div><dt>已关联票额</dt><dd>{money(current.invoice)} 元</dd></div></dl><p className="help">{current.note}</p>{current.attachmentId&&<ExpenseAttachment key={current.attachmentId} id={current.attachmentId}/>}<h3>报销历史</h3>{historyPages.items.map(b=><div className="history" key={b.id}><div><strong>BX-{String(b.id).padStart(3,'0')} <small>{b.active?'有效':'已撤销'}</small></strong><p>{b.date} · 本费用分配 {money(b.allocations.find(a=>a.expenseId===current.id)!.amount)} 元</p></div>{b.active&&<button className="link" disabled={saving} onClick={()=>askCancel(b.id)}>撤销整批</button>}</div>)}<Pagination pager={historyPages} label="报销历史" disabled={saving}/>{!history.length&&<p className="help">暂无报销分配记录。</p>}{cancelId!==null&&<CancelConfirmation id={cancelId} saving={saving} onKeep={keepBatch} onConfirm={()=>void cancelBatch()}/>}{error&&<p role="alert" className="error">{error}</p>}<p className="help">原型不提供直接修改“已报销”状态。发票文件及关联将在后续阶段实现。</p></div><footer className="drawer-footer">{returnBatchId!==null&&<button disabled={saving} onClick={()=>openBatchDetail(returnBatchId)}>返回报销批次</button>}<button onClick={close}>返回列表</button></footer></div>}
  </dialog>
 </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
