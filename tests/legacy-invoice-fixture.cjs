// Synthetic historical snapshot only. No retired invoice command is exposed by the application.
const fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto'),Database=require('better-sqlite3');
function seedLegacyInvoices(root,expenseId){
 const db=new Database(path.join(root,'trial.sqlite'));
 try{return db.transaction(()=>{
  const state=JSON.parse(db.prepare('SELECT json FROM trial_state WHERE id=1').get().json);
  state.expenses.find(e=>e.id===expenseId).invoice=100; // Historical marker, never an amount constraint or new reminder default.
  const attachmentId=randomUUID(),file=attachmentId+'.png',bytes=fs.readFileSync(path.join(__dirname,'../spike/fixtures/ocr-sample.png'));
  fs.writeFileSync(path.join(root,'attachments',file),bytes,{flag:'wx'});
  db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(attachmentId,file,createHash('sha256').update(bytes).digest('hex'),bytes.length,'image/png');
  const at='2026-10-13T00:00:00.000Z',initial={id:1,identityType:'number',number:'SYNTHETIC-LEGACY',code:'',date:'2026-10-13',seller:'历史合成销方',buyer:'',amount:10000,note:'旧发票只保留',attachmentIds:[attachmentId],allocations:[],revision:1,createdAt:at};
  const allocated={...initial,revision:2,allocations:[{expenseId,amount:1}]};
  const cleared={...allocated,revision:3,expenseIds:[]},linked={...cleared,revision:4,expenseIds:[expenseId]};
  state.invoices=[linked];state.invoiceEvents=[];
  for(const [action,before,after] of [['invoice',null,initial],['invoice-allocate',initial,allocated],['invoice-link',allocated,cleared],['invoice-link',cleared,linked]]){
   const requestId=randomUUID(),event={requestId,action,at,invoiceId:1,revision:after.revision,before,after};state.invoiceEvents.push(event);
   db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(requestId,createHash('sha256').update(JSON.stringify(event)).digest('hex'),action,at);
  }
  db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(JSON.stringify(state));return state;
 }).immediate();}finally{db.close();}
}
module.exports={seedLegacyInvoices};
