// 改图的输入解析：**要编辑的那张图从哪来**。
//
// 这个模块只做一件事：把模型给的 `image` / `mask` 参数，翻译成
// `{ buffer, mediaType, name }`，并在此过程中把住三条边界：
//
// ① **只在会话与工作目录里找图。** 不认远程 URL —— 让上游去下载一个模型随口给出的
//    地址，等于把服务端请求交给模型指挥（SSRF）。要改远程图，先下载到工作目录。
// ② **工作目录内的路径才读。** 词法检查 + realpath 二次确认，防止 `..\..` 与
//    符号链接把读取范围伸到工作目录之外。
// ③ **不信任扩展名。** 媒体类型按魔数嗅探；声称 png 实为别的格式时以真实字节为准，
//    否则会把不支持的格式交给上游，报错信息还指向错误的方向。
//
// 连续改图（"把这张图改成…"）靠 `reference` 省略时的**最近一张图**实现：会话里
// 倒序找第一个 image 块。它同时覆盖两种情况 —— 模型上一轮生成落进会话的图，
// 以及用户自己上传的参考图。
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_MAX_IMAGE_BYTES, ImageToolError, sniffMediaType } from './generate.js';

/** 会话/工具结果里可能承载图片的块类型。平台用 'image'；后两个用于兼容旧会话。 */
const IMAGE_BLOCK_TYPES = new Set(['image', 'uploaded-image', 'generated-image']);

/**
 * 递归收集一个内容块数组里的图片附件引用。
 *
 * 为什么要递归：工具结果的图片并不都挂在 message.content 顶层 —— 会话日志里
 * 工具结果是一个 `tool-result` 块，它自己带着 `content`。只扫顶层会漏掉
 * "上一轮刚生成的图"，于是连续改图变成"找不到原图"。
 */
function collectFromContent(content, out) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) continue;
    if (IMAGE_BLOCK_TYPES.has(block.type)
      && typeof block.attachment === 'object' && block.attachment !== null) {
      out.push(block.attachment);
      continue;
    }
    // 工具结果 / 转发内容：继续往下找。
    if (Array.isArray(block.content)) collectFromContent(block.content, out);
  }
}

/**
 * 按时间倒序取出会话里出现过的所有图片引用。
 *
 * 顺序即"最近优先"：倒着遍历消息与块，所以 `[0]` 就是最近一张。
 */
export function sessionImages(session) {
  const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : [];
  const refs = [];
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m];
    if (typeof message !== 'object' || message === null) continue;
    const before = refs.length;
    collectFromContent(message.content, refs);
    // 部分形态把内容放在 message.message.content（工具结果的二次包装）。
    if (refs.length === before && message.message) collectFromContent(message.message.content, refs);
  }
  return refs;
}

/** 找某个 attachmentId 对应的完整引用 —— 附件读接口要的是完整引用，不是裸 id。 */
export function findSessionImageByRef(session, attachmentId) {
  const wanted = String(attachmentId ?? '').trim();
  if (wanted === '') return undefined;
  return sessionImages(session).find((ref) => String(ref?.attachmentId ?? '') === wanted);
}

/**
 * 该参数看起来像不像一个 attachmentId（而不是路径）。
 *
 * ⚠️ 这里最容易写错的是"短文件名"：`input.png` 只含字母数字与点、也没有路径分隔符，
 * 用一条宽松的正则就会把它当成附件 id 去查会话，然后报出"本会话里找不到附件 input.png"
 * —— 一个和真实原因（我本来想读这个文件）完全对不上的错误。所以：
 *   · 带图片扩展名的一律按路径处理；
 *   · 其余必须有足够长度（平台真实 id 是 `sha256:<64 hex>` 这种量级）。
 */
export function looksLikeAttachmentId(value) {
  const text = String(value ?? '').trim();
  if (text === '') return false;
  if (/^sha256:/i.test(text)) return true;
  // 路径一定带分隔符或盘符；其余无分隔符的标识符才有可能是 id。
  if (/[\\/]/.test(text)) return false;
  if (/\.(png|jpe?g|webp|gif|bmp|tiff?|avif|heic)$/i.test(text)) return false;
  return /^[A-Za-z0-9_.:-]{16,}$/.test(text);
}

/**
 * 把工作目录内的一个路径读成图片。
 *
 * 三道检查缺一不可：词法上必须在 cwd 内 → realpath 后仍必须在 cwd 内（挡符号链接）
 * → 必须是常规文件且不超过字节上限。
 */
export async function readWorkspaceImage({
  cwd,
  reference,
  fsModule = fs,
  pathModule = path,
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
} = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new ImageToolError('未取得会话工作目录，无法按路径读取原图', { code: 'NO_SESSION_CWD' });
  }
  const requested = String(reference ?? '').trim();
  if (requested === '') throw new ImageToolError('图片路径不能为空', { code: 'BAD_IMAGE_PATH' });

  const absolute = pathModule.isAbsolute(requested) ? requested : pathModule.resolve(cwd, requested);
  const prefix = cwd.endsWith(pathModule.sep) ? cwd : cwd + pathModule.sep;
  if (absolute !== cwd && !absolute.startsWith(prefix)) {
    throw new ImageToolError(`图片路径必须位于当前会话工作目录内：${requested}`, { code: 'IMAGE_PATH_OUTSIDE_CWD' });
  }

  // realpath 二次确认：词法检查挡不住"目录是指向盘外的符号链接/junction"。
  let realRoot;
  let realFile;
  try {
    realRoot = await fsModule.realpath(cwd);
    realFile = await fsModule.realpath(absolute);
  } catch (error) {
    throw new ImageToolError(`读取原图失败：${error?.message ?? error}`, { code: 'IMAGE_READ_FAILED' });
  }
  const realPrefix = realRoot.endsWith(pathModule.sep) ? realRoot : realRoot + pathModule.sep;
  if (realFile !== realRoot && !realFile.startsWith(realPrefix)) {
    throw new ImageToolError(`图片路径经符号链接指向工作目录之外，已拒绝：${requested}`, { code: 'IMAGE_PATH_OUTSIDE_CWD' });
  }

  const stat = await fsModule.stat(realFile);
  if (!stat.isFile()) throw new ImageToolError(`不是常规文件：${requested}`, { code: 'IMAGE_NOT_A_FILE' });
  if (stat.size > maxImageBytes) {
    throw new ImageToolError(`原图 ${stat.size} 字节，超过上限 ${maxImageBytes} 字节`, { code: 'IMAGE_TOO_LARGE' });
  }

  const buffer = Buffer.from(await fsModule.readFile(realFile));
  if (buffer.byteLength === 0) throw new ImageToolError(`原图是空文件：${requested}`, { code: 'EMPTY_IMAGE' });
  return {
    buffer,
    // 按魔数判定，不信任扩展名；扩展名只用来给上游一个像样的文件名。
    mediaType: sniffMediaType(buffer, guessMediaTypeFromName(requested)),
    name: pathModule.basename(requested),
  };
}

/** 扩展名只作为嗅探失败时的兜底提示，不作为判定依据。 */
function guessMediaTypeFromName(file) {
  const ext = path.extname(String(file ?? '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

/**
 * 解析改图的原图（`image` 参数）。
 *
 * 三种写法，按优先级判定，并把"最终用了哪张图"如实回报给调用方 —— 这条信息会进
 * 工具的 note，用户才能确认模型改的是不是他以为的那张图：
 *   ① 省略/空 → 本会话最近一张图（连续改图）
 *   ② 像 attachmentId → 在该会话里找完整引用后读字节
 *   ③ 其余 → 当成工作目录内的路径读取
 */
export async function resolveEditImage({
  reference,
  session,
  cwd,
  readImage,
  fsModule = fs,
  pathModule = path,
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
} = {}) {
  const raw = String(reference ?? '').trim();

  if (raw !== '' && looksLikeAttachmentId(raw)) {
    const ref = findSessionImageByRef(session, raw);
    if (!ref) {
      throw new ImageToolError(
        `在本会话里找不到附件 ${raw}。可省略 image 参数改用最近一张图，或传工作目录内的图片路径。`,
        { code: 'IMAGE_ATTACHMENT_NOT_IN_SESSION' },
      );
    }
    const stored = await readImage(ref);
    return { image: toSource(stored.data, ref, maxImageBytes), origin: `会话附件 ${ref.attachmentId}` };
  }

  if (raw === '') {
    const ref = sessionImages(session)[0];
    if (!ref) {
      throw new ImageToolError(
        '本会话里没有可用的图片。请先生成一张图（generate_image）、在对话里上传一张图，或把 image 参数设为工作目录内的图片路径。',
        { code: 'NO_IMAGE_IN_SESSION' },
      );
    }
    const stored = await readImage(ref);
    return { image: toSource(stored.data, ref, maxImageBytes), origin: `会话里最近一张图片 ${ref.attachmentId}` };
  }

  return {
    image: await readWorkspaceImage({ cwd, reference: raw, fsModule, pathModule, maxImageBytes }),
    origin: `工作目录文件 ${raw}`,
  };
}

function toSource(data, ref, maxImageBytes) {
  const buffer = Buffer.from(data ?? []);
  if (buffer.byteLength === 0) throw new ImageToolError('会话里的这张图片是空的', { code: 'EMPTY_IMAGE' });
  if (buffer.byteLength > maxImageBytes) {
    throw new ImageToolError(`这张图片 ${buffer.byteLength} 字节，超过上限 ${maxImageBytes} 字节`, { code: 'IMAGE_TOO_LARGE' });
  }
  return {
    buffer,
    mediaType: sniffMediaType(buffer, ref?.mediaType),
    name: ref?.name || `image.${ref?.mediaType === 'image/jpeg' ? 'jpg' : 'png'}`,
  };
}

/**
 * 解析 mask（可选）。做法与原图完全一致，但多一条现实约束的**提示**：
 * OpenAI 约定 mask 必须是 PNG、与原图同尺寸、透明处为编辑区。这里不硬拦
 * （不少中转站接受别的写法），只把不一致的信息交给调用方去提醒用户。
 */
export async function resolveEditMask({ reference, session, cwd, readImage, fsModule = fs, pathModule = path, maxImageBytes = DEFAULT_MAX_IMAGE_BYTES } = {}) {
  const raw = String(reference ?? '').trim();
  if (raw === '') return { mask: null, origin: null, warning: null };
  const resolved = await resolveEditImage({ reference: raw, session, cwd, readImage, fsModule, pathModule, maxImageBytes });
  const warning = resolved.image.mediaType === 'image/png'
    ? null
    : `mask 的媒体类型是 ${resolved.image.mediaType}；OpenAI 约定 mask 必须是 PNG（透明处为编辑区），部分服务商会拒绝。`;
  return { mask: resolved.image, origin: resolved.origin, warning };
}
