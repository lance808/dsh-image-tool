// 本地假生图服务 —— **仅用于开发与验收**，不要在真实使用中指向它。
//
// 用途：让"生成 → 落地成附件 → 在对话里显示"这整条链路可以在**不花一分钱、
// 不连任何真实上游**的前提下被验证。真实的生图接口一次调用几十秒且计费，
// 拿它当回归用例既不经济也不稳定。
//
// 它实现的是最小可用的 OpenAI 兼容形状：
//   POST /v1/images/generations  → { data: [{ b64_json }] }（JSON）
//   POST /v1/images/edits        → { data: [{ b64_json }] }（multipart/form-data）
//   GET  /v1/models              → { data: [{ id }] }
// 并按请求里的 size 生成一张**尺寸正确**的纯色 PNG（真的编码，不是假字节），
// 这样附件服务的解码与尺寸校验都会真的走一遍。改图用另一套调色板，
// 于是"这次返回的确实是改图结果，而不是又生了一张"在界面上一眼可辨。
//
// 用法：
//   node scripts/mock-image-api.mjs [port]        # 默认 18577
// 然后把插件的 apiUrl 设为 http://127.0.0.1:<port>/v1
import http from 'node:http';
import { makePng } from './png-fixture.mjs';

const PORT = Number(process.argv[2] ?? process.env.MOCK_IMAGE_PORT ?? 18577);

function parseSize(raw) {
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(String(raw ?? '').trim());
  if (!match) return { width: 256, height: 256 };
  return { width: Math.min(2048, Number(match[1])), height: Math.min(2048, Number(match[2])) };
}

const PALETTE = [[64, 128, 255], [255, 128, 64], [96, 200, 128], [200, 96, 200]];
/** 改图用另一套色板：一眼能看出返回的是"被改过的图"，而不是又生成了一张。 */
const EDIT_PALETTE = [[255, 96, 96], [255, 208, 64], [96, 224, 255], [180, 140, 255]];

/**
 * 最小 multipart 解析。
 *
 * 只取文本字段与文件字段的**元信息**（字段名、文件名、字节数）——mock 不需要真读图，
 * 但它必须**真的要求 image 字段存在**：否则"忘了上传原图"这类 bug 在本地验收里
 * 会被放过，而真实上游只会回一句语焉不详的 400。
 */
async function readMultipart(req) {
  const type = String(req.headers['content-type'] ?? '');
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type);
  if (!match) return { fields: {}, files: {} };
  const boundary = Buffer.from(`--${(match[1] ?? match[2]).trim()}`, 'ascii');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  const fields = {};
  const files = {};
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    const next = buffer.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    const part = buffer.subarray(start + boundary.length + 2, Math.max(start + boundary.length + 2, next - 2));
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd > 0) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const content = part.subarray(headerEnd + 4);
      const name = /name="([^"]*)"/.exec(headers)?.[1];
      const filename = /filename="([^"]*)"/.exec(headers)?.[1];
      if (name !== undefined) {
        if (filename !== undefined) files[name] = { filename, bytes: content.length };
        else fields[name] = content.toString('utf8');
      }
    }
    start = next;
  }
  return { fields, files };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const send = (status, payload) => {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(text);
  };

  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    return send(200, { data: [{ id: 'mock-image-1' }, { id: 'mock-image-2' }] });
  }

  if (req.method === 'POST' && url.pathname.endsWith('/images/edits')) {
    const { fields, files } = await readMultipart(req);
    if (!fields.prompt) return send(400, { error: { message: 'prompt is required' } });
    if (!files.image) return send(400, { error: { message: 'image is required (multipart field "image")' } });
    if (String(fields.prompt).includes('__fail__')) return send(401, { error: { message: 'mock: unauthorized' } });
    if (String(fields.prompt).includes('__nolink__')) return send(200, { data: [] });

    const { width, height } = parseSize(fields.size);
    const count = Math.min(4, Math.max(1, Number(fields.n) || 1));
    const data = [];
    for (let i = 0; i < count; i += 1) {
      data.push({ b64_json: makePng(width, height, EDIT_PALETTE[i % EDIT_PALETTE.length]).toString('base64') });
    }
    console.log(`[mock] 改图 ${count} 张 ${width}x${height}，原图 ${files.image.filename}（${files.image.bytes} 字节）`
      + `${files.mask ? `，mask ${files.mask.bytes} 字节` : '，无 mask'}`
      + `，model=${fields.model ?? '(未指定)'}，prompt=${JSON.stringify(String(fields.prompt).slice(0, 40))}`);
    return send(200, { created: Math.floor(Date.now() / 1000), data });
  }

  if (req.method === 'POST' && url.pathname.endsWith('/images/generations')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}

    if (!body.prompt) return send(400, { error: { message: 'prompt is required' } });
    // 模拟一个"鉴权失败"的口子，方便验证错误路径确实能被讲清楚
    if (String(body.prompt).includes('__fail__')) return send(401, { error: { message: 'mock: unauthorized' } });
    if (String(body.prompt).includes('__nolink__')) return send(200, { data: [] });

    const { width, height } = parseSize(body.size);
    const count = Math.min(4, Math.max(1, Number(body.n) || 1));
    const data = [];
    for (let i = 0; i < count; i += 1) {
      const png = makePng(width, height, PALETTE[i % PALETTE.length]);
      data.push({ b64_json: png.toString('base64') });
    }
    console.log(`[mock] 生成 ${count} 张 ${width}x${height}，prompt=${JSON.stringify(String(body.prompt).slice(0, 40))}`);
    return send(200, { created: Math.floor(Date.now() / 1000), data });
  }

  return send(404, { error: { message: `mock service: no route for ${req.method} ${url.pathname}` } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] 假生图服务已启动：http://127.0.0.1:${PORT}/v1`);
  console.log(`[mock] 把插件 apiUrl 设为 http://127.0.0.1:${PORT}/v1 即可（apiKey 随便填非空值）`);
  console.log('[mock] 提示词里含 __fail__ 会返回 401，含 __nolink__ 会返回空 data —— 用于验证错误路径。');
  console.log(`[mock] 改图端点：POST http://127.0.0.1:${PORT}/v1/images/edits（multipart，字段 model/prompt/size/n/image[/mask]）`);
});
