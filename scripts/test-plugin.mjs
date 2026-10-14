// index.js 的契约测试 —— 用 mock ctx 真的装配一次插件，不依赖 DSH 进程。
//
// 钉住的东西（每一条错了都会以"看起来装好了但用不了"收场）：
//   ① settings 命名空间名与 cordis.patch.yml 的 entry id 一致（否则设置写不进去）；
//   ② Config 每个字段都带 volatile（否则命名空间拒绝写入）；
//   ③ apiKey 是 secret 字段（否则密钥会被回传到前端）；
//   ④ 工具定义的形状：名字、参数、以及 render 必须产出**平台原生 image 块**；
//   ⑤ 未配置 / 没有确认通道时，工具**不能**发请求，而是返回可读原因。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Config,
  SETTINGS_NAMESPACE,
  TOOL_NAME,
  apply,
  cwdFromExecution,
  makeConfigReader,
  makeDiskSaver,
  makeImageFetcher,
  requestConfirmation,
  runGenerate,
} from '../lib/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.message}`); }
}

/**
 * 最小 ctx 假体：只实现插件真正用到的那几个面。
 *
 * ⚠️ 这里必须**忠实模拟两处平台语义**，否则测试会放过真实的 bug：
 *   ① `tools.register` 在同一层**重名即失败**（真实契约原文：duplicates … fail）；
 *   ② `ctx.effect` 返回的 disposer，平台在重新装配/卸载时会调用它。
 * 之前这两点都写得太宽松（register 直接 push、effect 丢弃 disposer），于是
 * "直接 ctx.tools.register 而不走 effect"这个错误一路溜进了真实环境 ——
 * 症状是插件卡显示「启动失败」，且**第一次是好的、动过配置才坏**。
 */
function makeCtx({ config = {}, userQuestions, webServer = true, hasAttachments = true, connection = true } = {}) {
  const registered = [];
  const routes = [];
  const effectDisposers = [];
  const toolNames = new Set();
  const routeKeys = new Set();

  /** webServer 服务假体：重复注册同一个 (kind, path) 必须抛错，与真实契约一致。 */
  function webServerService() {
    return {
      register: (route) => {
        const key = `${route.kind}:${route.path}`;
        if (routeKeys.has(key)) throw new Error(`duplicate route "${key}"`);
        routeKeys.add(key);
        routes.push(route);
        return () => { routeKeys.delete(key); const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); };
      },
    };
  }

  const ctx = {
    registered,
    routes,
    effectDisposers,
    tools: {
      register: (def) => {
        if (toolNames.has(def.name)) throw new Error(`duplicate tool "${def.name}" in one layer`);
        toolNames.add(def.name);
        registered.push(def);
        return () => {
          toolNames.delete(def.name);
          const index = registered.indexOf(def);
          if (index >= 0) registered.splice(index, 1);
        };
      },
    },
    sessions: { get: () => undefined },
    settings: { describe: () => [{ ns: SETTINGS_NAMESPACE, value: config, revision: 1, applies: 'live' }] },
    /**
     * 可选依赖必须走 `ctx.inject`，而**不能**直接 `ctx.get('webServer')` ——
     * 真实环境里后者在未声明 inject 时会抛
     * `cannot get property "webServer" without inject`。这里如实模拟这个约束，
     * 否则测试又会放过一次真实的「启动失败」。
     */
    inject(deps, callback) {
      const routeCtx = {
        get: (name) => {
          if (name === 'userQuestions') return userQuestions;
          if (name === 'webServer') return webServer ? webServerService() : undefined;
          if (name === 'connection') return connection ? { requestRejection: () => undefined } : undefined;
          return undefined;
        },
        effect(fn) {
          const dispose = fn();
          const wrapped = typeof dispose === 'function' ? dispose : () => {};
          effectDisposers.push(wrapped);
          return wrapped;
        },
      };
      if (deps.includes('webServer') && !webServer) return; // 依赖不可用就不执行回调
      if (deps.includes('connection') && !connection) return;
      callback(routeCtx);
    },
    get(name) {
      if (name === 'userQuestions') return userQuestions;
      // ⚠️ 真实 ctx 访问**未声明 inject** 的服务会抛错，测试必须跟着一起不宽容：
      //    之前这里返回 undefined，于是"直接 ctx.get('webServer')"这个写法
      //    一路溜到真实环境，把整个插件变成「启动失败」。
      if (name === 'webServer' || name === 'connection') {
        throw new Error(`cannot get property "${name}" without inject`);
      }
      return undefined;
    },
    effect(fn) {
      const dispose = fn();
      const wrapped = typeof dispose === 'function' ? dispose : () => {};
      effectDisposers.push(wrapped);
      return wrapped;
    },
  };
  // settings 的写入口：真实签名是**位置参数** update(ns, patch) / mutate(ns, ops)。
  ctx.writtenPatches = [];
  ctx.clearedSecrets = 0;
  ctx.settings.update = async (ns, patch) => { ctx.writtenPatches.push({ ns, patch }); config = { ...config, ...patch }; };
  ctx.settings.mutate = async (ns, ops) => {
    for (const op of ops ?? []) {
      if (op?.op === 'unset' && op.path?.join('.') === 'apiKey') { ctx.clearedSecrets += 1; config = { ...config, apiKey: '' }; }
    }
  };
  if (hasAttachments) {
    ctx.attachments = {
      saveImage: async (input) => ({
        attachmentId: 'att-fixture',
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 8,
        height: 8,
        name: input.name,
      }),
    };
  }
  return ctx;
}

/** 模拟平台的一次重新装配（volatile 更新时会发生）：先释放上一轮 effects，再 apply。 */
function reassemble(ctx) {
  for (const dispose of [...ctx.effectDisposers]) {
    try { dispose(); } catch {}
  }
  ctx.effectDisposers.length = 0;
  apply(ctx, {});
}

await test('重新装配（volatile 更新）不会因工具/路由重名而失败', () => {
  const ctx = makeCtx();
  apply(ctx, {});
  assert.equal(ctx.registered.length, 2, '首次装配应注册一个工具');
  assert.equal(ctx.routes.length, 1, '首次装配应挂载一条路由');
  // 反复重装：旧实现（直接 register、不经 effect）会在第二次就抛 duplicate 而失败。
  for (let round = 1; round <= 3; round += 1) {
    assert.doesNotThrow(() => reassemble(ctx), `第 ${round} 次重装不应抛错`);
    assert.equal(ctx.registered.length, 2, `第 ${round} 次重装后应恰好一个工具（不是零、也不是两个）`);
    assert.equal(ctx.routes.length, 1, `第 ${round} 次重装后应恰好一条路由`);
  }
});

await test('settings 命名空间名与 patch 里的 entry id 一致', () => {
  const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
  const ids = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.ok(ids.includes(SETTINGS_NAMESPACE), `patch 里应有 id: ${SETTINGS_NAMESPACE}，实际 ${ids.join(', ')}`);
  // 写成包名是最常见的错法：命名空间由 entry id 推导，包名不匹配就写不进去。
  assert.ok(!ids.includes('dsh-image-tool'), 'entry id 不应是包名');
});

await test('Config：默认值合理（空=未配置；确认默认开）', () => {
  const defaults = Config({});
  // ⚠️ 读法：schema 里**只要有一个 secret 字段**，schemastery 就把整个结果的每个
  // 字段都包成受控读取器 `{ get() }`（并挂上 Symbol(cosmokit.volatile.write) 写入口）。
  // 这是"密钥不会被整对象序列化顺手带出去"的机制本身，不是异常形状。
  // 直接 `assert.equal(defaults.apiUrl, '')` 会拿到读取器对象而不是值 —— 必须先 get()。
  const read = (key) => {
    const field = defaults[key];
    return field && typeof field.get === 'function' ? field.get() : field;
  };
  assert.equal(read('apiUrl'), '', '未配置时 apiUrl 应为空串');
  assert.equal(read('apiKey'), '', '未配置时 apiKey 应为空串');
  assert.equal(read('model'), '');
  assert.equal(read('size'), '');
  assert.equal(read('savePath'), '');
  assert.equal(read('count'), 1);
  assert.equal(read('confirmBeforeGenerate'), true, '确认必须默认开启：生图会真实计费');
  assert.equal(read('timeoutMs'), 180000);
  assert.equal(read('maxImageBytes'), 20 * 1024 * 1024);
});

await test('Config：每个字段都带 volatile（否则设置写不进去）', () => {
  const json = Config.toJSON();
  const refs = json.refs ?? {};
  const root = refs[String(json.uid)] ?? json;
  const volatile = [];
  for (const [key, node] of Object.entries(root.dict ?? {})) {
    if (refs[String(node)]?.meta?.volatile === true) volatile.push(key);
  }
  const expected = ['apiUrl', 'apiKey', 'model', 'size', 'count', 'confirmBeforeGenerate', 'timeoutMs', 'maxImageBytes', 'quality', 'style', 'background', 'outputFormat', 'savePath'];
  for (const field of expected) {
    assert.ok(volatile.includes(field), `${field} 必须带 volatile；实际：${volatile.join(', ')}`);
  }
});

await test('Config：apiKey 是 secret 字段（密钥不回传前端）', () => {
  const json = Config.toJSON();
  const refs = json.refs ?? {};
  const root = refs[String(json.uid)] ?? json;
  const keyNode = refs[String(root.dict.apiKey)];
  assert.equal(keyNode?.meta?.role, 'secret', 'apiKey 必须标 role(secret)');
});

await test('makeConfigReader：优先读 settings 的实时值，读不到回退装载期配置', () => {
  const live = makeConfigReader(makeCtx({ config: { model: 'live-model', apiUrl: 'https://live.example.com/v1' } }), { model: 'boot-model' });
  assert.equal(live().model, 'live-model');
  assert.equal(live().apiUrl, 'https://live.example.com/v1');

  const broken = { settings: { describe() { throw new Error('boom'); } } };
  const fallback = makeConfigReader(broken, { model: 'boot-model' });
  assert.equal(fallback().model, 'boot-model', 'settings 读失败应回退，而不是抛出去');
});

await test('apply：注册了工具，且工具定义形状正确', () => {
  const ctx = makeCtx();
  apply(ctx, {});
  assert.equal(ctx.registered.length, 2);
  const tool = ctx.registered[0];
  assert.equal(tool.name, TOOL_NAME);
  assert.equal(typeof tool.execute, 'function');
  assert.equal(tool.parameters.required[0], 'prompt');
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(typeof tool.output.render, 'function');
  assert.ok(tool.output.schema, '必须声明 output.schema');
});

await test('apply：没有 webServer 时不挂外部接口，但工具照常注册', () => {
  const ctx = makeCtx({ webServer: false });
  apply(ctx, {});
  assert.equal(ctx.registered.length, 2, '工具必须照常注册');
  assert.equal(ctx.routes.length, 0, '没有 webServer 就不该注册路由');
});

await test('apply：有 webServer 时挂载外部调用接口', () => {
  const ctx = makeCtx();
  apply(ctx, {});
  assert.equal(ctx.routes.length, 1);
  assert.equal(ctx.routes[0].kind, 'prefix');
  assert.match(ctx.routes[0].path, /^\/api\/image-tool$/);
});

await test('render：产出文本信封 + **平台原生 image 块**', () => {
  const ctx = makeCtx();
  apply(ctx, {});
  const tool = ctx.registered[0];
  const ref = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 1, height: 1 };
  const blocks = tool.output.render({ prompt: 'x' }, { ok: true, note: '已生成 1 张图片', images: [{ ref }] });
  assert.deepEqual(blocks[0], { type: 'text', text: '已生成 1 张图片' });
  assert.deepEqual(blocks[1], { type: 'image', attachment: ref });
  // 失败时不该出现图片块
  const failed = tool.output.render({}, { ok: false, note: '失败了', images: [] });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].type, 'text');
});

await test('execute：未配置时不发请求，返回可读原因', async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; return new Response('{}', { status: 200 }); };
  try {
    const ctx = makeCtx({ config: {} });
    apply(ctx, {});
    const result = await ctx.registered[0].execute({ prompt: '一只猫' }, {});
    assert.equal(result.ok, false);
    assert.match(result.note, /未配置生图接口地址/);
    assert.equal(fetched, false, '未配置时绝不能发请求');
  } finally { globalThis.fetch = originalFetch; }
});

await test('execute：缺 Key 时同样不发请求', async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; return new Response('{}', { status: 200 }); };
  try {
    const ctx = makeCtx({ config: { apiUrl: 'https://x.example.com/v1', apiKey: '' } });
    apply(ctx, {});
    const result = await ctx.registered[0].execute({ prompt: '一只猫' }, {});
    assert.equal(result.ok, false);
    assert.match(result.note, /未配置生图 API Key/);
    assert.equal(fetched, false);
  } finally { globalThis.fetch = originalFetch; }
});

await test('execute：开启确认但没有问答通道时，拒绝而不是静默生成', async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; return new Response('{}', { status: 200 }); };
  try {
    const ctx = makeCtx({
      config: { apiUrl: 'https://x.example.com/v1', apiKey: 'k', confirmBeforeGenerate: true },
      userQuestions: undefined,
    });
    apply(ctx, {});
    const result = await ctx.registered[0].execute({ prompt: '一只猫' }, {});
    assert.equal(result.ok, false);
    assert.match(result.note, /没有可用的用户问答通道/);
    assert.equal(fetched, false, '确认闸门打不开时不能擅自生图');
  } finally { globalThis.fetch = originalFetch; }
});

await test('execute：用户取消后不生图', async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; return new Response('{}', { status: 200 }); };
  try {
    const ctx = makeCtx({
      config: { apiUrl: 'https://x.example.com/v1', apiKey: 'k', confirmBeforeGenerate: true },
      userQuestions: { ask: async () => ({ answers: [{ id: 'confirm-generate', selected: ['取消'] }] }) },
    });
    apply(ctx, {});
    const result = await ctx.registered[0].execute({ prompt: '一只猫' }, {});
    assert.equal(result.ok, false);
    assert.match(result.note, /取消/);
    assert.equal(fetched, false);
  } finally { globalThis.fetch = originalFetch; }
});

await test('execute：确认通过后走通全链路，返回平台可渲染的图片引用', async () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8, 1)]);
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 });
  };
  try {
    const ctx = makeCtx({
      config: { apiUrl: 'https://x.example.com/v1', apiKey: 'secret-key', model: 'gen-model', confirmBeforeGenerate: true },
      userQuestions: { ask: async () => ({ answers: [{ id: 'confirm-generate', selected: ['生成'] }] }) },
    });
    apply(ctx, {});
    const result = await ctx.registered[0].execute({ prompt: '一只猫', count: 2 }, {});
    assert.equal(result.ok, true, result.note);
    assert.equal(result.images.length, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://x.example.com/v1/images/generations');
    assert.equal(seen[0].auth, 'Bearer secret-key');
    assert.equal(seen[0].body.prompt, '一只猫');
    assert.equal(seen[0].body.model, 'gen-model');
    assert.equal(seen[0].body.n, 2, '模型显式传的 count 应生效');
    assert.ok(result.images[0].ref.attachmentId);
  } finally { globalThis.fetch = originalFetch; }
});

await test('requestConfirmation：问到人才算数（返回结构不合法视为取消）', async () => {
  const ctx = { get: () => ({ ask: async () => ({ answers: [] }) }) };
  const verdict = await requestConfirmation(ctx, { prompt: 'x', count: 1, size: '' });
  assert.equal(verdict.allowed, false);

  const yes = { get: () => ({ ask: async () => ({ answers: [{ id: 'confirm-generate', selected: ['生成'] }] }) }) };
  assert.equal((await requestConfirmation(yes, { prompt: 'x', count: 1, size: '' })).allowed, true);
});

await test('runGenerate：上游返回 url 形态时，走 SSRF 关卡后下载并落地', async () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8, 1)]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === 'https://x.example.com/v1/images/generations') {
      return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.com/out.png' }] }), { status: 200 });
    }
    if (url === 'https://cdn.example.com/out.png') {
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    throw new Error('unexpected url ' + url);
  };
  try {
    const ctx = makeCtx();
    const result = await runGenerate(ctx, {
      config: { apiUrl: 'https://x.example.com/v1', apiKey: 'k' },
      args: { prompt: '一只猫' },
    });
    assert.equal(result.ok, true, result.note);
    assert.equal(result.images[0].mediaType, 'image/png');
  } finally { globalThis.fetch = originalFetch; }
});

await test('runGenerate：默认**不**把图片字节放进返回值（否则会撑爆会话日志）', async () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 });
  try {
    const ctx = makeCtx();
    const result = await runGenerate(ctx, {
      config: { apiUrl: 'https://x.example.com/v1', apiKey: 'k' },
      args: { prompt: '一只猫' },
    });
    assert.equal(result.ok, true, result.note);
    assert.equal(result.data, undefined, '默认不应带 base64');
    // 整个返回值里不能出现图片字节的任何痕迹
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(PNG.toString('base64').slice(0, 32)), '返回值不应包含图片字节');
    assert.ok(serialized.length < 2000, `返回值应保持轻量，实际 ${serialized.length} 字节`);
  } finally { globalThis.fetch = originalFetch; }
});

await test('runGenerate：includeData=true 时单独给出 base64（外部接口用）', async () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 5)]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 });
  try {
    const ctx = makeCtx();
    const result = await runGenerate(ctx, {
      config: { apiUrl: 'https://x.example.com/v1', apiKey: 'k' },
      args: { prompt: '一只猫' },
      includeData: true,
    });
    assert.equal(result.ok, true, result.note);
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].mediaType, 'image/png');
    assert.equal(Buffer.from(result.data[0].dataBase64, 'base64').byteLength, PNG.byteLength);
    // images 里仍然只放引用，字节只出现在专门的 data 字段
    assert.equal(result.images[0].ref.attachmentId, 'att-fixture');
  } finally { globalThis.fetch = originalFetch; }
});

// ── 设置页用的配置接口 ──────────────────────────────────────────────────────
// 这几条是**安全相关**的：GET /config 一旦回显密钥，设置页里一个 fetch 就能把 Key 读走。

function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
  };
}
function fakeRes() {
  const out = { status: 0, body: null };
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers; },
    end(text) { try { out.body = text ? JSON.parse(text) : null; } catch { out.body = text; } },
  };
}
async function callRoute(ctx, method, path, body) {
  const res = fakeRes();
  await ctx.routes[0].handler(fakeReq(method, `/api/image-tool${path}`, body), res);
  return res.out;
}

await test('GET /config 绝不回显 apiKey，只给 hasKey 与指纹', async () => {
  const ctx = makeCtx({ config: { apiUrl: 'https://x.example.com/v1', apiKey: 'sk-super-secret-abcd' } });
  apply(ctx, {});
  const out = await callRoute(ctx, 'GET', '/config');
  assert.equal(out.status, 200);
  assert.ok(!('apiKey' in out.body.config), 'apiKey 必须从响应里被删掉');
  assert.equal(JSON.stringify(out.body).includes('sk-super-secret'), false, '响应里不能出现密钥的任何片段');
  assert.equal(out.body.hasKey, true);
  assert.equal(out.body.keyHint, '…abcd');
  assert.equal(out.body.config.apiUrl, 'https://x.example.com/v1');
});

await test('POST /config 写入白名单字段，丢弃未知字段', async () => {
  const ctx = makeCtx({ config: {} });
  apply(ctx, {});
  const out = await callRoute(ctx, 'POST', '/config', {
    apiUrl: 'https://y.example.com/v1',
    model: 'm1',
    不存在的字段: 'should-be-dropped',
    __proto__: 'nope',
  });
  assert.equal(out.status, 200);
  assert.equal(ctx.writtenPatches.length, 1);
  const patch = ctx.writtenPatches[0].patch;
  assert.equal(patch.apiUrl, 'https://y.example.com/v1');
  assert.equal(patch.model, 'm1');
  assert.equal('不存在的字段' in patch, false, '未知字段必须被丢弃');
  // 写入用的是**位置参数**签名，命名空间必须对
  assert.equal(ctx.writtenPatches[0].ns, 'image-tool');
});

await test('POST /config {clearApiKey:true} 走 mutate/unset，而不是写空串', async () => {
  const ctx = makeCtx({ config: { apiKey: 'sk-x' } });
  apply(ctx, {});
  const out = await callRoute(ctx, 'POST', '/config', { clearApiKey: true });
  assert.equal(out.status, 200);
  assert.equal(ctx.clearedSecrets, 1, '必须调用 mutate/unset —— 给 secret 字段写空串是清不掉的');
  // 清密钥那次不该把 apiKey:'' 一起写进去
  assert.equal(ctx.writtenPatches.some((w) => 'apiKey' in (w.patch ?? {})), false);
});

await test('未知路由返回 404 且列出可用端点', async () => {
  const ctx = makeCtx({ config: {} });
  apply(ctx, {});
  const out = await callRoute(ctx, 'GET', '/nope');
  assert.equal(out.status, 404);
  assert.match(out.body.error, /可用：/);
});

// ── 落盘（会话工作目录下的 generated-images/） ───────────────────────────────

await test('cwdFromExecution：只通过 agent.id 读取 live Session.header.cwd', () => {
  const cwd = path.resolve(ROOT, '..');
  const sessions = { get(id) { assert.equal(id, 'session-fixture'); return { header: { cwd } }; } };
  assert.equal(cwdFromExecution({ agent: { id: 'session-fixture' } }, sessions), cwd);
  assert.equal(cwdFromExecution({ cwd, agent: { cwd } }), null);
  assert.equal(cwdFromExecution({ agent: { id: 'missing' } }, { get: () => undefined }), null);
  assert.equal(cwdFromExecution({ agent: { id: 'relative' } }, { get: () => ({ header: { cwd: 'relative' } }) }), null);
  assert.equal(cwdFromExecution(undefined), null);
});

await test('makeDiskSaver：没有 cwd 时返回 null（宁可不落盘，也不乱写目录）', () => {
  assert.equal(makeDiskSaver({ cwd: undefined }), null);
  assert.equal(makeDiskSaver({ cwd: '' }), null);
  assert.equal(makeDiskSaver({ cwd: '   ' }), null);
  assert.equal(typeof makeDiskSaver({ cwd: 'D:/work' }), 'function');
});

await test('makeDiskSaver：真的把字节写进 <cwd>/generated-images/ 并返回路径', async () => {
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const nodePath = await import('node:path');
  const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'dsh-image-tool-test-'));
  try {
    const save = makeDiskSaver({ cwd: dir });
    const payload = Buffer.from('hello-image-bytes');
    const file = await save({ data: payload, name: 'x.png', mediaType: 'image/png' });
    assert.equal(file, nodePath.join(dir, 'generated-images', 'x.png'));
    assert.deepEqual(await fsp.readFile(file), payload, '写出的字节必须与传入一致');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

await test('runGenerate：有 cwd 时落盘，路径出现在返回值里但不含字节', async () => {
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const nodePath = await import('node:path');
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 3)]);
  const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'dsh-image-tool-test-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 });
  try {
    const ctx = makeCtx();
    const result = await runGenerate(ctx, {
      config: { apiUrl: 'https://x.example.com/v1', apiKey: 'k' },
      args: { prompt: '一只猫' },
      cwd: dir,
    });
    assert.equal(result.ok, true, result.note);
    assert.ok(result.images[0].diskPath, '应当带回落盘路径');
    assert.match(result.images[0].diskPath, /generated-images/);
    const written = await fsp.readFile(result.images[0].diskPath);
    assert.equal(written.byteLength, PNG.byteLength);
    assert.match(result.note, /已保存到/);
    assert.ok(JSON.stringify(result).length < 3000, '返回值仍应轻量（不许把字节塞进去）');
  } finally {
    globalThis.fetch = originalFetch;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

await test('runGenerate：没有 cwd 时照常生图，只是不落盘', async () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 });
  try {
    const ctx = makeCtx();
    const result = await runGenerate(ctx, {
      config: { apiUrl: 'https://x.example.com/v1', apiKey: 'k' },
      args: { prompt: '一只猫' },
    });
    assert.equal(result.ok, true, result.note);
    assert.equal(result.images[0].diskPath, null);
    assert.ok(!/已保存到/.test(result.note), '没落盘就不该说已保存到');
  } finally { globalThis.fetch = originalFetch; }
});

await test('落盘失败不影响生图本身（目录不可写时仍算成功）', async () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 9)]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 });
  try {
    const ctx = makeCtx();
    // 指向一个不可能写成功的路径，落盘必然抛错
    const result = await runGenerate(ctx, {
      config: { apiUrl: 'https://x.example.com/v1', apiKey: 'k' },
      args: { prompt: '一只猫' },
      cwd: 'Z:\\definitely\\not\\a\\real\\drive',
    });
    assert.equal(result.ok, true, '落盘失败绝不能把生图判成失败：' + result.note);
    assert.equal(result.images[0].diskPath, null);
    assert.ok(result.images[0].ref.attachmentId, '附件库那份仍应存在');
  } finally { globalThis.fetch = originalFetch; }
});

await test('/generate 缺鉴权服务时拒绝，绝不调用生成函数', async () => {
  const { registerImageRoutes } = await import('../lib/routes.js');
  let route;
  let calls = 0;
  registerImageRoutes({ register(r) { route = r; return () => {}; } }, {
    readConfig: () => ({}), run: async () => { calls++; },
  });
  const res = fakeRes();
  await route.handler(fakeReq('POST', '/api/image-tool/generate', { prompt: 'x' }), res);
  assert.equal(res.out.status, 403);
  assert.equal(calls, 0);
});

await test('apply：外部生成后 fetchUrl 能通过真实接线读回附件字节', async () => {
  const PNG = fs.readFileSync(path.join(ROOT, '_preview/shiyi-1.png'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  try {
    const ctx = makeCtx({ config: { apiUrl: 'https://x.example.com/v1', apiKey: 'k' } });
    let saved;
    const saveImage = ctx.attachments.saveImage;
    ctx.attachments.saveImage = async (input) => { saved = input.data; return saveImage(input); };
    ctx.attachments.readImage = async (ref) => { assert.equal(ref.attachmentId, 'att-fixture'); return { ref, data: saved }; };
    apply(ctx, {});
    const generated = await callRoute(ctx, 'POST', '/generate', { prompt: 'x' });
    assert.equal(generated.status, 200);
    const res = fakeRes();
    await ctx.routes[0].handler(fakeReq('GET', generated.body.images[0].fetchUrl), res);
    assert.equal(res.out.status, 200);
    assert.deepEqual(res.out.body, PNG);
    const download = fakeRes();
    await ctx.routes[0].handler(fakeReq('GET', generated.body.images[0].downloadUrl), download);
    assert.equal(download.out.status, 200);
    assert.match(download.out.headers['content-disposition'], /^attachment;/);
  } finally { globalThis.fetch = originalFetch; }
});

await test('execute：平台标准 agent.id 上下文会将真实 PNG 落盘', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-image-execute-'));
  const PNG = fs.readFileSync(path.join(ROOT, '_preview/shiyi-1.png'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  try {
    const ctx = makeCtx({ config: { apiUrl: 'https://x.example.com/v1', apiKey: 'k', confirmBeforeGenerate: false } });
    ctx.sessions.get = (id) => { assert.equal(id, 'session-real-shape'); return { header: { cwd: dir } }; };
    apply(ctx, {});
    const result = await ctx.registered[0].execute({ prompt: 'x' }, { agent: { id: 'session-real-shape' } });
    assert.equal(result.ok, true, result.note);
    assert.deepEqual(await fsp.readFile(result.images[0].diskPath), PNG);
    assert.match(result.note, /已生成至 \.\/generated-images\//);
    assert.equal(ctx.registered[0].presentResult({}, { content: [{ type: 'text', text: result.note }] }).content[0].text, result.note);
  } finally {
    globalThis.fetch = originalFetch;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

await test('下载：拒绝自动重定向并在流超过限制时立即取消', async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.redirect, 'error');
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(9)); },
      cancel() { cancelled = true; },
    }));
  };
  try {
    await assert.rejects(makeImageFetcher({ maxImageBytes: 8 })('https://cdn.example.com/x'), /超过/);
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = originalFetch; }
});

await test('保存路径：留空保持默认，相对和绝对目录均按配置保存，设置接口可回读', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'image-path-config-'));
  const originalFetch = globalThis.fetch;
  const PNG = fs.readFileSync(path.join(ROOT, '_preview/shiyi-1.png'));
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  try {
    for (const [savePath, expected] of [
      ['', path.join(dir, 'generated-images')],
      ['   ', path.join(dir, 'generated-images')],
      ['pictures/custom', path.join(dir, 'pictures', 'custom')],
      [path.join(dir, 'absolute'), path.join(dir, 'absolute')],
    ]) {
      const config = { apiUrl: 'https://x.example.com/v1', apiKey: 'k', savePath };
      const ctx = makeCtx({ config });
      apply(ctx, {});
      const written = await callRoute(ctx, 'POST', '/config', { savePath });
      assert.equal(written.status, 200);
      assert.equal((await callRoute(ctx, 'GET', '/config')).body.config.savePath, savePath);
      const result = await runGenerate(ctx, { config, args: { prompt: 'test' }, cwd: dir });
      assert.equal(result.ok, true, result.note);
      assert.equal(path.dirname(result.images[0].diskPath), expected);
      assert.deepEqual(await fsp.readFile(result.images[0].diskPath), PNG);
      assert.match(result.note, /已生成至/);
    }
  } finally { globalThis.fetch = originalFetch; await fsp.rm(dir, { recursive: true, force: true }); }
});

// ── 识别上游模型（设置页的「识别上游模型」按钮） ─────────────────────────────

await test('/models：缺鉴权服务时拒绝，绝不打上游', async () => {
  const { registerImageRoutes } = await import('../lib/routes.js');
  let route;
  let called = 0;
  registerImageRoutes({ register(r) { route = r; return () => {}; } }, {
    readConfig: () => ({}),
    listModels: async () => { called += 1; return { endpoint: 'x', models: [] }; },
  });
  const res = fakeRes();
  await route.handler(fakeReq('GET', '/api/image-tool/models'), res);
  assert.equal(res.out.status, 403);
  assert.equal(called, 0, '没有鉴权就不能替你打上游');
});

await test('GET /models：通过真实接线调用上游，回传排序后的模型列表', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://x.example.com/v1/models');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.authorization, 'Bearer secret-key');
    return new Response(JSON.stringify({ data: [{ id: 'z-model' }, { id: 'a-model' }] }), { status: 200 });
  };
  try {
    const ctx = makeCtx({ config: { apiUrl: 'https://x.example.com/v1', apiKey: 'secret-key' } });
    apply(ctx, {});
    const out = await callRoute(ctx, 'GET', '/models');
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.models, ['a-model', 'z-model']);
    assert.equal(out.body.count, 2);
    assert.equal(out.body.endpoint, 'https://x.example.com/v1/models');
  } finally { globalThis.fetch = originalFetch; }
});

await test('GET /models：配置不全时回可读原因而不是 500，且不外泄密钥', async () => {
  const ctx = makeCtx({ config: { apiUrl: '', apiKey: 'sk-should-not-leak-1234' } });
  apply(ctx, {});
  const out = await callRoute(ctx, 'GET', '/models');
  assert.equal(out.status, 400);
  assert.match(out.body.error, /未配置生图接口地址/);
  assert.equal(JSON.stringify(out.body).includes('sk-should-not-leak'), false, '错误信息里不能带出密钥');
});

await test('GET /models：不支持查询的 composition 回 501，而不是假装成功', async () => {
  const { registerImageRoutes } = await import('../lib/routes.js');
  let route;
  registerImageRoutes({ register(r) { route = r; return () => {}; } }, {
    readConfig: () => ({ apiUrl: 'https://x.example.com/v1', apiKey: 'k' }),
    // 有鉴权、但没有 listModels —— 这才是"composition 不支持查询"的真实形态。
    // （没有 connection 会先撞上 403，那是另一条用例专门验的优先级。）
    connection: { requestRejection: () => undefined },
  });
  const res = fakeRes();
  await route.handler(fakeReq('GET', '/api/image-tool/models'), res);
  assert.equal(res.out.status, 501);
});

console.log(failures ? `\n${failures} 个用例失败` : '\n全部通过');
if (failures) process.exit(1);
