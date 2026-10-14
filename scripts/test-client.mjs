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
    /**
     * ⚠️ children 必须**同时**进 props：真实 React 里 children 属于 props，而
     * `Row` / `Card` / `Button` 都是解构 `{ children }` 来用的。
     *
     * 早先这里只把 children 放在 element 顶层，于是这些组件在测试里渲染出的子树
     * 是空的 —— 测试看不到它们的内容，"点保存按钮""点识别按钮"这类断言全部落空，
     * 而组件本身在真实环境里其实是好的。桩失真比没有桩更危险：它给你假的安全感。
     */
    createElement: (type, props, ...children) => ({
      type,
      props: {
        ...(props ?? {}),
        children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
      },
      // 顶层 children 保留：摊平工具按 element 树遍历，这里更直接。
      children,
    }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
  };
}

/**
 * 造一个 client 半的 ctx 假体：分开记录 toolview 与设置页两种注册。
 *
 * 必须按 `name` 区分，不能"谁最后注册谁就是设置页" —— 那个顺序是实现的巧合，
 * 加一条注册就会把断言指到别的组件上，而测试仍然"通过"。
 */
function makeSlotsCtx() {
  const registrations = [];
  const injected = [];
  const ctx = {
    slots: {
      inject: (key, callback) => {
        injected.push(key);
        callback();
        return () => {};
      },
      register: (registration, component) => {
        registrations.push({ registration, component });
        return () => {};
      },
    },
  };
  return {
    ctx,
    registrations,
    injected,
    toolviews: () => registrations.filter((item) => item.registration.name === 'tool.call.toolview'),
    settings: () => registrations.filter((item) => item.registration.name === 'settings.section'),
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

await test('ModuleLoader 定义：带 id，只 require 外壳提供的 react / react-dom', () => {
  assert.equal(definition.id, 'dsh-image-tool');
  const required = [];
  const exports = definition.factory((name) => { required.push(name); return makeReactStub(); });
  assert.deepEqual(required, ['react', 'react-dom'], `只应 require react 与 react-dom，实际 ${required.join(', ')}`);
  assert.ok(exports, 'factory 必须返回模块导出');
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(exports.inject, ['slots'], '只应依赖 slots 服务');
  assert.equal(exports.name, 'dsh-image-tool');
});

await test('拿不到 react-dom 时照样能加载（退回就地渲染，而不是整块崩掉）', () => {
  const required = [];
  const exports = definition.factory((name) => {
    required.push(name);
    if (name === 'react-dom') throw new Error('module not found');
    return makeReactStub();
  });
  assert.ok(exports, 'react-dom 缺失不应让整个模块加载失败');
  const slots = makeSlotsCtx();
  assert.doesNotThrow(() => exports.apply(slots.ctx), 'apply 不应因缺少 react-dom 而抛错');
  assert.equal(slots.toolviews().length, 2, '图片卡仍然要注册');
});

await test('apply 把设置页注册到 settings.section，且 id/label 正确', () => {
  const exports = definition.factory(() => makeReactStub());
  const slots = makeSlotsCtx();
  exports.apply(slots.ctx);
  const settings = slots.settings();
  assert.equal(settings.length, 1, '应恰好注册一个设置分区');
  const { registration, component } = settings[0];
  assert.equal(registration.name, 'settings.section');
  assert.equal(registration.id, 'image-tool', 'id 必须是 image-tool（与命名空间一致，便于定位）');
  assert.equal(typeof registration.order, 'number');
  assert.equal(registration.label(), '图像生成', '设置页标题应为「图像生成」');
  assert.equal(typeof component, 'function', '第二个参数必须是组件');
});

await test('apply 为生图与改图两个工具各注册一张工具卡（key 必须等于工具名）', () => {
  const exports = definition.factory(() => makeReactStub());
  const slots = makeSlotsCtx();
  exports.apply(slots.ctx);

  const views = slots.toolviews();
  assert.deepEqual(
    views.map((item) => item.registration.key).sort(),
    ['generate_image', 'image_edit'],
    'key 必须逐字等于 host 半注册的工具名，写错就是"永远不渲染"且没有任何提示',
  );
  for (const view of views) {
    assert.equal(view.registration.priority, -1, 'keyed 槽位同 key 同优先级会抛错，必须压低优先级');
    assert.equal(typeof view.component, 'function');
    // 声明 tool.call.images 子槽会让整条注册失败：内置 read_image 已经声明了它，
    // 而"一个子槽只能由一个 entry 声明"。这条断言就是防止有人"顺手加上"。
    assert.equal(view.registration.children, undefined, '不得声明 tool.call.images 子槽');
  }
});

await test('组件首次渲染不抛错（读配置前显示占位，而不是崩掉）', () => {
  const exports = definition.factory(() => makeReactStub());
  const slots = makeSlotsCtx();
  exports.apply(slots.ctx);
  const component = slots.settings()[0]?.component;
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

/**
 * 有状态 React 桩：useState 按调用顺序分配格子，格子按初始值自动补齐。
 *
 * 之所以要"自动补齐"而不是写死数组长度：组件每加一个 useState，固定长度的数组就会
 * **静默错位** —— 多出来的格子读到 undefined，测试要么崩，要么更糟：放过一个真 bug。
 *
 * `unit` 是**按组件分桶**的渲染单元：一次测试里先后渲染两个组件（工具卡 + 它内部的
 * 缩略图）时，共用一个游标会让第二个组件读到第一个组件的格子，断言看似通过其实测的是
 * 别的东西。默认桶仍叫 default，老的调用方式不受影响。
 */
function makeStatefulReact(initialByIndex = {}) {
  const buckets = new Map();
  let unit = 'default';
  let cursor = 0;
  const bucketOf = (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map());
    return buckets.get(name);
  };
  const React = {
    ...makeReactStub(),
    useState: (initial) => {
      const index = cursor++;
      const cells = bucketOf(unit);
      if (!cells.has(index)) {
        cells.set(index, unit === 'default' && index in initialByIndex
          ? initialByIndex[index]
          : (typeof initial === 'function' ? initial() : initial));
      }
      return [cells.get(index), (next) => {
        cells.set(index, typeof next === 'function' ? next(cells.get(index)) : next);
      }];
    },
  };
  return {
    React,
    cell: (index, name = 'default') => bucketOf(name).get(index),
    /** 每轮渲染前调用：hook 的调用顺序在每一轮里都从 0 重新开始。 */
    beginRender: (name = 'default') => { unit = name; cursor = 0; },
  };
}

/** 把 element 树摊平成数组（children 可能是嵌套数组或 null）。 */
function flatten(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...(tree.children ?? []).flat(Infinity).flatMap(flatten)];
}

/** 装配设置页并返回一个"渲染一次"的函数，拿到的是摊平后的 element 列表。 */
function mountClient(initialByIndex) {
  const state = makeStatefulReact(initialByIndex);
  const slots = makeSlotsCtx();
  // 用带状态的 React：设置页有 useState。
  definition.factory(() => state.React).apply(slots.ctx);
  const component = slots.settings()[0]?.component;
  assert.ok(component, '必须注册出设置页组件');
  return {
    state,
    render: () => { state.beginRender(); return flatten(component().type()); },
  };
}

/**
 * 装配工具卡并渲染一次。
 *
 * `loadImage` 是 owner props 提供的**会话授权加载器**：这里给一个带 `peek` 的桩，
 * 因为组件的初始 URL 就来自 `peek`（`useEffect` 在桩里不执行，避免测试变成
 * "验证 promise 时序"而不是"验证卡片渲染了什么"）。
 */
function mountToolview(toolName, props = {}) {
  const state = makeStatefulReact();
  const slots = makeSlotsCtx();
  definition.factory(() => state.React).apply(slots.ctx);
  const view = slots.toolviews().find((item) => item.registration.key === toolName);
  assert.ok(view, `必须注册 ${toolName} 的工具卡`);
  const ownerProps = {
    toolName,
    callId: 'call-1',
    phase: 'result',
    cwd: 'D:\\work',
    openFile: () => {},
    loadImage: Object.assign(async () => 'blob:fake-url', { peek: () => 'blob:fake-url' }),
    ...props,
  };
  return {
    state,
    /** 渲染工具卡本体。 */
    row: (next = {}) => {
      state.beginRender('row');
      return view.component({ ...ownerProps, ...next });
    },
    /** 单独渲染卡片内部的一个子组件（createElement 桩不会执行它们）。 */
    child: (element, unit = 'child') => {
      state.beginRender(unit);
      return element.type(element.props);
    },
  };
}

/**
 * 模型下拉是否已出现。
 *
 * ⚠️ 读的是 `Row` element 上的 `hint` prop，而不是它渲染出的文本：摊平工具只遍历
 * element 树，**不执行自定义组件**，所以 `Row` 内部的 div 根本不在这棵树里。
 * 找渲染结果会永远找不到 —— 早先就踩了这一下。
 */
const hasModelPicker = (tree) => tree.some(n => typeof n.props?.hint === 'string' && n.props.hint.includes('上游共'));

await test('默认保存路径控件读取配置并提交保存', async () => {
  const { render } = mountClient({ 0: { savePath: 'pictures' } });
  let tree = render();
  const input = tree.find(n => n.props.placeholder === '留空：./generated-images/');
  assert.equal(input.props.value, 'pictures');
  input.props.onChange('custom-images');
  tree = render();
  assert.equal(tree.find(n => n.props.placeholder === '留空：./generated-images/').props.value, 'custom-images');

  const originalFetch = globalThis.fetch;
  let saved;
  globalThis.fetch = async (_url, init) => {
    if (init.method === 'POST') saved = JSON.parse(init.body);
    return new Response(JSON.stringify(init.method === 'POST' ? { ok: true } : { config: saved }));
  };
  try {
    await tree.find(n => n.props.tone === 'primary' && String(n.props.children) === '保存').props.onClick();
    assert.equal(saved.savePath, 'custom-images');
  } finally { globalThis.fetch = originalFetch; }
});

await test('识别上游模型：渲染不请求，点按钮才打 /models，成功后出现可选下拉', async () => {
  const { state, render } = mountClient({ 0: { apiUrl: 'https://x.example.com/v1', model: '' } });

  let tree = render();
  const button = tree.find(n => String(n.props?.children) === '识别上游模型');
  assert.ok(button, '设置页应有「识别上游模型」按钮');
  assert.equal(hasModelPicker(tree), false, '还没识别时不应出现模型下拉');

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ ok: true, models: ['gpt-image-1', 'dall-e-3'], count: 2 }), { status: 200 });
  };
  try {
    // 打开设置页本身**绝不能**打上游 —— 那等于替用户发了一次他没要的请求。
    assert.equal(calls.length, 0, '渲染本身不应触发上游请求');
    await button.props.onClick();
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/image-tool\/models$/);
    assert.equal(calls[0].method, 'GET');

    tree = render();
    assert.equal(hasModelPicker(tree), true, '识别成功后应出现模型下拉');
    const select = tree.find(n => Array.isArray(n.props?.options)
      && n.props.options.some(o => o.value === 'gpt-image-1'));
    assert.ok(select, '下拉里应有识别到的模型');
    assert.deepEqual(select.props.options.map(o => o.value), ['', 'gpt-image-1', 'dall-e-3']);
    assert.equal(state.cell(6).length, 2, '识别结果应存进 models 状态');

    // 选中即填入输入框；**不自动保存** —— 仍然要用户点「保存」。
    select.props.onChange('gpt-image-1');
    tree = render();
    assert.equal(tree.find(n => n.props.placeholder === 'gpt-image-1').props.value, 'gpt-image-1');
    assert.equal(state.cell(0).model, 'gpt-image-1');
  } finally { globalThis.fetch = originalFetch; }
});

await test('识别失败：显示上游给的原因，且不留下过期下拉', async () => {
  const { render } = mountClient({ 0: { apiUrl: 'https://x.example.com/v1', model: '' } });
  let tree = render();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ ok: false, error: '上游没有返回任何模型。有些服务不提供 /models 端点，请手动填写模型名。' }),
    { status: 400 },
  );
  try {
    await tree.find(n => String(n.props?.children) === '识别上游模型').props.onClick();
    tree = render();
    assert.equal(hasModelPicker(tree), false, '识别失败后不应留下可选下拉');
    const failed = tree.find(n => String(n.children ?? '').includes('识别失败'));
    assert.ok(failed, '应把失败原因显示给用户');
    assert.match(String(failed.children), /不提供 \/models 端点/);
  } finally { globalThis.fetch = originalFetch; }
});

await test('尺寸下拉：覆盖 1K / 2K / 4K 与 16:9、16:10、竖屏、电影画幅', () => {
  const { render } = mountClient({ 0: { size: '1024x1024' } });
  const tree = render();
  // 只有尺寸下拉用了分组（张数是扁平列表）
  const sizeSelect = tree.find(n => Array.isArray(n.props?.options)
    && n.props.options.some(o => Array.isArray(o.options)));
  assert.ok(sizeSelect, '尺寸应当是分组下拉');
  assert.equal(sizeSelect.props.value, '1024x1024');

  const groups = sizeSelect.props.options.filter(o => Array.isArray(o.options));
  const groupLabels = groups.map(g => g.group);
  for (const prefix of ['1K', '2K', '4K', 'OpenAI']) {
    assert.ok(groupLabels.some(l => l.startsWith(prefix)), `应有 ${prefix} 分组，实际：${groupLabels.join(' / ')}`);
  }

  const values = sizeSelect.props.options.flatMap(o => (Array.isArray(o.options) ? o.options.map(x => x.value) : [o.value]));
  for (const [value, why] of [
    ['1024x1024', '1K 1:1'],
    ['1280x720', '1K 16:9'],
    ['1280x800', '1K 16:10'],
    ['1344x576', '1K 电影 21:9'],
    ['768x1024', '1K 竖屏 3:4'],
    ['720x1280', '1K 竖屏 9:16'],
    ['1920x1200', '2K 16:10'],
    ['2560x1080', '2K 电影 21:9'],
    ['1080x1920', '2K 竖屏 9:16'],
    ['4096x4096', '4K 1:1'],
    ['3840x2160', '4K 16:9'],
    ['3200x1440', '20:9 超宽'],
    ['1792x1024', 'OpenAI 宽'],
    ['512x512', '小图'],
  ]) {
    assert.ok(values.includes(value), `预设应包含 ${value}（${why}）`);
  }

  const allLabels = groups.flatMap(g => g.options.map(o => o.label)).join(' ');
  for (const text of ['16:9', '16:10', '21:9 电影', '竖屏']) {
    assert.ok(allLabels.includes(text), `标签里应能看出比例：${text}`);
  }
  // 第一项仍然是"不发送 size"
  assert.equal(sizeSelect.props.options[0].value, '');
});

await test('尺寸下拉：预设外的当前值会补成一项，避免下拉显示空白', () => {
  const { state, render } = mountClient({ 0: { size: '3000x2000' } });
  const findSize = (t) => t.find(n => Array.isArray(n.props?.options) && n.props.options.some(o => Array.isArray(o.options)));

  let select = findSize(render());
  assert.equal(select.props.value, '3000x2000', '下拉当前值应保持配置值');
  const current = select.props.options.find(o => o.value === '3000x2000');
  assert.ok(current, '预设外的当前值必须补成一项，否则下拉显示空白、用户会以为配置丢了');
  assert.match(current.label, /当前值/);

  // 改选预设值 → 写进配置
  select.props.onChange('1920x1080');
  assert.equal(state.cell(0).size, '1920x1080');
  select = findSize(render());
  assert.equal(select.props.value, '1920x1080');
  assert.equal(select.props.options.some(o => String(o.label).includes('当前值')), false, '已是预设值就不该再补项');
});

await test('尺寸下拉：空值与预设值都不触发补项', () => {
  for (const size of ['', '1024x1024']) {
    const { render } = mountClient({ 0: { size } });
    const select = render().find(n => Array.isArray(n.props?.options) && n.props.options.some(o => Array.isArray(o.options)));
    assert.equal(select.props.options.some(o => String(o.label).includes('当前值')), false, `size=${JSON.stringify(size)} 不该补项`);
  }
});

// ── 工具卡（内联生图块）──────────────────────────────────────────────────────
//
// 这一组测的是"用户到底看没看到图"：平台内置的图片卡只认 `read_image` 这一个工具名，
// 不注册我们自己的卡片，通用卡片会把 image 块 `JSON.stringify` 之后显示 ——
// 也就是说这个功能坏掉时的症状是"对话里出现一坨附件引用 JSON"，与"没报错"极像。

const FIXTURE_REF = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 2048, width: 1024, height: 1024, name: 'generated-123-1.png' };
const FIXTURE_PATH = 'D:\\work\\generated-images\\generated-123-1.png';

function resultBlock() {
  return {
    kind: 'result',
    isError: false,
    content: [
      { type: 'text', text: '已生成 1 张图片（模型 gpt-image-1）。\n已保存到：' + FIXTURE_PATH },
      { type: 'image', attachment: FIXTURE_REF },
    ],
    meta: {
      images: [{ attachmentId: 'att-1', mediaType: 'image/png', width: 1024, height: 1024, diskPath: FIXTURE_PATH }],
    },
  };
}

await test('工具卡：把结果里的 image 块画成真图，并给出下载与在工作区打开', () => {
  const view = mountToolview('generate_image');
  const nodes = flatten(view.row({ block: resultBlock() }));
  // 缩略图是子组件：createElement 桩不会执行它，要单独渲染一次才看得到 <img>。
  const thumb = nodes.find(n => typeof n.type === 'function' && n.props?.attachment);
  assert.ok(thumb, '结果里有 image 块时，必须为每张图渲染一个缩略图');
  const thumbNodes = flatten(view.child(thumb));

  const img = thumbNodes.find(n => n.type === 'img');
  assert.ok(img, '必须渲染真正的 <img> —— 这才是"内联图片卡"');
  assert.equal(img.props.src, 'blob:fake-url', '图片 URL 只能来自 owner props 的 loadImage（会话授权）');
  assert.ok(thumbNodes.some(n => n.type === 'a' && n.props.download === FIXTURE_REF.name), '每张图应有下载入口');
  const open = thumbNodes.find(n => n.type === 'button' && typeof n.props?.title === 'string' && n.props.title.startsWith('./'));
  assert.ok(open, '落盘过的图应能一键在工作区打开，且用相对路径');
  assert.ok(JSON.stringify(nodes).includes('已生成 1 张图片'), '文本说明要保留在卡片里');
});

await test('工具卡：文本区绝不出现附件引用 JSON', () => {
  const view = mountToolview('generate_image');
  const nodes = flatten(view.row({ block: resultBlock() }));
  const pre = nodes.find(n => n.type === 'pre');
  const text = JSON.stringify(pre ?? {});
  assert.ok(!text.includes('attachmentId'), '文本区出现附件引用 JSON，正是"没有图片卡"时的症状');
  assert.match(text, /generated-123-1\.png/, '应当显示可读的保存路径');
});

await test('工具卡：进行中不显示图片，而是给出等待时间', () => {
  const view = mountToolview('image_edit');
  const nodes = flatten(view.row({
    phase: 'start',
    block: { phase: 'start', name: 'image_edit', callId: 'call-1', argsRaw: '{}' },
  }));
  const text = JSON.stringify(nodes);
  assert.match(text, /正在改图/, '进行中要说明在做什么');
  assert.match(text, /已等待/, '同步接口几十秒很正常，必须让用户看到还在跑');
  assert.ok(!nodes.some(n => n.type === 'img'), '还没有结果时不该出现图片');
});

await test('工具卡：改图时显示原图来源', () => {
  const view = mountToolview('image_edit');
  const block = resultBlock();
  block.content[0] = { type: 'text', text: '已改图 1 张图片（模型 gpt-image-1）。' };
  block.meta.origin = '会话里最近一张图片 att-9';
  const text = JSON.stringify(flatten(view.row({ block })));
  assert.match(text, /会话里最近一张图片 att-9/, '用户必须能核对模型改的是不是他以为的那张图');
});

await test('工具卡：失败时渲染错误态，而不是假装成功', () => {
  const view = mountToolview('generate_image');
  const nodes = flatten(view.row({
    block: { kind: 'result', isError: true, content: [{ type: 'text', text: '生图失败：连不上上游' }] },
  }));
  const text = JSON.stringify(nodes);
  assert.match(text, /失败/);
  assert.ok(
    nodes.some(n => n.props?.style?.color === 'var(--dsw-alias-state-error-primary)'),
    '失败态要用错误色，而不是和成功长得一样',
  );
  assert.ok(!nodes.some(n => n.type === 'img'), '失败时不该出现图片');
});

console.log(failures ? `\n${failures} 个用例失败` : '\n全部通过');
if (failures) process.exit(1);
