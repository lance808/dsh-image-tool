// 本地假生图服务 —— **仅用于开发与验收**，不要在真实使用中指向它。
//
// 用途：让"生成 → 落地成附件 → 在对话里显示"这整条链路可以在**不花一分钱、
// 不连任何真实上游**的前提下被验证。真实的生图接口一次调用几十秒且计费，
// 拿它当回归用例既不经济也不稳定。
//
// 它实现的是最小可用的 OpenAI 兼容形状：
//   POST /v1/images/generations  → { data: [{ b64_json }] }
//   GET  /v1/models              → { data: [{ id }] }
// 并按请求里的 size 生成一张**尺寸正确**的纯色 PNG（真的编码，不是假字节），
// 这样附件服务的解码与尺寸校验都会真的走一遍。
//
// 用法：
//   node scripts/mock-image-api.mjs [port]        # 默认 18577
// 然后把插件的 apiUrl 设为 http://127.0.0.1:<port>/v1
import http from 'node:http';
import zlib from 'node:zlib';

const PORT = Number(process.argv[2] ?? process.env.MOCK_IMAGE_PORT ?? 18577);

/**
 * 生成一张 w×h 的纯色 PNG。
 *
 * 手写 PNG 是刻意的：不引入任何图像库依赖，且**保证字节是真实合法的 PNG**——
 * 用随机字节糊弄的话，附件服务的魔数嗅探与解码校验根本不会被触发，
 * 那这个 mock 就测不出东西了。
 */
function makePng(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      // 左到右做一点渐变，这样一眼能看出图确实被渲染了
      raw[offset] = Math.min(255, r + Math.floor((x / width) * 40));
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      offset += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function parseSize(raw) {
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(String(raw ?? '').trim());
  if (!match) return { width: 256, height: 256 };
  return { width: Math.min(2048, Number(match[1])), height: Math.min(2048, Number(match[2])) };
}

const PALETTE = [[64, 128, 255], [255, 128, 64], [96, 200, 128], [200, 96, 200]];

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
});
