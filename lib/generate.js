// 生图核心：协议构造、上游调用、响应解析、图片落地。
//
// 这个模块**不碰 ctx**（除了由调用方注入的 `saveImage` / `fetchImage` 能力），
// 所以它既能被工具调用（lib/index.js），也能被外部 HTTP 接口调用（lib/routes.js），
// 还能被离线的单元测试直接钉住 —— 一份实现，两个入口。
//
// 协议：OpenAI 兼容的 `POST {apiUrl}/images/generations`。
//   智谱 / 通义千问 / SiliconFlow / 各类中转站都提供这个形状；
//   只需两样东西：接口地址与 API Key。
//
// 两条**不同**的地址可信度，必须分开对待（这是本文件最容易写错的地方）：
//   1. `apiUrl` —— 用户自己填的。**允许本机/私网**：本地生图服务（SD WebUI、
//      ComfyUI、one-api 之类）是正当用法，把它拦掉等于把本地部署判死。
//   2. 响应里返回的图片 `url` —— **上游给的**。它可能被上游或中间的恶意网关
//      构造成 `http://169.254.169.254/...`（云元数据）或内网地址来钓我们的
//      服务端请求。所以这条必须过 SSRF 关卡：只允许 http/https，且拒绝环回、
//      私网、链路本地、唯一本地地址。
// 把这两条混成一条，不是把本地用户拦死，就是把内网暴露出去。

/** 上游返回值里允许的图片媒体类型（与平台 attachments 的约束对齐）。 */
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** 单张图片的字节上限（默认 20 MiB，可被调用方覆盖）。 */
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 回包正文字节上限：上游返回一堆垃圾时不至于把内存吃光。 */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export class ImageToolError extends Error {
  constructor(message, { code = 'IMAGE_TOOL_ERROR', status } = {}) {
    super(message);
    this.name = 'ImageToolError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** 去掉尾部斜杠，避免把 `${apiUrl}/images/generations` 拼成双斜杠。 */
export function normalizeApiUrl(raw) {
  const value = String(raw ?? '').trim();
  if (value === '') throw new ImageToolError('未配置生图接口地址（apiUrl）', { code: 'CONFIG_MISSING_API_URL' });
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ImageToolError(`生图接口地址不是合法 URL：${value}`, { code: 'CONFIG_BAD_API_URL' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImageToolError(`生图接口地址必须是 http/https：${value}`, { code: 'CONFIG_BAD_API_URL' });
  }
  return value.replace(/\/+$/, '');
}

/** 生图端点：OpenAI 兼容约定是 `{base}/images/generations`。 */
export function generationsEndpoint(apiUrl) {
  const base = normalizeApiUrl(apiUrl);
  // 已经写到端点上的地址原样尊重，避免拼出 /images/generations/images/generations。
  if (/\/images\/generations$/.test(base)) return base;
  return `${base}/images/generations`;
}

/**
 * 改图端点：OpenAI 兼容约定是 `{base}/images/edits`（multipart/form-data）。
 *
 * 与生图的区别不只是路径：`/images/edits` 收的是**表单**，原图作为二进制字段上传。
 * 为什么不用 `generations` + 参考图字段（如 `input_image`）：那类字段各家网关支持不一，
 * OpenAI 形态的中转会直接以 `Unknown parameter: 'input_image'` 拒绝；`/images/edits`
 * 反而是每个 OpenAI 兼容中继都实现的 portable 路径。
 */
export function editsEndpoint(apiUrl) {
  let base = normalizeApiUrl(apiUrl);
  // 地址可能被填成生图端点，先退回来再判，避免拼出 /images/generations/images/edits。
  base = base.replace(/\/images\/generations$/, '');
  if (/\/images\/edits$/.test(base)) return base;
  return `${base}/images/edits`;
}

/**
 * 模型列表端点：OpenAI 兼容约定是 `{base}/models`。
 *
 * 地址可能被填成三种形态，这里都要认：基址（`https://x/v1`）、已写到生图端点
 * （`https://x/v1/images/generations`）、已写到模型端点（`https://x/v1/models`）。
 * 不处理第一种之外的形态就会拼出 `/images/generations/models` 这种不存在的路径。
 */
export function modelsEndpoint(apiUrl) {
  let base = normalizeApiUrl(apiUrl);
  base = base.replace(/\/images\/(?:generations|edits)$/, '');
  return /\/models$/.test(base) ? base : `${base}/models`;
}

/**
 * 从各种现实回包里提取模型 id。
 *
 * 兼容 `{data:[{id}]}`、`{data:["x"]}`、`{models:[...]}`、裸数组，以及部分网关
 * 用 `name` / `model` 代替 `id` 的写法。去重后按字典序排序 —— 列表可能上百项，
 * 排序后设置页里的下拉才可用。
 */
export function parseModelList(body) {
  const rows = Array.isArray(body) ? body
    : Array.isArray(body?.data) ? body.data
      : Array.isArray(body?.models) ? body.models
        : [];
  const ids = [];
  for (const row of rows) {
    const id = typeof row === 'string' ? row.trim() : firstString(row?.id, row?.name, row?.model);
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids.sort((a, b) => a.localeCompare(b));
}

/**
 * 拉取上游可用模型列表。
 *
 * 这是**只读**列表接口，不产生生图费用；但它会用你的 Key 打上游，所以只在用户
 * 显式点「识别上游模型」时发起，绝不在装载或打开设置页时自动请求 —— 那等于
 * 替用户发了一次他没要求的网络请求。
 *
 * 超时明显短于生图：列表接口不该让人等几十秒，慢到 20 秒就该报错让用户手填。
 */
export async function listModels({ config, fetchImpl = globalThis.fetch, timeoutMs = 20000, signal }) {
  const endpoint = modelsEndpoint(config?.apiUrl);
  const apiKey = String(config?.apiKey ?? '').trim();
  if (apiKey === '') throw new ImageToolError('未配置生图 API Key（apiKey）', { code: 'CONFIG_MISSING_API_KEY' });

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : 20000;
  const timer = setTimeout(() => controller.abort(new Error(`模型列表请求超过 ${budget}ms`)), budget);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await readBounded(response, MAX_RESPONSE_BYTES);
    if (!response.ok) {
      throw new ImageToolError(`上游模型列表返回 HTTP ${response.status}：${text.slice(0, 300)}`, {
        code: 'UPSTREAM_HTTP_ERROR',
        status: response.status,
      });
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ImageToolError(`上游模型列表不是合法 JSON：${text.slice(0, 200)}`, { code: 'UPSTREAM_BAD_JSON' });
    }
    const models = parseModelList(body);
    if (models.length === 0) {
      // 明确说"可能是没有这个端点"，否则用户会以为是自己的 Key 填错了。
      throw new ImageToolError(
        '上游没有返回任何模型。有些服务不提供 /models 端点，请手动填写模型名。',
        { code: 'UPSTREAM_NO_MODEL' },
      );
    }
    return { endpoint, models };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ImageToolError(`模型列表请求被中止或超时（${budget}ms）：${error?.message ?? error}`, { code: 'UPSTREAM_ABORTED' });
    }
    if (error instanceof ImageToolError) throw error;
    throw new ImageToolError(`连不上模型列表接口：${error?.message ?? error}`, { code: 'UPSTREAM_UNREACHABLE' });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 上游返回的图片地址是否可以安全抓取。
 *
 * 只允许 http/https，并拒绝一切"指向我们自己网络"的目标 —— 这个地址是**上游给的**，
 * 不是用户填的，所以不能享受"允许本机"的待遇。
 */
export function assertFetchableImageUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? ''));
  } catch {
    throw new ImageToolError(`上游返回的图片地址不是合法 URL：${String(raw).slice(0, 200)}`, { code: 'UPSTREAM_BAD_IMAGE_URL' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImageToolError(`上游返回的图片地址协议不被允许（${url.protocol}）`, { code: 'UPSTREAM_IMAGE_URL_BLOCKED' });
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const blocked = isPrivateHost(host);
  if (blocked) {
    throw new ImageToolError(`上游返回的图片地址指向内网/本机，已拒绝抓取：${host}`, { code: 'UPSTREAM_IMAGE_URL_BLOCKED' });
  }
  return url.toString();
}

/** 环回 / 私网 / 链路本地 / 唯一本地地址判定（含常见 IPv6 形态）。 */
export function isPrivateHost(host) {
  if (host === '' ) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  // IPv6
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
    // IPv4-mapped：::ffff:127.0.0.1
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return isPrivateHost(mapped[1]);
    return false;
  }
  // IPv4
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p))) return false;
  const [a, b] = parts.map(Number);
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // 含 169.254.169.254 云元数据
  return false;
}

/** 把一次调用的参数规范成上游请求体（OpenAI 兼容）。 */
export function buildRequestPayload(config, args) {
  const prompt = String(args?.prompt ?? '').trim();
  if (prompt === '') throw new ImageToolError('prompt 不能为空', { code: 'BAD_PROMPT' });

  const model = String(args?.model ?? config?.model ?? '').trim();
  const size = String(args?.size ?? config?.size ?? '').trim();
  const count = clampCount(args?.count ?? config?.count ?? 1);

  const payload = { prompt, n: count };
  if (model !== '') payload.model = model;
  if (size !== '') payload.size = size;
  // 显式要 base64：url 形态要多一次下载与 SSRF 判定，能省则省。
  // 但仍有上游忽略这个字段（或只回 url），所以解析侧两条都支持。
  payload.response_format = 'b64_json';

  // 可选透传项：只带用户确实配了的值，未配置就不发（避免上游因未知字段 400）。
  Object.assign(payload, optionalFields(config));
  return payload;
}

export function clampCount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(8, Math.max(1, Math.trunc(n)));
}

/** 只带用户确实配了值的可选透传项；未配置就不发（避免上游因未知字段 400）。 */
function optionalFields(config) {
  const out = {};
  for (const key of ['quality', 'style', 'background', 'output_format', 'moderation', 'watermark']) {
    const value = key === 'output_format' ? (config?.outputFormat || config?.output_format) : config?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') out[key] = String(value).trim();
  }
  return out;
}

/**
 * 把一次**改图**的参数规范成 `/images/edits` 的表单字段。
 *
 * 与生图的两点差异，都会影响真实调用，不能照抄：
 *   ① `n` 在改图上的支持度比生图更差，但 OpenAI 兼容约定接受它；这里仍然发送，
 *      上游忽略时按上游行为（我们按回包条目数落地，不假设）。
 *   ② 原图与 mask 是**二进制字段**，不能进 JSON —— 所以返回的是字段表 + 两个附件，
 *      由 buildEditFormData 组装成 multipart。
 *
 * @param image 必须提供：`{ buffer, mediaType, name }`（由 lib/image-source.js 解析）。
 * @param mask  可选：局部重绘遮罩，OpenAI 约定为 PNG、与原图同尺寸、透明处即编辑区。
 */
export function buildEditPayload(config, args, { image, mask } = {}) {
  const prompt = String(args?.prompt ?? '').trim();
  if (prompt === '') throw new ImageToolError('prompt 不能为空', { code: 'BAD_PROMPT' });
  if (!image?.buffer || image.buffer.byteLength === 0) {
    throw new ImageToolError('改图缺少原图：请提供 image（本会话图片的 attachmentId，或工作目录内的图片路径）', { code: 'MISSING_EDIT_IMAGE' });
  }

  // 改图模型可以单独配（有些服务商生图/改图是两个模型名），没配就退回生图模型。
  // 尺寸同理：改图单独一项，两处都没配就**不发 size**，让上游按原图尺寸处理。
  const model = String(args?.model ?? config?.editModel ?? config?.model ?? '').trim();
  const size = String(args?.size ?? config?.editSize ?? config?.size ?? '').trim();
  const count = clampCount(args?.count ?? config?.count ?? 1);

  const fields = { prompt, n: String(count), response_format: 'b64_json', ...optionalFields(config) };
  if (model !== '') fields.model = model;
  if (size !== '') fields.size = size;
  return { kind: 'edit', fields, image, mask: mask ?? null };
}

/**
 * 组装改图的 multipart 表单。
 *
 * ⚠️ **不要**手工设置 `content-type: multipart/form-data`：boundary 由 fetch/undici
 * 生成，自己写一个头部而 boundary 对不上，上游会以"解析不出表单"报错，且现象与
 * "参数没传"极像，很难从错误信息反推。
 */
export function buildEditFormData(payload) {
  const form = new FormData();
  for (const [key, value] of Object.entries(payload.fields)) form.append(key, String(value));
  const imageName = payload.image.name || `image.${extensionFor(payload.image.mediaType)}`;
  form.append('image', new Blob([payload.image.buffer], { type: payload.image.mediaType }), imageName);
  if (payload.mask) {
    const maskName = payload.mask.name || `mask.${extensionFor(payload.mask.mediaType)}`;
    form.append('mask', new Blob([payload.mask.buffer], { type: payload.mask.mediaType }), maskName);
  }
  return form;
}

/**
 * 调用上游生图接口。
 *
 * 特意**不做自动重试**：生图是按张计费的同步接口，一次调用可能憋几十秒；
 * 盲目重试会在"其实已经出图、只是回包慢"的情况下重复计费。失败就把原因讲清楚，
 * 由用户决定要不要再来一次。
 */
export async function callImageApi({ config, payload, signal, fetchImpl = globalThis.fetch, timeoutMs }) {
  const endpoint = generationsEndpoint(config?.apiUrl);
  const apiKey = String(config?.apiKey ?? '').trim();
  if (apiKey === '') throw new ImageToolError('未配置生图 API Key（apiKey）', { code: 'CONFIG_MISSING_API_KEY' });

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : 180000;
  const timer = setTimeout(() => controller.abort(new Error(`生图请求超过 ${budget}ms`)), budget);

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await readBounded(response, MAX_RESPONSE_BYTES);
    if (!response.ok) {
      throw new ImageToolError(`生图接口返回 HTTP ${response.status}：${text.slice(0, 400)}`, {
        code: 'UPSTREAM_HTTP_ERROR',
        status: response.status,
      });
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ImageToolError(`生图接口返回的不是合法 JSON：${text.slice(0, 200)}`, { code: 'UPSTREAM_BAD_JSON' });
    }
    return body;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ImageToolError(`生图请求被中止或超时（${budget}ms）：${error?.message ?? error}`, { code: 'UPSTREAM_ABORTED' });
    }
    if (error instanceof ImageToolError) throw error;
    throw new ImageToolError(`生图接口连不上：${error?.message ?? error}`, { code: 'UPSTREAM_UNREACHABLE' });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 调用上游改图接口（multipart）。
 *
 * 与 callImageApi 的差异只有两处：端点不同、请求体是表单而不是 JSON。
 * 同样的取舍照旧：**不做自动重试** —— 改图也是按张计费的同步接口，盲目重发会在
 * "其实已经出图、只是回包慢"的情况下重复计费。
 */
export async function callImageEditApi({ config, payload, signal, fetchImpl = globalThis.fetch, timeoutMs }) {
  const endpoint = editsEndpoint(config?.apiUrl);
  const apiKey = String(config?.apiKey ?? '').trim();
  if (apiKey === '') throw new ImageToolError('未配置生图 API Key（apiKey）', { code: 'CONFIG_MISSING_API_KEY' });

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : 180000;
  const timer = setTimeout(() => controller.abort(new Error(`改图请求超过 ${budget}ms`)), budget);

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      // 只有 authorization：multipart 的 content-type 必须由 fetch 自己带 boundary。
      headers: { authorization: `Bearer ${apiKey}` },
      body: buildEditFormData(payload),
      signal: controller.signal,
    });

    const text = await readBounded(response, MAX_RESPONSE_BYTES);
    if (!response.ok) {
      throw new ImageToolError(`改图接口返回 HTTP ${response.status}：${text.slice(0, 400)}`, {
        code: 'UPSTREAM_HTTP_ERROR',
        status: response.status,
      });
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ImageToolError(`改图接口返回的不是合法 JSON：${text.slice(0, 200)}`, { code: 'UPSTREAM_BAD_JSON' });
    }
    return body;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ImageToolError(`改图请求被中止或超时（${budget}ms）：${error?.message ?? error}`, { code: 'UPSTREAM_ABORTED' });
    }
    if (error instanceof ImageToolError) throw error;
    throw new ImageToolError(`改图接口连不上：${error?.message ?? error}`, { code: 'UPSTREAM_UNREACHABLE' });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** 读正文但设上限，防止异常大包吃内存。 */async function readBounded(response, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new ImageToolError(`生图接口回包超过 ${maxBytes} 字节上限`, { code: 'UPSTREAM_TOO_LARGE' });
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new ImageToolError(`生图接口回包超过 ${maxBytes} 字节上限`, { code: 'UPSTREAM_TOO_LARGE' });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

const B64_MEDIA_HINTS = [
  { match: (b) => b[0] === 0x89 && b[1] === 0x50, mediaType: 'image/png' },
  { match: (b) => b[0] === 0xff && b[1] === 0xd8, mediaType: 'image/jpeg' },
  { match: (b) => b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a', mediaType: 'image/gif' },
  { match: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP', mediaType: 'image/webp' },
];

/** 用魔数判断真实媒体类型 —— 不信任上游声明的字段。 */
export function sniffMediaType(buffer, fallback = 'image/png') {
  for (const hint of B64_MEDIA_HINTS) {
    if (buffer.length >= 12 && hint.match(buffer)) return hint.mediaType;
  }
  return MEDIA_TYPES.has(fallback) ? fallback : 'image/png';
}

/**
 * 从上游回包里解出图片字节。
 *
 * 兼容三种现实形态：
 *   ① `{ data: [{ b64_json }] }`  —— 显式要了 base64 时的标准形状
 *   ② `{ data: [{ url }] }`      —— 上游忽略 response_format，只回链接
 *   ③ `{ data: [{ image_url: { url } }] }` —— 部分网关的嵌套形状
 * 任一项解析不出字节都算这次调用失败（宁可报错，也不要假装成功）。
 */
export async function decodeImages({ body, fetchImage, maxImageBytes = DEFAULT_MAX_IMAGE_BYTES }) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  if (rows.length === 0) {
    const hint = typeof body?.error?.message === 'string' ? `：${body.error.message}` : '';
    throw new ImageToolError(`生图接口没有返回任何图片${hint}`, { code: 'UPSTREAM_NO_IMAGE' });
  }
  const out = [];
  for (const [index, row] of rows.entries()) {
    const b64 = firstString(row?.b64_json, row?.image_base64, row?.base64);
    if (b64 !== null) {
      const buffer = Buffer.from(stripDataUrl(b64), 'base64');
      if (buffer.byteLength === 0) throw new ImageToolError(`第 ${index + 1} 张图片的 base64 内容为空`, { code: 'UPSTREAM_EMPTY_IMAGE' });
      assertSize(buffer, maxImageBytes, index);
      out.push({ buffer, mediaType: sniffMediaType(buffer), source: 'base64' });
      continue;
    }
    const url = firstString(row?.url, row?.image_url?.url, row?.image_url);
    if (url !== null) {
      const safe = assertFetchableImageUrl(url);
      if (typeof fetchImage !== 'function') {
        throw new ImageToolError('上游只返回了图片链接，但当前环境没有可用的下载能力', { code: 'NO_DOWNLOAD_CAPABILITY' });
      }
      const fetched = await fetchImage(safe);
      const buffer = Buffer.from(fetched.buffer);
      if (buffer.byteLength === 0) throw new ImageToolError(`第 ${index + 1} 张图片下载得到 0 字节`, { code: 'UPSTREAM_EMPTY_IMAGE' });
      assertSize(buffer, maxImageBytes, index);
      out.push({ buffer, mediaType: sniffMediaType(buffer, fetched.mediaType), source: 'url' });
      continue;
    }
    throw new ImageToolError(`第 ${index + 1} 张图片既没有 base64 也没有链接`, { code: 'UPSTREAM_BAD_IMAGE_ROW' });
  }
  return out;
}

function assertSize(buffer, maxImageBytes, index) {
  if (buffer.byteLength > maxImageBytes) {
    throw new ImageToolError(
      `第 ${index + 1} 张图片 ${buffer.byteLength} 字节，超过上限 ${maxImageBytes} 字节`,
      { code: 'UPSTREAM_IMAGE_TOO_LARGE' },
    );
  }
}

function stripDataUrl(value) {
  const text = String(value).trim();
  const match = /^data:[^;]+;base64,(.*)$/s.exec(text);
  return match ? match[1] : text;
}

function firstString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return null;
}

/**
 * 把解析出来的图片字节落成**附件引用**（可选再落一份到磁盘）。
 *
 * 生图与改图共用这一段：两条路的差别全在"怎么问上游"，落地语义必须一致，
 * 否则会出现"改图能出图但保存路径少了"这类只在一条路上复现的问题。
 */
async function settleImages({ decoded, prompt, prefix, saveImage, saveToDisk }) {
  const saved = [];
  for (const item of decoded) {
    // name 带时间戳：同一次会话里连续生成不会在附件库里重名到难以区分。
    const name = `${prefix}-${Date.now()}-${saved.length + 1}.${extensionFor(item.mediaType)}`;
    const ref = await saveImage({ data: item.buffer, mediaType: item.mediaType, name });

    // 落盘**尽力而为**：附件库才是权威副本，写文件失败不该让整次调用失败
    // （目录可能不存在、只读、或被别的进程占着）。失败原因照实带回给调用方。
    let diskPath = null;
    let diskError = null;
    if (typeof saveToDisk === 'function') {
      try {
        diskPath = await saveToDisk({ data: item.buffer, mediaType: item.mediaType, name, prompt });
      } catch (error) {
        diskError = error?.message ?? String(error);
      }
    }
    // buffer 保留在返回值里，供调用方按需取用（外部接口的 includeData）。
    // 注意：**工具路径不要把 buffer 放进 output value** —— 那个值会进会话日志。
    saved.push({ ref, mediaType: item.mediaType, bytes: item.buffer.byteLength, source: item.source, buffer: item.buffer, diskPath, diskError });
  }
  return saved;
}

/**
 * 一次完整的生图：调用 → 解析 → 落地成平台附件引用（可选再落一份到磁盘）。
 *
 * `saveImage` 是调用方注入的 `ctx.attachments.saveImage`；`saveToDisk` 是可选的
 * 落盘钩子。这里都不直接 import ctx，是为了让整条链路可被离线测试。
 */
export async function generateImages({
  config,
  args,
  signal,
  fetchImpl,
  fetchImage,
  saveImage,
  saveToDisk,
  timeoutMs,
  maxImageBytes,
}) {
  const payload = buildRequestPayload(config, args);
  const body = await callImageApi({ config, payload, signal, fetchImpl, timeoutMs });
  const decoded = await decodeImages({ body, fetchImage, maxImageBytes });
  const images = await settleImages({ decoded, prompt: payload.prompt, prefix: 'generated', saveImage, saveToDisk });
  return { payload, images };
}

/**
 * 一次完整的改图：multipart 上传原图（可选 mask）→ 解析 → 落地。
 *
 * `source` 由 lib/image-source.js 解析出来（会话里的图片 / 工作目录文件），
 * 这里只负责协议与落地，不碰会话，所以同样可离线测。
 */
export async function editImages({
  config,
  args,
  source,
  signal,
  fetchImpl,
  fetchImage,
  saveImage,
  saveToDisk,
  timeoutMs,
  maxImageBytes,
}) {
  const payload = buildEditPayload(config, args, source);
  const body = await callImageEditApi({ config, payload, signal, fetchImpl, timeoutMs });
  const decoded = await decodeImages({ body, fetchImage, maxImageBytes });
  const images = await settleImages({ decoded, prompt: payload.fields.prompt, prefix: 'edited', saveImage, saveToDisk });
  return { payload, images };
}

export function extensionFor(mediaType) {
  switch (mediaType) {
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    default: return 'png';
  }
}
