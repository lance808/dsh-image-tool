// generate.js 的离线单元测试 —— 生图协议的纯逻辑部分。
//
// 这里不连任何真实上游、不碰 ctx，所以可以放心钉死那些"错了会很贵"的判断：
//   · SSRF 关卡（上游返回的图片地址能不能抓）
//   · 回包解析（base64 / 链接 / 嵌套三种形态）
//   · 请求体构造（哪些字段该发、哪些不该发）
// 一次真实生图调用几十秒且计费，拿它当测试用例不合适；这些纯函数才是回归的主战场。
import assert from 'node:assert/strict';
import {
  ImageToolError,
  assertFetchableImageUrl,
  buildEditFormData,
  buildEditPayload,
  buildRequestPayload,
  callImageApi,
  callImageEditApi,
  clampCount,
  decodeImages,
  editImages,
  editsEndpoint,
  generationsEndpoint,
  generateImages,
  isPrivateHost,
  listModels,
  modelsEndpoint,
  normalizeApiUrl,
  parseModelList,
  sniffMediaType,
} from '../lib/generate.js';

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.message}`); }
}

// ── 测试用的图片字节（只要求魔数正确、长度够） ──────────────────────────────
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12, 2)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(4, 4)]);
const UNKNOWN = Buffer.alloc(16, 9);

await test('normalizeApiUrl：缺配置 / 非法 / 非 http 分别给出可读的错误码', () => {
  assert.throws(() => normalizeApiUrl(''), /未配置生图接口地址/);
  assert.throws(() => normalizeApiUrl('not a url'), /不是合法 URL/);
  assert.throws(() => normalizeApiUrl('ftp://example.com'), /必须是 http\/https/);
  assert.equal(normalizeApiUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
  // 本地服务必须被允许（这是正当用法，不能拦）
  assert.equal(normalizeApiUrl('http://127.0.0.1:7860'), 'http://127.0.0.1:7860');
});

await test('generationsEndpoint：拼接端点，且已写到端点上的地址不重复拼', () => {
  assert.equal(generationsEndpoint('https://api.openai.com/v1'), 'https://api.openai.com/v1/images/generations');
  assert.equal(generationsEndpoint('https://api.openai.com/v1/'), 'https://api.openai.com/v1/images/generations');
  assert.equal(
    generationsEndpoint('https://relay.example.com/v1/images/generations'),
    'https://relay.example.com/v1/images/generations',
  );
});

await test('isPrivateHost：环回 / 私网 / 链路本地 / IPv6 全覆盖', () => {
  for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', 'fc00::1', '::ffff:127.0.0.1', 'foo.local']) {
    assert.equal(isPrivateHost(host), true, `${host} 应判为内网/本机`);
  }
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '11.0.0.1', '2001:4860:4860::8888']) {
    assert.equal(isPrivateHost(host), false, `${host} 应判为公网`);
  }
});

await test('assertFetchableImageUrl：放行公网、拒绝内网与非法协议', () => {
  assert.equal(assertFetchableImageUrl('https://cdn.example.com/a.png'), 'https://cdn.example.com/a.png');
  assert.throws(() => assertFetchableImageUrl('http://169.254.169.254/latest/meta-data/'), /内网\/本机/);
  assert.throws(() => assertFetchableImageUrl('http://127.0.0.1:8080/x.png'), /内网\/本机/);
  assert.throws(() => assertFetchableImageUrl('file:///etc/passwd'), /协议不被允许/);
  assert.throws(() => assertFetchableImageUrl('不是地址'), /不是合法 URL/);
});

await test('buildRequestPayload：prompt 必填，可选字段只带配置过的', () => {
  assert.throws(() => buildRequestPayload({}, {}), /prompt 不能为空/);
  const minimal = buildRequestPayload({}, { prompt: '一只猫' });
  assert.deepEqual(minimal, { prompt: '一只猫', n: 1, response_format: 'b64_json' });
  // 未配置的可选透传项不该出现在请求体里（未知字段会被部分上游 400）
  assert.ok(!('quality' in minimal) && !('size' in minimal) && !('model' in minimal));

  const full = buildRequestPayload(
    { model: 'gpt-image-1', size: '1024x1024', quality: 'hd', style: 'vivid', outputFormat: 'webp' },
    { prompt: '一只猫', count: 3 },
  );
  assert.equal(full.model, 'gpt-image-1');
  assert.equal(full.n, 3);
  assert.equal(full.size, '1024x1024');
  assert.equal(full.quality, 'hd');
  assert.equal(full.style, 'vivid');
  assert.equal(full.output_format, 'webp');
  assert.ok(!('outputFormat' in full));
});

await test('clampCount：钳在 1~8，非法值回落 1', () => {
  assert.equal(clampCount(0), 1);
  assert.equal(clampCount(99), 8);
  assert.equal(clampCount(2.7), 2);
  assert.equal(clampCount('abc'), 1);
  assert.equal(clampCount(undefined), 1);
});

await test('sniffMediaType：按魔数判断，不信任上游声明', () => {
  assert.equal(sniffMediaType(PNG), 'image/png');
  assert.equal(sniffMediaType(JPEG), 'image/jpeg');
  assert.equal(sniffMediaType(GIF), 'image/gif');
  assert.equal(sniffMediaType(WEBP), 'image/webp');
  // 认不出来时回落到声明值；声明值也不合法则回落到 png
  assert.equal(sniffMediaType(UNKNOWN, 'image/jpeg'), 'image/jpeg');
  assert.equal(sniffMediaType(UNKNOWN, 'application/octet-stream'), 'image/png');
});

await test('decodeImages：支持 b64_json / url / 嵌套 image_url 三种形态', async () => {
  const b64 = await decodeImages({ body: { data: [{ b64_json: PNG.toString('base64') }] } });
  assert.equal(b64.length, 1);
  assert.equal(b64[0].mediaType, 'image/png');
  assert.equal(b64[0].source, 'base64');

  let fetched = null;
  const byUrl = await decodeImages({
    body: { data: [{ url: 'https://cdn.example.com/a.jpg' }] },
    fetchImage: async (url) => { fetched = url; return { buffer: JPEG, mediaType: 'image/jpeg' }; },
  });
  assert.equal(fetched, 'https://cdn.example.com/a.jpg');
  assert.equal(byUrl[0].mediaType, 'image/jpeg');
  assert.equal(byUrl[0].source, 'url');

  const nested = await decodeImages({
    body: { data: [{ image_url: { url: 'https://cdn.example.com/b.png' } }] },
    fetchImage: async () => ({ buffer: PNG, mediaType: 'image/png' }),
  });
  assert.equal(nested.length, 1);

  // data URL 前缀要能剥掉
  const dataUrl = await decodeImages({ body: { data: [{ b64_json: `data:image/png;base64,${PNG.toString('base64')}` }] } });
  assert.equal(dataUrl[0].buffer.byteLength, PNG.byteLength);
});

await test('decodeImages：空 / 缺字段 / 内网链接 / 超限都要明确失败', async () => {
  await assert.rejects(() => decodeImages({ body: { data: [] } }), /没有返回任何图片/);
  await assert.rejects(() => decodeImages({ body: { error: { message: 'quota' } } }), /quota/);
  await assert.rejects(() => decodeImages({ body: { data: [{}] } }), /既没有 base64 也没有链接/);
  await assert.rejects(
    () => decodeImages({ body: { data: [{ url: 'http://169.254.169.254/x' }] }, fetchImage: async () => ({ buffer: PNG }) }),
    /内网\/本机/,
  );
  await assert.rejects(
    () => decodeImages({ body: { data: [{ b64_json: PNG.toString('base64') }] }, maxImageBytes: 4 }),
    /超过上限/,
  );
  await assert.rejects(
    () => decodeImages({ body: { data: [{ b64_json: '' }] } }),
    /既没有 base64 也没有链接|内容为空/,
  );
});

await test('callImageApi：缺 Key 直接拒绝，不打网络', async () => {
  let called = false;
  await assert.rejects(
    () => callImageApi({ config: { apiUrl: 'https://x.example.com/v1' }, payload: {}, fetchImpl: async () => { called = true; } }),
    /未配置生图 API Key/,
  );
  assert.equal(called, false, '缺 Key 时不应该发出任何请求');
});

await test('callImageApi：HTTP 错误与非法 JSON 都转成可读错误', async () => {
  await assert.rejects(
    () => callImageApi({
      config: { apiUrl: 'https://x.example.com/v1', apiKey: 'k' },
      payload: {},
      fetchImpl: async () => new Response('{"error":"bad"}', { status: 401 }),
    }),
    /HTTP 401/,
  );
  await assert.rejects(
    () => callImageApi({
      config: { apiUrl: 'https://x.example.com/v1', apiKey: 'k' },
      payload: {},
      fetchImpl: async () => new Response('<html>gateway</html>', { status: 200 }),
    }),
    /不是合法 JSON/,
  );
});

await test('callImageApi：响应头已返回但正文挂起时仍按超时失败', async () => {
  await assert.rejects(
    () => callImageApi({
      config: { apiUrl: 'https://x.example.com/v1', apiKey: 'k' },
      payload: {},
      timeoutMs: 20,
      fetchImpl: async (_url, init) => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":['));
            init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
          },
        });
        return new Response(body, { status: 200 });
      },
    }),
    /被中止或超时/,
  );
});

await test('generateImages：端到端（假上游 + 假附件），并把附件名带上扩展名', async () => {
  const saved = [];
  const result = await generateImages({
    config: { apiUrl: 'https://x.example.com/v1', apiKey: 'k', model: 'm' },
    args: { prompt: '一只猫', count: 2 },
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://x.example.com/v1/images/generations');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.authorization, 'Bearer k');
      const body = JSON.parse(init.body);
      assert.equal(body.prompt, '一只猫');
      assert.equal(body.n, 2);
      return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }, { b64_json: JPEG.toString('base64') }] }), { status: 200 });
    },
    saveImage: async (input) => {
      saved.push(input);
      return { attachmentId: `att-${saved.length}`, mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1, name: input.name };
    },
  });
  assert.equal(result.images.length, 2);
  assert.equal(saved.length, 2);
  assert.match(saved[0].name, /\.png$/);
  assert.match(saved[1].name, /\.jpg$/);
  assert.equal(result.images[0].ref.attachmentId, 'att-1');
});

// ── 改图（/images/edits，multipart） ─────────────────────────────────────────

await test('editsEndpoint：生图端点会被退回，不会拼出 /images/generations/images/edits', () => {
  assert.equal(editsEndpoint('https://x.example.com/v1'), 'https://x.example.com/v1/images/edits');
  assert.equal(editsEndpoint('https://x.example.com/v1/images/generations'), 'https://x.example.com/v1/images/edits');
  assert.equal(editsEndpoint('https://x.example.com/v1/images/edits'), 'https://x.example.com/v1/images/edits');
  assert.equal(editsEndpoint('http://127.0.0.1:7860/v1/'), 'http://127.0.0.1:7860/v1/images/edits');
  assert.throws(() => editsEndpoint(''), /未配置生图接口地址/);
});

await test('buildEditPayload：必须同时有 prompt 与原图', () => {
  const config = { editModel: 'edit-m', editSize: '512x512' };
  assert.throws(() => buildEditPayload(config, { prompt: '  ' }, { image: { buffer: PNG, mediaType: 'image/png' } }), /prompt 不能为空/);
  assert.throws(() => buildEditPayload(config, { prompt: '改成夜景' }, {}), /缺少原图/);
  assert.throws(() => buildEditPayload(config, { prompt: '改成夜景' }, { image: { buffer: Buffer.alloc(0), mediaType: 'image/png' } }), /缺少原图/);
});

await test('buildEditPayload：改图模型/尺寸优先，缺省回退生图的那两个', () => {
  const image = { buffer: PNG, mediaType: 'image/png', name: 'in.png' };
  const withEdit = buildEditPayload({ model: 'gen-m', editModel: 'edit-m', size: '1024x1024', editSize: '512x512' }, { prompt: 'x' }, { image });
  assert.equal(withEdit.fields.model, 'edit-m');
  assert.equal(withEdit.fields.size, '512x512');
  assert.equal(withEdit.fields.response_format, 'b64_json', '显式要 base64，省掉一次下载与 SSRF 判定');
  assert.equal(withEdit.fields.n, '1');

  const fallback = buildEditPayload({ model: 'gen-m', size: '1024x1024' }, { prompt: 'x' }, { image });
  assert.equal(fallback.fields.model, 'gen-m', '没配改图模型时沿用生图模型');
  assert.equal(fallback.fields.size, '1024x1024');

  // 两处尺寸都没配 → **不发 size**，让上游按原图尺寸处理（显式给尺寸常导致重绘/裁切）
  const noSize = buildEditPayload({ model: '' }, { prompt: 'x' }, { image });
  assert.equal('size' in noSize.fields, false);
  assert.equal('model' in noSize.fields, false, '模型留空就不发 model 字段，由上游默认');

  // 参数优先于配置
  const explicit = buildEditPayload({ editModel: 'a', editSize: '1x1' }, { prompt: 'x', model: 'b', size: '2x2', count: 3 }, { image });
  assert.equal(explicit.fields.model, 'b');
  assert.equal(explicit.fields.size, '2x2');
  assert.equal(explicit.fields.n, '3');
});

await test('buildEditFormData：字段进表单、原图与 mask 是二进制字段', () => {
  const payload = buildEditPayload({ editModel: 'm' }, { prompt: '改成夜景' }, {
    image: { buffer: PNG, mediaType: 'image/png', name: 'in.png' },
    mask: { buffer: PNG, mediaType: 'image/png', name: 'mask.png' },
  });
  const form = buildEditFormData(payload);
  assert.ok(form instanceof FormData, '改图必须走 multipart');
  assert.equal(form.get('prompt'), '改成夜景');
  assert.equal(form.get('model'), 'm');
  const image = form.get('image');
  assert.ok(image instanceof Blob, '原图必须是二进制字段');
  assert.equal(image.type, 'image/png');
  assert.equal(image.size, PNG.byteLength);
  assert.equal(form.get('mask').size, PNG.byteLength);

  // 不给 mask 时，表单里不该出现这个字段（空字段会让部分上游直接 400）
  const noMask = buildEditFormData(buildEditPayload({}, { prompt: 'x' }, { image: { buffer: JPEG, mediaType: 'image/jpeg' } }));
  assert.equal(noMask.get('mask'), null);
  assert.equal(noMask.get('image').name, 'image.jpg', '没给文件名时按媒体类型补一个');
});

await test('callImageEditApi：POST multipart，且**绝不**手写 content-type', async () => {
  let seen = null;
  const payload = buildEditPayload({}, { prompt: '改成夜景' }, { image: { buffer: PNG, mediaType: 'image/png', name: 'in.png' } });
  const body = await callImageEditApi({
    config: { apiUrl: 'https://x.example.com/v1', apiKey: 'k' },
    payload,
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 });
    },
  });
  assert.equal(seen.url, 'https://x.example.com/v1/images/edits');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.authorization, 'Bearer k');
  // 这条是真实的坑：自己写 content-type 而 boundary 由 fetch 生成，两者对不上，
  // 上游会以"解析不出表单"报错，现象与"参数没传"几乎一样，很难反推。
  assert.equal(seen.init.headers['content-type'], undefined, 'content-type 必须交给 fetch 自己带 boundary');
  assert.ok(seen.init.body instanceof FormData);
  assert.equal(body.data.length, 1);
});

await test('callImageEditApi：缺 Key / HTTP 错误 / 非法 JSON 都是可读错误', async () => {
  const payload = buildEditPayload({}, { prompt: 'x' }, { image: { buffer: PNG, mediaType: 'image/png' } });
  await assert.rejects(
    () => callImageEditApi({ config: { apiUrl: 'https://x/v1', apiKey: '' }, payload, fetchImpl: async () => { throw new Error('不该发出请求'); } }),
    /未配置生图 API Key/,
  );
  await assert.rejects(
    () => callImageEditApi({
      config: { apiUrl: 'https://x/v1', apiKey: 'k' }, payload,
      fetchImpl: async () => new Response('nope', { status: 502 }),
    }),
    /改图接口返回 HTTP 502/,
  );
  await assert.rejects(
    () => callImageEditApi({
      config: { apiUrl: 'https://x/v1', apiKey: 'k' }, payload,
      fetchImpl: async () => new Response('<html>', { status: 200 }),
    }),
    /不是合法 JSON/,
  );
});

await test('editImages：端到端产出附件，文件名带 edited- 前缀与正确扩展名', async () => {
  const saved = [];
  const result = await editImages({
    config: { apiUrl: 'https://x.example.com/v1', apiKey: 'k', editModel: 'edit-m' },
    args: { prompt: '把背景换成夜晚' },
    source: { image: { buffer: PNG, mediaType: 'image/png', name: 'in.png' } },
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://x.example.com/v1/images/edits');
      assert.equal(init.body.get('prompt'), '把背景换成夜晚');
      assert.equal(init.body.get('model'), 'edit-m');
      return new Response(JSON.stringify({ data: [{ b64_json: JPEG.toString('base64') }] }), { status: 200 });
    },
    saveImage: async (input) => {
      saved.push(input);
      return { attachmentId: `att-${saved.length}`, mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1, name: input.name };
    },
  });
  assert.equal(result.images.length, 1);
  assert.equal(saved[0].mediaType, 'image/jpeg', '媒体类型按真实字节嗅探');
  assert.match(saved[0].name, /^edited-\d+-1\.jpg$/, '改图产物与生图产物在附件库里要能一眼区分');
  assert.equal(result.payload.fields.prompt, '把背景换成夜晚');
});

// ── 上游模型列表（设置页的「识别上游模型」） ─────────────────────────────────

await test('modelsEndpoint：基址 / 生图端点 / 模型端点三种写法都归一到 /models', () => {
  assert.equal(modelsEndpoint('https://x.example.com/v1'), 'https://x.example.com/v1/models');
  // 用户可能把地址填到具体端点上：不能拼出 /images/generations/models
  assert.equal(modelsEndpoint('https://x.example.com/v1/images/generations'), 'https://x.example.com/v1/models');
  assert.equal(modelsEndpoint('https://x.example.com/v1/models'), 'https://x.example.com/v1/models');
  assert.equal(modelsEndpoint('https://x.example.com/v1/'), 'https://x.example.com/v1/models');
  // 本机假服务同样允许（与 apiUrl 的"允许本机"策略一致）
  assert.equal(modelsEndpoint('http://127.0.0.1:18577/v1'), 'http://127.0.0.1:18577/v1/models');
});

await test('parseModelList：兼容四种回包形态，去重并排序', () => {
  assert.deepEqual(parseModelList({ data: [{ id: 'b' }, { id: 'a' }] }), ['a', 'b']);
  assert.deepEqual(parseModelList({ data: ['b', 'a'] }), ['a', 'b']);
  assert.deepEqual(parseModelList({ models: [{ name: 'z' }, { model: 'y' }] }), ['y', 'z']);
  assert.deepEqual(parseModelList(['only']), ['only']);
  // 去重：上游经常把同一个模型列两次
  assert.deepEqual(parseModelList({ data: [{ id: 'a' }, { id: 'a' }] }), ['a']);
  // 认不出来的形状回落空列表，而不是抛错（由 listModels 统一给出可读原因）
  assert.deepEqual(parseModelList(null), []);
  assert.deepEqual(parseModelList({ object: 'list' }), []);
  assert.deepEqual(parseModelList({ data: [{}] }), []);
});

await test('listModels：GET /models，带鉴权头，返回排序后的 id', async () => {
  const result = await listModels({
    config: { apiUrl: 'https://x.example.com/v1', apiKey: 'secret-key' },
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://x.example.com/v1/models');
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.authorization, 'Bearer secret-key');
      return new Response(JSON.stringify({ data: [{ id: 'z-image' }, { id: 'a-image' }] }), { status: 200 });
    },
  });
  assert.deepEqual(result.models, ['a-image', 'z-image']);
  assert.equal(result.endpoint, 'https://x.example.com/v1/models');
});

await test('listModels：缺 Key 时一个字节都不发', async () => {
  let called = false;
  await assert.rejects(
    () => listModels({
      config: { apiUrl: 'https://x.example.com/v1', apiKey: '' },
      fetchImpl: async () => { called = true; },
    }),
    /未配置生图 API Key/,
  );
  assert.equal(called, false);
});

await test('listModels：上游报错 / 空列表 / 非法 JSON 都给出可读原因', async () => {
  const base = { apiUrl: 'https://x.example.com/v1', apiKey: 'k' };
  await assert.rejects(
    () => listModels({ config: base, fetchImpl: async () => new Response('unauthorized', { status: 401 }) }),
    /HTTP 401/,
  );
  // 空列表要明确提到"可能没有这个端点"，否则用户会以为是 Key 填错了
  await assert.rejects(
    () => listModels({ config: base, fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }) }),
    /不提供 \/models 端点/,
  );
  await assert.rejects(
    () => listModels({ config: base, fetchImpl: async () => new Response('<html>gateway</html>', { status: 200 }) }),
    /不是合法 JSON/,
  );
});

await test('listModels：连不上与正文挂起超时都转成可读错误', async () => {
  await assert.rejects(
    () => listModels({
      config: { apiUrl: 'https://x.example.com/v1', apiKey: 'k' },
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    }),
    /连不上模型列表接口/,
  );
  await assert.rejects(
    () => listModels({
      config: { apiUrl: 'https://x.example.com/v1', apiKey: 'k' },
      timeoutMs: 20,
      fetchImpl: async (_url, init) => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":['));
            init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
          },
        });
        return new Response(body, { status: 200 });
      },
    }),
    /被中止或超时/,
  );
});

console.log(failures ? `\n${failures} 个用例失败` : '\n全部通过');
if (failures) process.exit(1);
