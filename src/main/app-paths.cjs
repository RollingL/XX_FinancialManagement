'use strict';
// Decides which folder is the program's "home" (see ledger-schema.cjs for its layout).
//
// - Windows portable package: the unzipped folder itself, next to Qianlai.exe. Data and
//   program stay together, so copying the folder moves everything.
// - Development (`npm run dev`, `npm start`): QIANLAI_HOME if set, else .local-data/.
// - Other packaged builds (development only): the folder that contains the program.
const fs = require('node:fs');
const path = require('node:path');

const PORTABLE_MARKER = 'windows-portable.json';

function portableHome(resourcesPath) {
  const marker = path.join(resourcesPath, PORTABLE_MARKER);
  let value;
  try {
    const stat = fs.lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw Error();
    value = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch {
    throw Error('离线包标识缺失或无效，请完整解压软件后重新启动');
  }
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'format,product' ||
    value.format !== 1 ||
    value.product !== 'qianlai-finance'
  )
    throw Error('离线包标识不兼容，请保留原软件与数据');
  return path.resolve(resourcesPath, '..', '..');
}

function resolveHome({ packaged, platform, resourcesPath, env, projectRoot }) {
  if (packaged && platform === 'win32')
    return { home: portableHome(resourcesPath), portable: true };
  if (env.QIANLAI_HOME !== undefined) {
    if (typeof env.QIANLAI_HOME !== 'string' || !path.isAbsolute(env.QIANLAI_HOME))
      throw Error('QIANLAI_HOME 必须是绝对路径');
    return { home: path.resolve(env.QIANLAI_HOME), portable: false };
  }
  if (!packaged) return { home: path.join(projectRoot, '.local-data'), portable: false };
  const levels = platform === 'darwin' ? ['..', '..', '..'] : ['..'];
  return { home: path.resolve(resourcesPath, ...levels), portable: false };
}

module.exports = { resolveHome, PORTABLE_MARKER };
