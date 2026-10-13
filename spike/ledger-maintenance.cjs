const path=require('node:path'),fs=require('node:fs');
const Database=require('better-sqlite3');
const {acquireManagedLock}=require('./managed-ledger.cjs');
const usage='backup --source <managedRoot> --destination <existingParent> | verify --backup <dir> | restore --backup <dir> --target <newExactRoot>';
function parse(argv){
 const [command,...rest]=argv,commands={backup:['source','destination'],verify:['backup'],restore:['backup','target']};
 const allowed=Object.hasOwn(commands,command)?commands[command]:null;
 if(!allowed)throw Error(`请明确指定维护命令：${usage}`);
 const values={};
 for(let i=0;i<rest.length;i+=2){
  const flag=rest[i],value=rest[i+1],key=flag?.slice(2);
  if(!flag?.startsWith('--')||!allowed.includes(key)||Object.hasOwn(values,key)||typeof value!=='string'||!value.trim()||value.startsWith('--'))throw Error(`参数无效：${usage}`);
  values[key]=path.resolve(value);
 }
 if(allowed.some(key=>!values[key]))throw Error(`缺少显式目录参数：${usage}`);
 return {command,...values};
}
async function main(argv){
 const options=parse(argv),{createBackup,verifyBackup,restoreBackup}=require('./ledger-backup.cjs');
 if(options.command==='verify')return await verifyBackup(options.backup);
 if(options.command==='restore'){
  let parent=fs.realpathSync(path.dirname(options.target));
  while(true){if(fs.lstatSync(path.join(parent,'managed-ledger.json'),{throwIfNoEntry:false}))throw Error('恢复目标必须位于其他受管账本之外的新位置');const next=path.dirname(parent);if(next===parent)break;parent=next;}
  return await restoreBackup({backupDir:options.backup,targetDir:options.target});
 }
 const lock=acquireManagedLock(options.source);let db;
 try{
  if(require('./ledger-reset.cjs').readResetStatus(lock.root).pending)throw Error('清空尚未完成，禁止备份；请启动受管实例继续原请求清理');
  db=new Database(path.join(lock.root,'trial.sqlite'),{readonly:true,fileMustExist:true});
  return await createBackup({db,dataDir:lock.root,destinationParent:options.destination,ledgerId:lock.marker.ledgerId,sourceKind:'isolated-test'});
 }finally{if(db)db.close();lock.release();}
}
if(require.main===module)main(process.argv.slice(2)).then(result=>{process.stdout.write(JSON.stringify(result)+'\n');}).catch(error=>{process.stderr.write(JSON.stringify({error:error.message,...(typeof error.publishedDirectory==='string'?{publishedDirectory:error.publishedDirectory}:{}),...(typeof error.incompleteDirectory==='string'?{incompleteDirectory:error.incompleteDirectory}:{})})+'\n');process.exitCode=1;});
module.exports={main,parse};
