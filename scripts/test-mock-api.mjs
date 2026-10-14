// mock-image-api 的自检：确认它返回的确实是**合法 PNG**，而不是看着像图的字节。
//
// 这一条很重要：如果 mock 返回的图不合法，附件服务的解码校验会失败，
// 于是"用了 mock 还是连真实上游"就会变成两套不同的行为，验收结论也就不可信了。
// 所以这里用插件自己的解析器（decodeImages）来验它。
import assert from 'node:assert/strict';
import { decodeImages, editImages, generateImages, listModels, sniffMediaType } from '../lib/generate.js';

const PORT = Number(process.env.MOCK_IMAGE_PORT ?? 18577);
const BASE = `http://127.0.0.1:${PORT}/v1`;

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.message}`); }
}

async function ensureUp() {
  try {
    const res = await fetch(`${BASE}/models`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    console.error(`\n❌ 假生图服务不可达：${BASE}\n   先起它：node scripts/mock-image-api.mjs ${PORT}\n   原因：${error.message}`);
    process.exit(2);
  }
}

await ensureUp();

await test('mock 返回的图片能被插件的解析器解出合法 PNG', async () => {
  const res = await fetch(`${BASE}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '一张测试图', size: '128x96', n: 2 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const images = await decodeImages({ body });
  assert.equal(images.length, 2);
  for (const image of images) {
    assert.equal(sniffMediaType(image.buffer), 'image/png', 'mock 必须返回真实 PNG');
  }
});

await test('mock 尊重 size 参数（尺寸真的变了）', async () => {
  const res = await fetch(`${BASE}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '尺寸检查', size: '320x160' }),
  });
  const body = await res.json();
  const [image] = await decodeImages({ body });
  // PNG 的 IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型之后
  const width = image.buffer.readUInt32BE(16);
  const height = image.buffer.readUInt32BE(20);
  assert.equal(width, 320);
  assert.equal(height, 160);
});

await test('mock 的错误口子可用来验证失败路径', async () => {
  const res = await fetch(`${BASE}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '__fail__ 鉴权失败' }),
  });
  assert.equal(res.status, 401);

  const empty = await fetch(`${BASE}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '__nolink__ 空结果' }),
  });
  const body = await empty.json();
  await assert.rejects(() => decodeImages({ body }), /没有返回任何图片/);
});

await test('走完整链路：generateImages 对 mock 端到端可用', async () => {
  const saved = [];
  const result = await generateImages({
    config: { apiUrl: BASE, apiKey: 'mock-key', model: 'mock-image-1' },
    args: { prompt: '端到端', size: '64x64', count: 1 },
    saveImage: async (input) => {
      saved.push(input);
      return { attachmentId: 'mock-att', mediaType: input.mediaType, bytes: input.data.byteLength, width: 64, height: 64, name: input.name };
    },
  });
  assert.equal(result.images.length, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].mediaType, 'image/png');
});

await test('listModels：能从假服务识别出模型列表（走真实 HTTP）', async () => {
  const result = await listModels({ config: { apiUrl: BASE, apiKey: 'mock-key' } });
  assert.deepEqual(result.models, ['mock-image-1', 'mock-image-2']);
  assert.equal(result.endpoint, `${BASE}/models`);
});

// ── 改图端点（multipart） ────────────────────────────────────────────────────
//
// 这一段的价值不在于"mock 能跑"，而在于它用**插件自己的 multipart 构造器**去打一个
// 真的会解析表单的服务端：boundary、字段名、二进制字段三者只要有一处不对，
// 真实上游就会以语焉不详的 400 收场，而这里能立刻定位。

const SOURCE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAWklEQVR42u3QMQEAAAgDoC1p0A0z'
  + '0INIkSJFihQpUqRIkSJFihQpUqRIkSJFihQpUqRIkSJFihQpUqRIkSJFihQpUqRIkSJFihQpUqRI'
  + 'kSJFihQpUqRIkSL1tMIFfQEBAQEG0lQAAAAASUVORK5CYII=',
  'base64',
);

await test('mock /images/edits 会真的解析 multipart，并返回改图色板的 PNG', async () => {
  const result = await editImages({
    config: { apiUrl: BASE, apiKey: 'mock-key', editModel: 'mock-edit-1' },
    args: { prompt: '把背景换成夜晚', size: '96x64', count: 1 },
    source: { image: { buffer: SOURCE_PNG, mediaType: 'image/png', name: 'source.png' } },
    saveImage: async (input) => ({ attachmentId: 'mock-edit-att', mediaType: input.mediaType, bytes: input.data.byteLength, width: 96, height: 64, name: input.name }),
  });
  assert.equal(result.images.length, 1, '改图链路要能拿到图');
  assert.equal(result.images[0].mediaType, 'image/png', 'mock 必须返回真实 PNG');
  const buffer = result.images[0].buffer;
  assert.equal(buffer.readUInt32BE(16), 96, 'size 必须真的透传到上游');
  assert.equal(buffer.readUInt32BE(20), 64);

  // 改图走另一套色板：同尺寸下字节必须与生图不同，否则"改图生效了"这件事根本没被验证。
  // ⚠️ 只比前 32 字节是**没用的**：那一段是签名 + IHDR（宽高/位深/色彩类型），
  //    同尺寸的两张 PNG 本来就一模一样，像素数据在后面的 IDAT 里。
  const generated = await generateImages({
    config: { apiUrl: BASE, apiKey: 'mock-key' },
    args: { prompt: '同样尺寸的生图', size: '96x64', count: 1 },
    saveImage: async (input) => ({ attachmentId: 'g', mediaType: input.mediaType, bytes: input.data.byteLength, width: 96, height: 64, name: input.name }),
  });
  assert.notEqual(
    buffer.toString('hex'),
    generated.images[0].buffer.toString('hex'),
    '改图与生图返回同一份字节，说明 mock 的改图分支根本没生效',
  );
});

await test('mock /images/edits 缺原图时明确报错（挡住"忘了上传"这类 bug）', async () => {
  const form = new FormData();
  form.append('prompt', '只给提示词');
  const res = await fetch(`${BASE}/images/edits`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /image is required/);
});

await test('mock /images/edits 的错误口子与生图一致', async () => {
  const form = new FormData();
  form.append('prompt', '__fail__ 鉴权失败');
  form.append('image', new Blob([SOURCE_PNG], { type: 'image/png' }), 'source.png');
  const res = await fetch(`${BASE}/images/edits`, { method: 'POST', body: form });
  assert.equal(res.status, 401);
});

console.log(failures ? `\n${failures} 个用例失败` : '\n全部通过');
if (failures) process.exit(1);
