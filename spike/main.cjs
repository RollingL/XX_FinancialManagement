const {app,BrowserWindow,ipcMain}=require('electron');
const {createOcrService,MAX_BYTES}=require('./ocr-service.cjs');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const isProbe=process.argv.includes('--probe');
app.whenReady().then(async()=>{
 if(isProbe){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xx-finance-probe-'));
  try{
   const sqlite=await require('./sqlite-probe.cjs')(dir);
   const report={sqlite,packaged:app.isPackaged,ocr:{status:'not run'}};
   const root=app.isPackaged?process.resourcesPath:path.join(__dirname,'ocr-dist');
   const exe=path.join(root,'ocr-probe',process.platform==='win32'?'ocr-probe.exe':'ocr-probe');
   if(fs.existsSync(exe)){
    const fixture=app.isPackaged?path.join(process.resourcesPath,'ocr-sample.png'):path.join(__dirname,'fixtures','ocr-sample.png');
    const {stdout}=await promisify(execFile)(exe,[fixture],{timeout:60000,maxBuffer:1024*1024});report.ocr=JSON.parse(stdout);
   }
   console.log(JSON.stringify(report,null,2));app.exit(0);
  }catch(error){console.error(error);app.exit(1);}finally{fs.rmSync(dir,{recursive:true,force:true});}return;
 }
 const win=new BrowserWindow({width:1400,height:920,minWidth:800,minHeight:600,title:'本地报销台账 · 阶段 0',webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 const service=createOcrService(app.isPackaged?process.resourcesPath:undefined);
 const ledger=require('./trial-ledger.cjs').createLedger(process.env.XX_FINANCE_DATA_DIR||path.join(app.getPath('userData'),'stage0-trial'),service);
 const requests=new Map();
 const trusted=event=>event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame;
 ipcMain.handle('ledger:command',async(event,payload)=>{
  if(!trusted(event))throw Error('拒绝非主窗口请求');
  try{return await ledger.command(payload);}catch(e){throw Error(e.status?e.message:'本地读写失败，请保留表单并重试');}
 });
 ipcMain.handle('ocr:recognize',async(event,payload)=>{
  if(!trusted(event))throw Error('拒绝非主窗口请求');
  if(!payload||typeof payload.id!=='string'||!/^[a-f0-9-]{36}$/.test(payload.id)||!(payload.bytes instanceof ArrayBuffer)||payload.bytes.byteLength>MAX_BYTES||requests.has(payload.id))throw Error('识别请求无效');
  const controller=new AbortController();requests.set(payload.id,controller);
  try{return await service.recognize(Buffer.from(payload.bytes),{signal:controller.signal});}
  finally{requests.delete(payload.id);}
 });
 ipcMain.on('ocr:cancel',(event,id)=>{if(trusted(event)&&typeof id==='string')requests.get(id)?.abort();});
 win.once('closed',()=>{for(const request of requests.values())request.abort();service.stop();});
 let disposing=false;
 app.on('before-quit',event=>{if(disposing)return;event.preventDefault();disposing=true;service.stop();service.finished.then(()=>{ledger.close();app.quit();});});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.webContents.on('will-navigate',event=>event.preventDefault());
 win.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 await win.loadFile(path.join(__dirname,'..','dist','index.html'));
});
app.on('window-all-closed',()=>app.quit());
