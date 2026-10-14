// mock-image-api 的自检：确认它返回的确实是**合法 PNG**，而不是看着像图的字节。
//
// 这一条很重要：如果 mock 返回的图不合法，附件服务的解码校验会失败，
// 于是"用了 mock 还是连真实上游"就会变成两套不同的行为，验收结论也就不可信了。
// 所以这里用插件自己的解析器（decodeImages）来验它。
import assert from 'node:assert/strict';
import { decodeImages, generateImages, sniffMediaType } from '../lib/generate.js';

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

console.log(failures ? `\n${failures} 个用例失败` : '\n全部通过');
if (failures) process.exit(1);
