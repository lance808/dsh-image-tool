// 便捷配置工具：把生图 API 写进 DSH 的 settings 命名空间。
//
// 为什么需要它：本插件是 **host-only**（没有 client 半），所以 DSH 设置页里不会
// 出现它的表单卡片 —— 命名空间可读可写，但缺一张自己渲染的卡片。于是配置得走
// settings API。这个脚本把那条 API 调用包成一条命令，省得用户手拼 Cookie 与 RPC 信封。
//
// 用法：
//   node scripts/configure.mjs                                     # 交互式（逐项询问）
//   node scripts/configure.mjs --api-url=https://api.openai.com/v1 --api-key=sk-xxx --model=gpt-image-1
//   node scripts/configure.mjs --show                              # 只看当前配置
//   node scripts/configure.mjs --clear-key                         # 只清除已保存的密钥
//   node scripts/configure.mjs --set confirmBeforeGenerate=false   # 改任意单个字段
//
// ── 关于 Cookie ──────────────────────────────────────────────────────────────
// DSH 的 `/api/*` 要一个会话 Cookie。本机同用户进程可以**离线铸造**它：
// 密钥是 credentials 里的 `client-connection/browser-session`（32 字节，长期不变），
// Cookie 名与签名载荷都只用到 Host 头。这不是权限提升 —— 同一台机器上的同一用户
// 本来就能读那个文件；它只是免去了"去浏览器里复制 Cookie"。
//
// ⚠️ 密钥的落盘语义（务必知道）：`role('secret')` 让平台**只把它从 API 回包里剥掉**，
//   并不会加密存储。apiKey 会以**明文**写进
//   `<profile>/cordis.patch.yml` 的那条 entry 里（该文件默认 ACL = 本机用户可读）。
//   若这不可接受，请改用 DSH 的凭据服务自行托管密钥，或只在本机使用低权限 Key。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';

const NS = 'image-tool';
const DSH_HOME = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
const BASE = (process.env.DSH_BASE_URL?.trim() || 'http://127.0.0.1:19387').replace(/\/+$/, '');
const BROWSER_SESSION_KEY = 'client-connection/browser-session';
const COOKIE_PAYLOAD_VERSION = 1;
const COOKIE_PREFIX = 'dsh-auth-';
const SECRET_BYTES = 32;
const COOKIE_LIFETIME_MS = 60 * 60 * 1000;

function fail(message) { console.error(`[configure] 失败：${message}`); process.exit(1); }
function info(message) { console.log(`[configure] ${message}`); }

const base64url = (buffer) => Buffer.from(buffer).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/**
 * 从 .credentials.yaml 里取出浏览器会话签名密钥。
 *
 * 这里刻意**不引入 YAML 依赖**，而是按键名定位后逐行找 payload.secret：
 * 该文件由 DSH 自己写成固定缩进结构，且我们要的值是一个不含空白的 base64url 串，
 * 所以"找到键、再往后几行找 secret"足够稳，同时避免为一个便利脚本多背一个依赖。
 */
function readBrowserSessionSecret() {
  const file = path.join(DSH_HOME, '.credentials.yaml');
  if (!fs.existsSync(file)) fail(`找不到凭据文件：${file}（DSH 至少运行过一次才会生成）`);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const keyLine = lines.findIndex((line) => line.includes(BROWSER_SESSION_KEY));
  if (keyLine < 0) fail(`凭据文件里没有 ${BROWSER_SESSION_KEY}（DSH 版本可能变了，请改用官方设置界面配置）`);
  // 从键往后找最近的 secret:，最多看 20 行（够跨过 kind/payload/version 几层）
  for (let i = keyLine; i < Math.min(lines.length, keyLine + 20); i += 1) {
    const match = /^\s*secret:\s*['"]?([A-Za-z0-9_\-+/=]+)['"]?\s*$/.exec(lines[i]);
    if (match) {
      const decoded = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
      if (decoded.byteLength !== SECRET_BYTES) fail(`会话密钥长度不是 ${SECRET_BYTES} 字节（实际 ${decoded.byteLength}）`);
      return decoded;
    }
  }
  fail('在凭据文件里找到了 browser-session，但没读出 secret 字段');
  return null;
}

/** 离线铸造一个合法的会话 Cookie。 */
function mintCookie() {
  const secret = readBrowserSessionSecret();
  const authority = new URL(BASE).host;
  const issuedAt = Date.now();
  const expiresAt = issuedAt + COOKIE_LIFETIME_MS;
  const body = base64url(Buffer.from(JSON.stringify({ version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt }), 'utf8'));
  const signature = base64url(crypto.createHmac('sha256', secret).update(body).digest());
  const name = COOKIE_PREFIX + base64url(crypto.createHash('sha256').update(authority).digest());
  return `${name}=v1.${body}.${signature}`;
}

async function rpc(method, args, cookie) {
  const endpoint = method.replace(/\./g, '/');
  const response = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'cfg-' + crypto.randomBytes(4).toString('hex'),
      method: endpoint,
      payload: { args },
    }),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { fail(`DSH 返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 200)}`); }
  if (body?.result?.ok !== true) {
    fail(`DSH 拒绝了请求：${JSON.stringify(body?.result?.error ?? body).slice(0, 400)}`);
  }
  return body.result.value;
}

async function describe(cookie) {
  const value = await rpc('settings.describe', {}, cookie);
  return (value?.namespaces ?? []).find((n) => n.ns === NS) ?? null;
}

/** 解析 `--key=value`，以及 `--set value` 这种"值在下一个 token"的形式。 */
function parseArgs(argv) {
  const out = { flags: new Set(), values: {}, sets: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    const name = match[1];
    if (match[2] !== undefined) { out.values[name] = match[2]; continue; }
    // 不带 = 的形式：若下一个 token 不是另一个 --flag，就把它当作本参数的值。
    // （`--set confirmBeforeGenerate=false` 就是这种，文档里写的是这个形式，
    //  实现必须跟上，否则值会被静默丢掉、然后诡异地落进交互式分支。）
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      // `--set` 允许重复出现（一次传多个字段），所以单独收集成数组：
      // 用普通 values 会让它们互相覆盖，只有最后一个生效 —— 静默少改几个字段。
      if (name === 'set') out.sets.push(next);
      else out.values[name] = next;
      i += 1;
    } else {
      out.flags.add(name);
    }
  }
  return out;
}

/**
 * 问插件自己要权威状态。
 *
 * 不用 `settings.describe()` 的 `secrets[].set` 判断密钥是否存在：实测平台在
 * `mutate/unset` 之后仍然把它报成 true（陈旧标记），而 `hasKey` 是插件**当前真的
 * 读到的值** —— 用户要的是"现在能不能用"，不是"历史上设置过没有"。
 */
async function pluginStatus(cookie) {
  try {
    const response = await fetch(`${BASE}/api/image-tool/status`, { headers: { cookie } });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

const { flags, values, sets } = parseArgs(process.argv.slice(2));
const cookie = mintCookie();

// ── --show：只看当前状态 ────────────────────────────────────────────────────
if (flags.has('show')) {
  const found = await describe(cookie);
  if (!found) fail(`命名空间 ${NS} 未装载（检查插件是否装好、DSH 是否已重启）`);
  const status = await pluginStatus(cookie);
  console.log('当前配置：');
  for (const [k, v] of Object.entries(found.value ?? {})) console.log(`  ${k} = ${JSON.stringify(v)}`);
  if (status) {
    console.log(`  apiKey = ${status.hasKey ? `已设置（${status.keyHint}）` : '未设置'}`);
    console.log(`  就绪   = ${status.configured ? '可以生图' : '还不完整（缺 apiUrl 或 apiKey）'}`);
  } else {
    console.log('  apiKey = 未知（插件外部接口不可达，无法确认真实状态）');
  }
  process.exit(0);
}

// ── --clear-key：清除密钥 ───────────────────────────────────────────────────
// 必须用 mutate + unset：把 apiKey 写成空串**不会**清除它 —— secret 字段把空串
// 当作"本次没有改动"，这是平台为了避免"没渲染出来的密钥被空表单误删"而定的语义。
if (flags.has('clear-key')) {
  await rpc('settings.mutate', { ns: NS, ops: [{ op: 'unset', path: ['apiKey'] }] }, cookie);
  info('apiKey 已清除（用 mutate/unset，写空串是无效的）');
  process.exit(0);
}

const patch = {};
const KNOWN = ['apiUrl', 'model', 'size', 'count', 'confirmBeforeGenerate', 'timeoutMs', 'maxImageBytes', 'quality', 'style', 'background', 'outputFormat', 'savePath'];

// ── --set <key>=<value>：任意单字段（可重复出现，一次改多个） ────────────────
for (const item of sets) {
  const [key, ...rest] = item.split('=');
  if (!KNOWN.includes(key)) fail(`未知字段：${key}（可用：${KNOWN.join(', ')}）`);
  patch[key] = coerce(key, rest.join('='));
}

// ── 具名参数 ────────────────────────────────────────────────────────────────
for (const key of KNOWN) {
  if (values[key] !== undefined) patch[key] = coerce(key, values[key]);
}
// 同时接受 kebab-case（--api-url / --api-key / --confirm-before-generate）
const kebab = { 'api-url': 'apiUrl', 'api-key': 'apiKey', 'confirm-before-generate': 'confirmBeforeGenerate', 'timeout-ms': 'timeoutMs', 'max-image-bytes': 'maxImageBytes', 'output-format': 'outputFormat' };
for (const [from, to] of Object.entries(kebab)) {
  if (values[from] !== undefined) patch[to] = coerce(to, values[from]);
}

function coerce(key, raw) {
  if (['count', 'timeoutMs', 'maxImageBytes'].includes(key)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) fail(`${key} 需要一个数字，收到 ${JSON.stringify(raw)}`);
    return n;
  }
  if (key === 'confirmBeforeGenerate') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    fail(`confirmBeforeGenerate 只能是 true 或 false`);
  }
  return String(raw);
}

// ── 交互式补齐 ──────────────────────────────────────────────────────────────
if (Object.keys(patch).length === 0 && !flags.has('clear-key')) {
  // 非交互环境（管道、CI、被别的程序调用）下别去读 stdin —— 那会挂在那里，
  // 最后只留下一条 "unsettled top-level await" 警告，看不出真正原因。
  if (!process.stdin.isTTY) {
    console.error('[configure] 没有传入任何字段，且当前不是交互式终端。');
    console.error('            请用参数形式，例如：');
    console.error('              node scripts/configure.mjs --api-url=https://api.openai.com/v1 --api-key=sk-xxx --model=gpt-image-1');
    console.error('            或加 --show 查看当前配置。');
    process.exit(2);
  }
  const found = await describe(cookie);
  if (!found) fail(`命名空间 ${NS} 未装载（检查插件是否装好、DSH 是否已重启）`);
  const current = found.value ?? {};
  const status = await pluginStatus(cookie);
  const keySet = status ? status.hasKey === true : false;
  console.log(`交互式配置 ${NS}（直接回车 = 保持原值）\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ask = async (label, currentValue, hint) => {
      const shown = currentValue === '' || currentValue === undefined ? '(未设置)' : JSON.stringify(currentValue);
      const answer = (await rl.question(`${label} [${shown}]${hint ? `（${hint}）` : ''}: `)).trim();
      return answer;
    };
    const apiUrl = await ask('生图接口基址', current.apiUrl, '如 https://api.openai.com/v1');
    if (apiUrl !== '') patch.apiUrl = apiUrl;
    const model = await ask('生图模型名', current.model, '留空则由上游默认');
    if (model !== '') patch.model = model;
    const key = await ask('API Key', keySet ? '(已设置)' : '', '留空则保持不变');
    if (key !== '') patch.apiKey = key;
    const size = await ask('默认尺寸', current.size, '如 1024x1024');
    if (size !== '') patch.size = size;
    const count = await ask('默认张数', current.count);
    if (count !== '') patch.count = coerce('count', count);
    const confirm = await ask('调用前弹窗确认', current.confirmBeforeGenerate, 'true / false');
    if (confirm !== '') patch.confirmBeforeGenerate = coerce('confirmBeforeGenerate', confirm);
  } finally {
    rl.close();
  }
  if (Object.keys(patch).length === 0) { info('没有要改的字段，退出。'); process.exit(0); }
}

await rpc('settings.update', { ns: NS, patch }, cookie);
info(`已写入 ${Object.keys(patch).join(', ')}`);

const after = await describe(cookie);
const statusAfter = await pluginStatus(cookie);
console.log('\n写入后的配置（apiKey 永不回显）：');
for (const [k, v] of Object.entries(after?.value ?? {})) console.log(`  ${k} = ${JSON.stringify(v)}`);
console.log(`  apiKey = ${statusAfter ? (statusAfter.hasKey ? '已设置' : '未设置') : '未知（插件接口不可达）'}`);
console.log('\n提示：改动即时生效（settings 的 applies 为 live），下一次调用就会用新配置。');
