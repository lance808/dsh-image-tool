// client.js（浏览器半）的离线测试。
//
// 为什么值得单独测：浏览器半的加载失败在真实环境里表现为**设置页白屏或整块不出现**，
// 而这个文件不是被 Node 直接 import 的 —— 它由外壳的 `window.__ModuleLoader__` 加载，
// 单元测试框架默认碰不到它。最常见的三种错（模块语法、导出名、槽位 id/字段写错）
// 都能在这里离线抓住。
//
// 做法：自己造一个最小的 ModuleLoader 与 React 桩，按外壳的方式把模块跑一遍。
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.message}`); }
}

/** 造一个最小的 React 桩：只实现 client.js 真正用到的那几个 hook。 */
function makeReactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
}

/** 按外壳的方式加载 client.js，返回它的模块导出与注册记录。 */
async function loadClientModule() {
  const loaded = [];
  // client.js 第一句就是 window.__ModuleLoader__.load({...})，所以要先立好全局。
  globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
  try {
    await import(pathToFileURL(path.join(ROOT, 'client.js')).href);
  } finally {
    delete globalThis.window;
  }
  assert.equal(loaded.length, 1, 'client.js 应当且只应当调用一次 __ModuleLoader__.load');
  const definition = loaded[0];
  assert.equal(typeof definition.factory, 'function', 'definition 必须带 factory');
  assert.equal(typeof definition.id, 'string', 'definition 必须带 id');
  return definition;
}

const definition = await loadClientModule();

await test('ModuleLoader 定义：带 id，factory 只 require("react")', () => {
  assert.equal(definition.id, 'dsh-image-tool');
  const required = [];
  const exports = definition.factory((name) => { required.push(name); return makeReactStub(); });
  assert.deepEqual(required, ['react'], `只应 require react，实际 ${required.join(', ')}`);
  assert.ok(exports, 'factory 必须返回模块导出');
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(exports.inject, ['slots'], '只应依赖 slots 服务');
  assert.equal(exports.name, 'dsh-image-tool');
});

await test('apply 把设置页注册到 settings.section，且 id/label 正确', () => {
  const registrations = [];
  const React = makeReactStub();
  const exports = definition.factory(() => React);
  const ctx = {
    slots: {
      inject: (key, callback) => { assert.equal(key, 'settings.section'); callback(); return () => {}; },
      register: (registration, component) => {
        registrations.push({ registration, component });
        return () => {};
      },
    },
  };
  exports.apply(ctx);
  assert.equal(registrations.length, 1, '应恰好注册一个设置分区');
  const { registration, component } = registrations[0];
  assert.equal(registration.name, 'settings.section');
  assert.equal(registration.id, 'image-tool', 'id 必须是 image-tool（与命名空间一致，便于定位）');
  assert.equal(typeof registration.order, 'number');
  assert.equal(registration.label(), '图像生成', '设置页标题应为「图像生成」');
  assert.equal(typeof component, 'function', '第二个参数必须是组件');
});

await test('组件首次渲染不抛错（读配置前显示占位，而不是崩掉）', () => {
  const React = makeReactStub();
  const exports = definition.factory(() => React);
  let component = null;
  exports.apply({
    slots: {
      inject: (_key, callback) => { callback(); return () => {}; },
      register: (_registration, comp) => { component = comp; return () => {}; },
    },
  });
  assert.ok(component);
  // 注意渲染语义：注册进来的是**包装函数**（外壳会把它当函数组件调用），
  // 它返回一个 element；真正要渲染的是那个 element 的 type。
  // 直接 `component()` 得到的是 element 而不是渲染结果 —— 这里踩过一次。
  const element = component();
  assert.ok(element, '包装函数必须返回一个 element');
  assert.equal(typeof element.type, 'function', 'element 的 type 应当是真正的页面组件');
  const tree = element.type();
  assert.ok(tree, '首次渲染必须返回节点');
  const text = JSON.stringify(tree);
  assert.match(text, /正在读取配置/, `首次渲染应显示占位文案，实际 ${text.slice(0, 200)}`);
});

await test('组件不写死颜色（全部走主题变量，深浅色切换后可读）', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  // 找出所有形如 #rrggbb / rgb( / rgba( 的字面颜色
  const literals = source.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? [];
  assert.deepEqual(literals, [], `不应出现字面颜色，实际：${literals.join(', ')}`);
  assert.match(source, /--dsw-alias-/, '应使用外壳的主题变量');
});

await test('前端绝不持有密钥：不读 apiKey 字段，只读 hasKey/keyHint', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  assert.match(source, /hasKey/);
  assert.match(source, /keyHint/);
  // 允许出现 apiKey 这个**字段名**（提交时才带），但不允许把响应里的 apiKey 回填到状态里。
  assert.ok(
    !/setConfig\([^)]*apiKey/.test(source) && !/config\.apiKey/.test(source),
    '不应把 apiKey 从响应回填进状态',
  );
  assert.match(source, /delete body\.apiKey/, '提交配置时应剔除 apiKey 字段，只在有输入时才带上');
});

await test('默认保存路径控件读取配置并提交保存', async () => {
  const state = [{ savePath: 'pictures' }, false, null, '', false, null];
  let cursor = 0;
  const React = { ...makeReactStub(), useState: () => {
    const index = cursor++;
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  } };
  let component;
  definition.factory(() => React).apply({ slots: {
    inject: (_key, cb) => cb(), register: (_registration, comp) => { component = comp; },
  } });
  const render = () => { cursor = 0; return component().type(); };
  function nodes(tree) {
    if (!tree || typeof tree !== 'object') return [];
    return [tree, ...(tree.children ?? []).flat(Infinity).flatMap(nodes)];
  }
  let tree = nodes(render());
  const input = tree.find(n => n.props.placeholder === '留空：./generated-images/');
  assert.equal(input.props.value, 'pictures');
  input.props.onChange('custom-images');
  tree = nodes(render());
  assert.equal(tree.find(n => n.props.placeholder === '留空：./generated-images/').props.value, 'custom-images');
  const originalFetch = globalThis.fetch;
  let saved;
  globalThis.fetch = async (_url, init) => {
    if (init.method === 'POST') saved = JSON.parse(init.body);
    return new Response(JSON.stringify(init.method === 'POST' ? { ok: true } : { config: saved }));
  };
  try {
    await tree.find(n => n.props.tone === 'primary' && n.children.includes('保存')).props.onClick();
    assert.equal(saved.savePath, 'custom-images');
  } finally { globalThis.fetch = originalFetch; }
});

console.log(failures ? `\n${failures} 个用例失败` : '\n全部通过');
if (failures) process.exit(1);
