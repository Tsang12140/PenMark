// 在没有 Visual Studio C++ Build Tools 的机器上可靠切换 better-sqlite3 ABI。
// 打包/运行桌面版前安装官方 Electron 预编译包，结束后恢复普通 Node 版本。
const { spawnSync } = require('child_process');
const path = require('path');
const pkg = require('../package.json');

const mode = process.argv[2] || 'dev';
const electronVersion = String(pkg.devDependencies.electron || '').replace(/^[^0-9]*/, '');
if (!electronVersion) throw new Error('package.json 缺少 Electron 版本');

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';
const bin = name => path.join(__dirname, '..', 'node_modules', '.bin', name + (isWin ? '.cmd' : ''));

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: Object.assign({}, process.env, env || {}),
    shell: isWin
  });
  if (result.error) throw result.error;
  return result.status == null ? 1 : result.status;
}

function installElectronNative() {
  return run(npmCmd, ['rebuild', 'better-sqlite3'], {
    npm_config_runtime: 'electron',
    npm_config_target: electronVersion,
    npm_config_disturl: 'https://electronjs.org/headers'
  });
}

function restoreNodeNative() {
  return run(npmCmd, ['rebuild', 'better-sqlite3'], {
    npm_config_runtime: '',
    npm_config_target: '',
    npm_config_disturl: ''
  });
}

let exitCode = installElectronNative();
if (exitCode !== 0) process.exit(exitCode);
try {
  if (mode === 'dev') exitCode = run(bin('electron'), ['.']);
  else if (mode === 'build') exitCode = run(bin('electron-builder'), ['--dir']);
  else if (mode === 'dist') exitCode = run(bin('electron-builder'), []);
  else throw new Error('未知桌面任务：' + mode);
} finally {
  const restoreCode = restoreNodeNative();
  if (exitCode === 0 && restoreCode !== 0) exitCode = restoreCode;
}
process.exit(exitCode);