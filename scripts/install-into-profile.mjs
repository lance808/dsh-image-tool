// 把本插件装进一个 DSH profile。
//
// 做三件事，全部幂等：
//   ① ~/.dsh/plugins/<pkg>            → 本插件目录（人工可读的"安装位"）
//   ② <profile>/node_modules/<pkg>    → ①（Node 的解析路径，缺了插件加载不起来）
//   ③ <profile>/package.json          → dependencies + dsh.profile.bundles
//
// 为什么不直接用 `dsh plugin add`：那个命令依赖 dsh CLI 与 pnpm，在很多机器上
// （比如只有桌面端、没有全局 CLI 的环境）并不可用。而这个插件是纯 JS、只有一个
// 普通依赖，两层链接加一行 profile 声明就够了 —— 不引入任何构建步骤。
//
// 用法：
//   node scripts/install-into-profile.mjs [profile]
//   DSH_HOME=... DSH_PROFILE=desktop node scripts/install-into-profile.mjs
//
// 装完**必须重启 DSH**（插件在启动时装配）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
const PKG_NAME = pkg.name;

const DSH_HOME = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
const PROFILE = (process.argv[2] || process.env.DSH_PROFILE || '').trim() || 'web';

function log(message) { console.log(`[install] ${message}`); }
function fatal(message) { console.error(`[install] 失败：${message}`); process.exit(1); }

if (!fs.existsSync(DSH_HOME)) fatal(`找不到 DSH_HOME：${DSH_HOME}（可用环境变量指定）`);
if (PROFILE === '.' || PROFILE === '..' || /[\\/]/.test(PROFILE)) fatal(`profile 名非法：${PROFILE}`);

const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
if (!fs.existsSync(profileDir)) fatal(`找不到 profile 目录：${profileDir}（确认 profile 名，例如 desktop）`);

/**
 * 建目录链接。
 *
 * 已存在时**必须先确认它指向本插件目录**再复用：指向别处说明用户那边有另一份
 * 安装（或手工链接），此时静默覆盖等于替用户做了他不知情的决定 —— 直接报错让他看。
 */
function ensureDirLink(linkPath, targetPath, label) {
  const resolvedTarget = fs.realpathSync(targetPath);
  if (fs.existsSync(linkPath) || isBrokenLink(linkPath)) {
    let current = null;
    try { current = fs.realpathSync(linkPath); } catch { current = null; }
    if (current === resolvedTarget) {
      log(`${label} 已存在且指向本插件：${linkPath}`);
      return linkPath;
    }
    fatal(`${label} 已存在但指向别处：${linkPath}\n        当前 → ${current ?? '(断链)'}\n        期望 → ${resolvedTarget}\n        请先自行处理（删除或改名）后重试。`);
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(resolvedTarget, linkPath, 'junction');
  log(`${label} 已创建：${linkPath} → ${resolvedTarget}`);
  return linkPath;
}

function isBrokenLink(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

// ① DSH_HOME/plugins/<pkg>
const pluginLink = path.join(DSH_HOME, 'plugins', PKG_NAME);
ensureDirLink(pluginLink, PKG_DIR, '插件安装位');

// ② <profile>/node_modules/<pkg>
ensureDirLink(path.join(profileDir, 'node_modules', PKG_NAME), pluginLink, 'profile 解析链接');

// ③ profile/package.json
const pkgFile = path.join(profileDir, 'package.json');
let profilePkg = { name: `dsh-profile-${PROFILE}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
if (fs.existsSync(pkgFile)) {
  try {
    profilePkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  } catch (error) {
    fatal(`profile 的 package.json 解析失败：${error.message}`);
  }
}
profilePkg.name = profilePkg.name || `dsh-profile-${PROFILE}`;
profilePkg.private = profilePkg.private !== false;
if (!profilePkg.dependencies || typeof profilePkg.dependencies !== 'object' || Array.isArray(profilePkg.dependencies)) profilePkg.dependencies = {};
profilePkg.dsh = profilePkg.dsh || {};
profilePkg.dsh.profile = profilePkg.dsh.profile || {};
if (!Array.isArray(profilePkg.dsh.profile.bundles)) profilePkg.dsh.profile.bundles = [];

const linkValue = `link:${pluginLink.replace(/\\/g, '/')}`;
let changed = false;
if (profilePkg.dependencies[PKG_NAME] !== linkValue) {
  profilePkg.dependencies[PKG_NAME] = linkValue;
  log(`dependencies.${PKG_NAME} = ${linkValue}`);
  changed = true;
}
if (!profilePkg.dsh.profile.bundles.includes(PKG_NAME)) {
  profilePkg.dsh.profile.bundles.push(PKG_NAME);
  log(`dsh.profile.bundles += ${PKG_NAME}`);
  changed = true;
}
if (changed) {
  // 先写临时文件再改名：中途中断不会留下半截 package.json。
  const tmp = `${pkgFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(profilePkg, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, pkgFile);
  log(`profile package.json 已更新：${pkgFile}`);
} else {
  log('profile package.json 已是最新');
}

// 依赖是否可解析 —— 这是最容易在"重启后才发现"的一步，所以提前说出来。
const depDir = path.join(profileDir, 'node_modules', '@deepseek-ai', 'schemastery');
if (fs.existsSync(depDir)) {
  log(`依赖可解析：@deepseek-ai/schemastery → ${fs.realpathSync(depDir)}`);
} else {
  log('⚠️ 未能解析 @deepseek-ai/schemastery。插件会加载失败并报 ERR_MODULE_NOT_FOUND。');
  log('   解决办法：在 profile 目录里执行一次包管理器安装，例如');
  log(`     cd "${profileDir}" && pnpm install`);
  log('   （同一个 profile 里通常已经有别的插件依赖它，此时不会缺。）');
}

log('');
log('完成。请**重启 DSH**（插件在启动时装配）。');
log('重启后验证：');
log('  1) 设置命名空间就绪 —— settings/describe 里应出现 image-tool；');
log('  2) 工具已注册 —— 模型应能看到 generate_image；');
log('  3) 若 applier 报错，看诊断日志：$TMPDIR/dsh-image-tool.log（可用 DSH_IMAGE_TOOL_DIAG 覆盖）。');
