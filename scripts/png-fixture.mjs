// 测试与本地假服务共用的 PNG 固定装置。
//
// 为什么不直接读仓库里的某张图：`_preview/`（用户成品）在 `.gitignore` 里 ——
// 新克隆的仓库根本没有它，测试会在别人机器上直接挂。测试需要的是"**合法**的 PNG 字节"，
// 而不是"某一张具体的图"，所以这里现场编码一张。
//
// 手写 PNG 是刻意的：不引入任何图像库依赖，且保证字节是真实合法的 PNG ——
// 用随机字节糊弄的话，附件服务的魔数嗅探与解码校验根本不会被触发，验收结论也就不可信。
import zlib from 'node:zlib';

/** 生成一张 w×h 的纯色 PNG；左到右带一点渐变，方便一眼看出图确实被渲染了。 */
export function makePng(width, height, [r, g, b] = [64, 128, 255]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
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

/** 测试里当"一张真实图片"用的固定字节（64×64，够过附件服务的解码与尺寸校验）。 */
export const FIXTURE_PNG = makePng(64, 64);
