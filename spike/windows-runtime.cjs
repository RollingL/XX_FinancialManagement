const fs=require('node:fs'),path=require('node:path');
function directory(folder){
 if(!fs.existsSync(folder))fs.mkdirSync(folder,{mode:0o700});
 const stat=fs.lstatSync(folder);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('数据路径必须为普通本地目录，请保留现有文件');
}
function configureWindowsPortable({packaged,platform,resourcesPath,env,probe=false}){
 if(!packaged||platform!=='win32'||probe||env.XX_FINANCE_USER_DATA_DIR!==undefined)return null;
 const marker=path.join(resourcesPath,'windows-portable.json');
 let value;try{const stat=fs.lstatSync(marker);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Error();value=JSON.parse(fs.readFileSync(marker,'utf8'));}catch{throw Error('离线包标识缺失或无效，请完整解压软件后重新启动');}
 if(!value||Object.keys(value).sort().join(',')!=='format,product'||value.format!==1||value.product!=='qianlai-finance')throw Error('离线包标识不兼容，请保留原软件与数据');
 const root=path.resolve(resourcesPath,'../..'),data=path.join(root,'trial-data'),identity=path.join(data,'trial-marker.txt');
 directory(root);
 if(fs.existsSync(data)){
  directory(data);let existing;
  try{const stat=fs.lstatSync(identity);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256)throw Error();existing=fs.readFileSync(identity,'utf8').trim();}catch{throw Error('已有数据目录缺少有效标识，未覆盖或接管数据');}
  // Build identity identifies an old installation, not ownership of new program versions.
  if(existing!=='qianlai-data-v1'&&!/^qianlai-[a-f0-9]{40}-\d+$/.test(existing))throw Error('已有数据目录标识不兼容，未覆盖或接管数据');
 }else{fs.mkdirSync(data,{mode:0o700});fs.writeFileSync(identity,'qianlai-data-v1\n',{flag:'wx',mode:0o600});}
 const user=path.join(data,'user-data'),backups=path.join(root,'backups');directory(user);directory(backups);
 Object.assign(env,{XX_FINANCE_MANAGED_TRIAL:'1',XX_FINANCE_USER_DATA_DIR:user,XX_FINANCE_DATA_DIR:path.join(user,'stage0-trial'),XX_FINANCE_BACKUP_DIR:backups});
 return {root,launcher:path.join(root,'Qianlai.exe'),allowLegacyRecovery:true};
}
module.exports={configureWindowsPortable};
