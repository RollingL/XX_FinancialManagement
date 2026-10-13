const {app,BrowserWindow,ipcMain,dialog}=require('electron');
const {createOcrService,MAX_BYTES}=require('./ocr-service.cjs');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {pathToFileURL}=require('node:url');
const isProbe=process.argv.includes('--probe');
const managed=process.env.XX_FINANCE_MANAGED_TRIAL==='1';
const userData=process.env.XX_FINANCE_USER_DATA_DIR,dataDir=process.env.XX_FINANCE_DATA_DIR,backupDestination=process.env.XX_FINANCE_BACKUP_DIR;
let service,ledger,closing=false,closed=false;
const pendingLedger=new Set();
function configurePaths(){
 if(managed&&(!userData||!dataDir||!path.isAbsolute(dataDir)))throw Error('原生受管试用须显式指定独立 userData 和绝对账本目录');
 if(backupDestination&&!path.isAbsolute(backupDestination))throw Error('备份目录必须为显式绝对路径');
 if(userData!==undefined){
  if(!path.isAbsolute(userData))throw Error('隔离 userData 必须为绝对路径');
  const stat=fs.lstatSync(userData);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('隔离 userData 必须为已存在的普通目录');
  const root=fs.realpathSync(userData);app.setPath('userData',root);app.setPath('sessionData',root);
  for(const name of ['logs','crashDumps']){const folder=path.join(root,name);fs.mkdirSync(folder,{recursive:true,mode:0o700});const stat=fs.lstatSync(folder);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('隔离运行目录无效');app.setPath(name,folder);}
 }
}
try{configurePaths();}catch(error){console.error(`原生启动配置无效：${error.message}`);app.exit(1);throw error;}
async function dispose(){
 service?.stop();await service?.finished;
 await Promise.allSettled([...pendingLedger]);await ledger?.close();
}
app.whenReady().then(async()=>{
 if(isProbe){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xx-finance-probe-'));
  try{
   const sqlite=await require('./sqlite-probe.cjs')(dir);
   if(sqlite?.status!=='passed')throw Error('SQLite 依赖探针未通过');
   const report={sqlite,packaged:app.isPackaged,ocr:{status:'not run'}};
   const root=app.isPackaged?process.resourcesPath:path.join(__dirname,'ocr-dist');
   const exe=path.join(root,'ocr-probe',process.platform==='win32'?'ocr-probe.exe':'ocr-probe');
   if(!fs.existsSync(exe))throw Error('缺少本地 OCR 辅助程序，依赖探针未通过');
   const fixture=app.isPackaged?path.join(process.resourcesPath,'ocr-sample.png'):path.join(__dirname,'fixtures','ocr-sample.png');
   const {stdout}=await promisify(execFile)(exe,[fixture],{timeout:60000,maxBuffer:1024*1024});report.ocr=JSON.parse(stdout);
   if(report.ocr?.status!=='passed')throw Error('OCR 依赖探针未通过');
   console.log(JSON.stringify(report,null,2));app.exit(0);
  }catch(error){console.error(error);app.exit(1);}finally{fs.rmSync(dir,{recursive:true,force:true});}return;
 }
 service=createOcrService(app.isPackaged?process.resourcesPath:undefined);
 ledger=managed?require('./managed-ledger.cjs').createManagedLedger(dataDir,service,{backupDestination}):require('./trial-ledger.cjs').createLedger(dataDir||path.join(app.getPath('userData'),'stage0-trial'),service);
 const win=new BrowserWindow({width:1400,height:920,minWidth:800,minHeight:600,title:'钱来 财务管理系统 · 本地试用',webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 const entry=path.join(__dirname,'..','dist','index.html'),entryURL=pathToFileURL(entry).href;
 const requests=new Map();
 const trusted=event=>event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame&&event.senderFrame.url===entryURL;
 ipcMain.handle('ledger:command',async(event,payload)=>{
  if(!trusted(event))throw Error('拒绝非主窗口请求');
  if(closing)throw Error('应用正在关闭，请稍后重新打开');
  const pending=Promise.resolve().then(()=>ledger.command(payload));pendingLedger.add(pending);
  try{return await pending;}catch(e){throw Error(e.status?e.message:'本地读写失败，请保留表单并重试');}finally{pendingLedger.delete(pending);}
 });
 ipcMain.handle('ocr:recognize',async(event,payload)=>{
  if(!trusted(event))throw Error('拒绝非主窗口请求');
  if(closing)throw Error('应用正在关闭，请稍后重新打开');
  if(!payload||typeof payload.id!=='string'||!/^[a-f0-9-]{36}$/.test(payload.id)||!(payload.bytes instanceof ArrayBuffer)||payload.bytes.byteLength>MAX_BYTES||requests.has(payload.id))throw Error('识别请求无效');
  const controller=new AbortController();requests.set(payload.id,controller);
  try{return await service.recognize(Buffer.from(payload.bytes),{signal:controller.signal});}
  finally{requests.delete(payload.id);}
 });
 ipcMain.on('ocr:cancel',(event,id)=>{if(trusted(event)&&typeof id==='string')requests.get(id)?.abort();});
 win.once('closed',()=>{for(const request of requests.values())request.abort();service.stop();});
 app.on('before-quit',event=>{
  if(closed)return;event.preventDefault();if(closing)return;closing=true;
  dispose().then(()=>{closed=true;app.quit();}).catch(()=>{console.error('账本未能安全关闭，保留数据和锁');dialog.showErrorBox('未能安全关闭','账本关闭未完成。数据及锁已保留，请勿删除锁或同时打开该账本。');});
 });
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 const guardNavigation=event=>{if(closing||!event.isMainFrame||event.url!==entryURL)event.preventDefault();};
 win.webContents.on('will-navigate',guardNavigation);
 win.webContents.on('will-frame-navigate',guardNavigation);
 win.webContents.on('will-redirect',guardNavigation);
 win.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 win.webContents.session.setPermissionCheckHandler(()=>false);
 await win.loadFile(entry);
}).catch(async error=>{closing=true;console.error(`本地试用启动失败：${error.message}`);try{await dispose();}catch{console.error('启动收尾未完成，保留账本及锁');}app.exit(1);});
app.on('window-all-closed',()=>app.quit());
