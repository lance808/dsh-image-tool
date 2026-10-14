// 外部调用接口：让"生图"这件事可以被工具之外的东西驱动。
//
// 为什么需要它：工具路径的前提是"有一个模型在对话里决定要画图"。但实际使用中
// 还有另一类调用者 —— 别的自动化、脚本、另一个桥接层，它们想要的只是
// "给我一张图"，不需要（也不该）绕过一次模型推理。这个模块就是那个入口。
//
// 与工具的关系：**两者共用 lib/index.js 的 runGenerate**，所以协议、校验、
// SSRF 关卡、附件落地完全一致，不存在"两条路行为不同"的问题。
//
// 关于鉴权：前缀路由先于 /api 分发，因此显式调用 connection.requestRejection。
// 未取得鉴权服务时禁用配置写入与生图。
//
// 关于确认弹窗：确认只加在**工具路径**上。理由是这个闸门要防的是"模型自作主张
// 花钱生图"；而 HTTP 调用是调用方主动发起的明确意图，再弹一次窗既问错了人，
// 也会让自动化无法工作。
import { ImageToolError, extensionFor } from './generate.js';

/** 路由前缀。用插件自己的名字，不与任何既有命名空间冲突。 */
export const ROUTE_PREFIX = '/api/image-tool';

/** 近期生成引用的索引上限。生图一次几 MB，记太多没有意义，还占内存。 */
const RECENT_REF_LIMIT = 200;

/**
 * attachmentId → ImageAttachmentRef 的**进程内**索引。
 *
 * 存在的理由：附件服务的读接口要的是完整引用（含 mediaType/尺寸），而 URL 里
 * 只带得下一个 id。所以本进程把刚生成过的引用记下来，供 `/image` 按 id 取字节。
 *
 * 明确的限制：**进程重启即失效**，也不跨进程。要长期拿字节，请在同一次调用里用
 * `includeData=1`，或自己保存响应里的 `ref`。
 */
export function createRecentRefs(limit = RECENT_REF_LIMIT) {
  const map = new Map();
  return {
    get: (id) => map.get(id),
    set: (id, ref) => {
      // Map 保持插入序：超限时删掉最旧的一条（FIFO），不做 LRU —— 这里没有
      // "近期访问过就值得留着"的语义，只有"刚生成的还有用"。
      if (map.has(id)) map.delete(id);
      map.set(id, ref);
      while (map.size > limit) map.delete(map.keys().next().value);
    },
    get size() { return map.size; },
  };
}

function rememberRef(recentRefs, id, ref) {
  try {
    recentRefs?.set?.(id, ref);
  } catch {
    // 记不住也不该影响生图本身：图片已经在附件库里了。
  }
}

export function registerImageRoutes(webServer, deps) {
  const disposers = [];
  // 近期引用索引在这一次挂载里创建，/generate 与 /image 共享同一份。
  const recentRefs = deps.recentRefs ?? createRecentRefs();
  disposers.push(webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: makeHandler({ ...deps, recentRefs }),
  }));
  deps.log?.(`外部调用接口已挂载：${ROUTE_PREFIX}/generate`);
  return () => { for (const dispose of disposers) { try { dispose(); } catch {} } };
}

function makeHandler({ readConfig, run, updateConfig, clearSecret, connection, readAttachment, listModels, recentRefs, log }) {
  return async function handle(req, res) {
    // ── 鉴权 ──────────────────────────────────────────────────────────────────
    // ⚠️ 挂在 webServer 上的自定义 prefix 路由会**抢在** `/api` 的会话鉴权之前
    //    （webServer 按最长前缀派发，本插件的前缀比 `/api` 更长），所以这里**不会**
    //    自动获得鉴权。不自己判一次的话，本机任何进程、乃至借助 DNS rebinding 的
    //    网页都能调 `/config` 改写 API Key、或调 `/generate` 烧掉生图额度。
    //    做法与 dsh-reasoning-effort 的 RPC 通道一致：问 connection 服务要判定。
    const hasAuth = typeof connection?.requestRejection === 'function';
    if (hasAuth) {
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }
    } else {
      // 没有 connection 服务时**不假装安全**：只留只读面，写操作一律拒绝。
      log?.('警告：未取得 connection 服务，外部接口降级为只读（写操作已禁用）');
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/';
    try {
      if (route === '/status') return await handleStatus(req, res, readConfig);
      if (route === '/config') return await handleConfig(req, res, { readConfig, updateConfig, clearSecret, canWrite: hasAuth });
      if (route === '/image') return await handleImage(req, res, { readAttachment, recentRefs });
      if (route === '/models') {
        if (!hasAuth) return sendJson(res, 403, { ok: false, error: '缺少鉴权服务，已禁用上游查询' });
        return await handleModels(req, res, { readConfig, listModels, log });
      }
      if (route === '/generate') {
        if (!hasAuth) return sendJson(res, 403, { ok: false, error: '缺少鉴权服务，已禁用生图' });
        return await handleGenerate(req, res, { readConfig, run, log, recentRefs }, url);
      }
      return sendJson(res, 404, { ok: false, error: `未知路由：${req.method} ${url.pathname}（可用：GET /status、GET|POST /config、GET /models、GET /image、POST /generate）` });
    } catch (error) {
      const status = Number(error?.status) || 500;
      log?.(`外部接口异常 ${req.method} ${url.pathname}: ${error?.message ?? error}`);
      return sendJson(res, status, { ok: false, error: error?.message ?? String(error) });
    }
  };
}

/**
 * 配置的读写入口（设置页用）。
 *
 * ⚠️ 这里是**唯一**把 apiKey 状态告诉浏览器的地方，也是最容易写错的地方：
 * host 侧调 `ctx.settings.describe()`（不传 redactSecrets）拿到的是**明文** apiKey，
 * 剥离只发生在 RPC 那条路上。所以 GET 必须**自己**把 apiKey 从响应里删掉，
 * 只回 `hasKey` 与末四位指纹 —— 否则设置页里一个 fetch 就能把密钥读出去。
 */
async function handleConfig(req, res, { readConfig, updateConfig, clearSecret, canWrite = true }) {
  if (req.method === 'GET') {
    const config = readConfig() ?? {};
    const key = String(config.apiKey ?? '');
    const safe = { ...config };
    delete safe.apiKey;
    return sendJson(res, 200, {
      ok: true,
      config: safe,
      hasKey: key !== '',
      keyHint: key === '' ? null : `…${key.slice(-4)}`,
      writable: canWrite === true,
    });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 GET / POST' });
  // 没有鉴权就不接受写入 —— 宁可设置页报错，也不要留一个本机任意进程都能改密钥的入口。
  if (canWrite !== true) {
    return sendJson(res, 403, { ok: false, error: '本接口当前不可写：未取得鉴权服务（connection），已降级为只读' });
  }
  if (typeof updateConfig !== 'function') {
    return sendJson(res, 501, { ok: false, error: '当前 composition 不支持通过本接口写配置' });
  }

  const body = await readJsonBody(req);
  const patch = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    if (WRITABLE_FIELDS.has(key)) patch[key] = value;
  }
  // 清除密钥必须走 unset：secret 字段把空串当作"本次没有改动"，
  // 写 `apiKey: ''` 是清不掉的（平台为避免空表单误删密钥而定的语义）。
  if (body?.clearApiKey === true && typeof clearSecret === 'function') {
    await clearSecret();
    delete patch.apiKey;
  }
  if (Object.keys(patch).length > 0) await updateConfig(patch);
  return sendJson(res, 200, { ok: true, updated: Object.keys(patch) });
}

/** 允许从浏览器写入的字段白名单。不在名单里的一律丢弃，避免误写无关配置。 */
const WRITABLE_FIELDS = new Set([
  'apiUrl', 'apiKey', 'model', 'size', 'count',
  'confirmBeforeGenerate', 'timeoutMs', 'maxImageBytes',
  'quality', 'style', 'background', 'outputFormat', 'savePath',
]);

/**
 * 配置状态。**刻意不回显 apiKey 本身**，只回 hasKey 与末四位指纹 —— 这类接口
 * 一旦回显真值，任何能读到响应的地方（日志、截图、面板）就都拿到了密钥。
 */
async function handleStatus(req, res, readConfig) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' });
  const config = readConfig();
  const key = String(config?.apiKey ?? '');
  return sendJson(res, 200, {
    ok: true,
    configured: key !== '' && String(config?.apiUrl ?? '') !== '',
    apiUrl: String(config?.apiUrl ?? ''),
    model: String(config?.model ?? ''),
    size: String(config?.size ?? ''),
    count: Number(config?.count ?? 1),
    hasKey: key !== '',
    keyHint: key === '' ? null : `…${key.slice(-4)}`,
    confirmBeforeGenerate: config?.confirmBeforeGenerate !== false,
  });
}

/**
 * 识别上游可用模型（设置页的「识别上游模型」按钮）。
 *
 * 这是只读列表接口，但会**用你的 Key 打上游**，所以与 `/generate` 一样要求鉴权：
 * 否则本机任意进程都能靠这个端点探测"这台机器配的是哪个上游"。
 *
 * 失败一律把原因原样回给设置页 —— 用户需要区分"是 Key 填错了"还是
 * "这个上游根本没有 /models 端点，得手填模型名"。
 */
async function handleModels(req, res, { readConfig, listModels, log }) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' });
  if (typeof listModels !== 'function') {
    return sendJson(res, 501, { ok: false, error: '当前 composition 不支持查询上游模型列表' });
  }
  try {
    const { endpoint, models } = await listModels({ config: readConfig() });
    log?.(`识别上游模型：${models.length} 个（${endpoint}）`);
    return sendJson(res, 200, { ok: true, models, endpoint, count: models.length });
  } catch (error) {
    log?.(`识别上游模型失败：${error?.message ?? error}`);
    return sendJson(res, 400, { ok: false, error: error?.message ?? String(error) });
  }
}

async function handleGenerate(req, res, { readConfig, run, log, recentRefs }, url) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' });
  const body = await readJsonBody(req);
  const config = readConfig();
  const includeData = url.searchParams.get('includeData') === '1' || body.includeData === true;

  // 外部路径不弹确认（见文件头说明），但把"这次没确认"明确记一笔，便于事后追溯。
  log?.(`外部接口生图：prompt=${JSON.stringify(String(body?.prompt ?? '').slice(0, 80))} count=${body?.count ?? config.count ?? 1}`);

  const result = await run({
    config,
    args: { prompt: body?.prompt, size: body?.size, count: body?.count },
    signal: undefined,
    includeData,
  });

  if (!result.ok) return sendJson(res, 400, { ok: false, error: result.note });

  const images = [];
  for (const [index, item] of result.images.entries()) {
    const row = {
      attachmentId: item.ref?.attachmentId ?? null,
      mediaType: item.mediaType,
      bytes: item.bytes,
      width: item.ref?.width ?? null,
      height: item.ref?.height ?? null,
      name: item.ref?.name ?? null,
      extension: extensionFor(item.mediaType),
      /** 完整的附件引用。外部调用方若要自己长期保存这张图，应当留着它。 */
      ref: item.ref ?? null,
      /** 取字节的地址：不想在响应里扛 base64（大图有数 MB）时用它。 */
      fetchUrl: `${ROUTE_PREFIX}/image?id=${encodeURIComponent(String(item.ref?.attachmentId ?? ''))}`,
      downloadUrl: `${ROUTE_PREFIX}/image?id=${encodeURIComponent(String(item.ref?.attachmentId ?? ''))}&download=1`,
    };
    // base64 只在显式要求时给：默认响应保持轻量，避免把大图硬塞进每一次调用。
    if (includeData && Array.isArray(result.data) && result.data[index]) {
      row.dataBase64 = result.data[index].dataBase64;
    }
    // 记下完整引用，供 /image 端点按 id 取字节（见 handleImage 的说明）。
    if (row.attachmentId && item.ref) rememberRef(recentRefs, row.attachmentId, item.ref);
    images.push(row);
  }
  return sendJson(res, 200, { ok: true, note: result.note, images });
}

async function handleImage(req, res, { readAttachment, recentRefs }) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' });
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const id = String(url.searchParams.get('id') ?? '').trim();
  if (id === '') return sendJson(res, 400, { ok: false, error: '缺少 id 参数' });

  // attachmentId → 完整 ImageAttachmentRef。附件服务的读接口要的是**完整引用**，
  // 而 URL 里只带得下一个 id —— 所以本进程自己记一份近期生成过的引用。
  const ref = recentRefs?.get(id);
  if (!ref) {
    return sendJson(res, 404, {
      ok: false,
      error: '这个 attachmentId 不在本进程近期生成的列表里。'
        + '附件引用是进程内索引，插件重启后失效；'
        + '需要字节时请用 POST /generate?includeData=1（同一次调用里直接拿 base64），'
        + '或自己保存响应里的 ref。',
    });
  }
  if (typeof readAttachment !== 'function') {
    return sendJson(res, 501, { ok: false, error: '当前 composition 不支持按引用读回附件字节' });
  }
  const stored = await readAttachment(ref);
  const buffer = Buffer.from(stored?.data ?? []);
  if (buffer.byteLength === 0) return sendJson(res, 500, { ok: false, error: '附件读取返回了 0 字节' });
  res.writeHead(200, {
    'content-type': ref.mediaType ?? 'application/octet-stream',
    'content-length': String(buffer.byteLength),
    ...(url.searchParams.get('download') === '1' ? {
      'content-disposition': `attachment; filename="image.${extensionFor(ref.mediaType)}"; filename*=UTF-8''${encodeURIComponent(ref.name || `image.${extensionFor(ref.mediaType)}`)}`,
    } : {}),
    'cache-control': 'no-store',
  });
  res.end(buffer);
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readJsonBody(req, limitBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new ImageToolError('请求体过大', { code: 'BAD_REQUEST_BODY', status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ImageToolError('请求体必须是 JSON 对象', { code: 'BAD_REQUEST_BODY', status: 400 });
    }
    return parsed;
  } catch (error) {
    if (error instanceof ImageToolError) throw error;
    throw new ImageToolError(`请求体不是合法 JSON：${error?.message ?? error}`, { code: 'BAD_REQUEST_BODY', status: 400 });
  }
}
