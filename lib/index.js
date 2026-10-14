// dsh-image-tool —— DeepSeek Harness 生图工具插件（host 半）。
//
// 一句话：**把外部生图服务接成平台工具，图片以平台原生 `image` 块输出。**
//
// 三条设计边界，决定了这个文件为什么长这样：
//
// ① **生图 API 与对话模型 API 完全无关。**
//    本插件不注册 LLM provider、不碰模型选择。它只注册一个工具，工具内部打
//    `{apiUrl}/images/generations`。所以"用 DeepSeek 聊天 + 用另一个服务生图"
//    是天然成立的，两者各自配置、互不影响。
//
// ② **没有任何平台原生的"生图协议"可接，唯一的落点是工具。**
//    LLM 适配器的 `stream()` 只产出文本与工具调用；图片要进入对话，必须由工具
//    结果携带 `{ type: 'image', attachment }` 块。这就是"补全生图接口"的位置 ——
//    不是发明一个协议，而是把图片接进既有的内容块体系。
//
// ③ host 半注册工具与接口，client 半在「图像生成」设置页提供配置表单。
//    工具结果和图片渲染使用平台原生内容块。
//
// ⚠️ 关于 `.extra('volatile', true)` 而不是 `.volatile()`：后者只是 DSH 自带那份
//    schemastery 的语法糖，在别的解析结果里不存在（实测 `typeof s.volatile` 为
//    undefined）。`.extra()` 两边都有，行为一致。
import z from '@deepseek-ai/schemastery';
import {
  DEFAULT_MAX_IMAGE_BYTES,
  ImageToolError,
  generateImages,
  normalizeApiUrl,
} from './generate.js';
import { registerImageRoutes } from './routes.js';
import { createDiag } from './diag.js';
import { findSessionImage, relativeImagePath, saveImageAs } from './save.js';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'dsh-image-tool';

// tools / attachments 是硬依赖：缺了它们这个插件没有任何意义。
// settings 也是硬依赖：配置全部经由它读写（没有它就等于没配置）。
export const inject = ['tools', 'attachments', 'settings', 'sessions'];

/** settings 命名空间名 —— 必须与 cordis.patch.yml 里那条 entry 的 id 一致。 */
export const SETTINGS_NAMESPACE = 'image-tool';

/** 工具名。外部调用接口与它共用同一份实现，只是入口不同。 */
export const TOOL_NAME = 'generate_image';

/**
 * 作为 loader entry 的 `Config` 暴露出去的配置。
 *
 * 每个字段都带 `volatile`：这既是"可热改、不重挂载"的标记，也是命名空间能被
 * **写入**的必要条件（只保留带该标记的字段，否则抛 "has no volatile fields"）。
 *
 * 字段刻意都允许空值：空 = 未配置，由工具在调用时给出明确错误，而不是让插件
 * 因为一次没填完就在装载期失败。
 */
export const Config = z.object({
  /** 生图服务基址，如 https://api.openai.com/v1。**允许本机**（本地生图服务是正当用法）。 */
  apiUrl: z.string().default('').description('生图接口基址，例如 https://api.openai.com/v1（允许 http://127.0.0.1:xxxx 这类本地服务）').extra('volatile', true),
  /**
   * 生图服务密钥。标 secret：平台在读设置时会把它结构化剥掉，不会回传浏览器。
   * 注意这是**生图服务**的 Key，与对话模型的凭据完全无关 —— 这正是本插件的要点。
   */
  apiKey: z.string().role('secret').default('').description('生图服务的 API Key（与对话模型无关；平台不会把它回传前端）').extra('volatile', true),
  /** 生图模型名。留空则不发送 model 字段，由上游默认。 */
  model: z.string().default('').description('生图模型名，留空则由上游默认').extra('volatile', true),
  /** 默认尺寸，如 1024x1024。留空则不发送 size。 */
  size: z.string().default('').description('默认尺寸，如 1024x1024；留空由上游默认').extra('volatile', true),
  /** 默认张数。 */
  count: z.number().default(1).description('默认生成张数（1~8）').extra('volatile', true),
  /** 调用前是否弹窗确认。默认开 —— 生图会真实计费。 */
  confirmBeforeGenerate: z.boolean().default(true).description('调用前弹窗确认（生图会真实计费，建议保持开启）').extra('volatile', true),
  /** 整次调用超时。生图是同步接口，实测几十秒很正常。 */
  timeoutMs: z.number().default(180000).description('单次生图调用上限（毫秒）。生图同步接口常需数十秒，不要设太小').extra('volatile', true),
  /** 单张图片字节上限。 */
  maxImageBytes: z.number().default(DEFAULT_MAX_IMAGE_BYTES).description('单张图片字节上限').extra('volatile', true),
  // ── 以下为可选透传项：只在填了值的时候才发给上游 ──────────────────────────
  quality: z.string().default('').description('可选：画质（如 hd / standard）').extra('volatile', true),
  style: z.string().default('').description('可选：风格（如 vivid / natural）').extra('volatile', true),
  background: z.string().default('').description('可选：背景（如 transparent / opaque）').extra('volatile', true),
  outputFormat: z.string().default('').description('可选：输出格式（如 png / webp）').extra('volatile', true),
  /** 自动保存目录。留空 = 当前会话工作目录下的 generated-images/。 */
  savePath: z.string().default('').description('自动保存目录；留空则使用当前会话工作目录下的 generated-images/').extra('volatile', true),
});

const diag = createDiag('dsh-image-tool');

/**
 * 读取本插件命名空间当前生效的配置。
 *
 * 通过 `settings.describe()` 而不是 `apply(ctx, config)` 的第二参数：后者是装载
 * 那一刻的静态值，而 settings 的 `applies` 是 `live` —— 用户改完设置，下一次工具
 * 调用就该用新值，不需要重启 DSH。这一步也**不能**给 `redactSecrets: true`，
 * 那样读回来的 apiKey 会是脱敏占位而不是真值。
 */
export function makeConfigReader(ctx, fallback) {
  return function readConfig() {
    try {
      const descriptors = ctx.settings?.describe?.() ?? [];
      const found = descriptors.find((d) => d?.ns === SETTINGS_NAMESPACE);
      if (found?.value && typeof found.value === 'object') {
        return { ...(fallback ?? {}), ...found.value };
      }
    } catch (error) {
      diag(`读取 settings 失败，回退装载期配置：${error?.message ?? error}`);
    }
    return { ...(fallback ?? {}) };
  };
}

/** 校验配置是否具备调用条件，缺什么就说什么。 */
export function assertConfigured(config) {
  normalizeApiUrl(config?.apiUrl); // 抛 CONFIG_MISSING_API_URL / CONFIG_BAD_API_URL
  if (String(config?.apiKey ?? '').trim() === '') {
    throw new ImageToolError(
      `未配置生图 API Key。请通过 DSH settings API 写入命名空间「${SETTINGS_NAMESPACE}」的 apiKey 字段`
      + '（例如 dsh plugin 的设置页，或 POST /api/settings/update）。',
      { code: 'CONFIG_MISSING_API_KEY' },
    );
  }
}

/**
 * 调用前确认。
 *
 * 用 `userQuestions`（也就是 ask_user_question 背后的机制）而不是把确认做进
 * 工具参数：参数是**模型**填的，模型可以自己填"已确认"——那不叫确认。
 * 只有真正问到人，这个闸门才有意义。
 */
export async function requestConfirmation(ctx, { prompt, count, size, agent, signal }) {
  let userQuestions;
  try { userQuestions = ctx.get?.('userQuestions') ?? ctx.userQuestions; } catch {}
  if (!userQuestions?.ask) {
    return { allowed: false, reason: '当前 composition 没有可用的用户问答通道（userQuestions），无法完成生图前确认。可在设置里关闭 confirmBeforeGenerate，或改用无确认的调用方式。' };
  }
  const answer = await userQuestions.ask({
    questions: [{
      id: 'confirm-generate',
      header: '生图确认',
      question: [
        `是否调用生图服务？`,
        ``,
        `提示词：${prompt}`,
        count > 1 ? `张数：${count}` : null,
        size ? `尺寸：${size}` : null,
        ``,
        `（生图会真实计费）`,
      ].filter((line) => line !== null).join('\n'),
      options: [
        { label: '生成', description: '立即调用生图接口' },
        { label: '取消', description: '不调用，本次不生图' },
      ],
    }],
    agent,
    signal,
  });
  const selected = answer?.answers?.[0]?.selected ?? [];
  const custom = String(answer?.answers?.[0]?.custom ?? '').trim();
  if (selected.includes('生成')) return { allowed: true };
  return { allowed: false, reason: custom !== '' ? `用户取消了生图（${custom}）` : '用户取消了生图' };
}

/** 落盘子目录名（相对会话工作目录）。 */
export const OUTPUT_DIR_NAME = 'generated-images';

/**
 * 组装落盘钩子：把图片写到会话工作目录下的 `generated-images/`。
 *
 * 为什么落在 cwd 而不是某个固定路径：图片天然属于生成它的那个上下文。放在会话
 * 自己的工作目录里，你用文件管理器、编辑器或 DSH 的文件能力都能直接找到，
 * 也不必为"图该放哪"再引入一个配置项。
 *
 * 拿不到 cwd 时**不落盘** —— 宁可只存附件库，也不要往进程当前目录乱写。
 */
export function makeDiskSaver({ cwd, savePath = '', fsModule = fs, pathModule = path }) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  const configured = typeof savePath === 'string' ? savePath.trim() : '';
  const dir = configured === ''
    ? pathModule.join(cwd, OUTPUT_DIR_NAME)
    : pathModule.isAbsolute(configured) ? configured : pathModule.resolve(cwd, configured);
  return async function saveToDisk({ data, name }) {
    await fsModule.promises.mkdir(dir, { recursive: true });
    const file = pathModule.join(dir, name);
    await fsModule.promises.writeFile(file, data);
    return file;
  };
}

/** ToolRunContext 只保证 agent.id；工作目录取自 live Session 的不可变 header。 */
export function cwdFromExecution(exec, sessions) {
  const id = exec?.agent?.id;
  if (!id) return null;
  const cwd = sessions?.get(id)?.header?.cwd;
  return typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : null;
}

/**
 * 执行一次生图。工具入口与外部 HTTP 接口共用这一份。
 *
 * @param includeData 外部接口用：为 true 时**额外**在 `data` 里返回 base64 字节，
 *        好让调用方（例如把图发到别处的桥接层）不必再走一次附件通道。
 *        默认 false —— 工具路径绝不能带上字节，那个返回值会进会话日志。
 * @returns {{ok: true, note: string, images: Array<{ref: object, mediaType: string, bytes: number, diskPath: string|null}>, data?: Array<{mediaType: string, dataBase64: string}>}}
 *          或 `{ok: false, note: string}`（失败一律以**正常返回**表达，让模型能读到原因
 *          并自行决定下一步，而不是把整个 turn 变成异常）
 */
export async function runGenerate(ctx, { config, args, agent, signal, includeData = false, cwd }) {
  const fetchImage = makeImageFetcher({ signal, maxImageBytes: Number(config?.maxImageBytes) > 0 ? Number(config.maxImageBytes) : DEFAULT_MAX_IMAGE_BYTES });
  const saveToDisk = makeDiskSaver({ cwd, savePath: config?.savePath });
  try {
    assertConfigured(config);
    const { images } = await generateImages({
      config,
      args,
      signal,
      fetchImage,
      saveImage: (input) => ctx.attachments.saveImage(input),
      saveToDisk,
      timeoutMs: Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : undefined,
      maxImageBytes: Number(config.maxImageBytes) > 0 ? Number(config.maxImageBytes) : undefined,
    });
    const landed = images.filter((i) => i.diskPath).length;
    const note = `已生成 ${images.length} 张图片（模型 ${config.model || '上游默认'}）。\n`
      + images.map((image, index) => image.diskPath
        ? `第 ${index + 1} 张已生成至 ${relativeImagePath(cwd, image.diskPath)}\n已保存到：${image.diskPath}`
        : `第 ${index + 1} 张已存入附件库，未保存到工作目录：${image.diskError || '未取得会话工作目录'}。可使用 save_generated_image 另存。`).join('\n')
      + '\n请在最终回复中展示保存路径的可点击链接；未落盘时请明确说明。';
    diag(`生成成功：${images.length} 张，共 ${images.reduce((sum, i) => sum + i.bytes, 0)} 字节`
      + (saveToDisk ? `，落盘 ${landed} 张` : '（未取得会话工作目录，跳过落盘）'));
    for (const image of images) {
      if (image.diskError) diag(`落盘失败（不影响生图）：${image.diskError}`);
    }
    // 只带附件引用与落盘路径：这个值会被序列化进会话日志，一张 256x256 PNG 的
    // base64 就足以把日志撑到无法阅读。字节只在明确要求时（外部接口）单独给。
    const result = {
      ok: true,
      note,
      images: images.map(({ ref, mediaType, bytes, diskPath }) => ({ ref, mediaType, bytes, diskPath })),
    };
    if (includeData) {
      result.data = images.map(({ mediaType, buffer }) => ({ mediaType, dataBase64: buffer.toString('base64') }));
    }
    return result;
  } catch (error) {
    const message = error instanceof ImageToolError
      ? error.message
      : `生图失败：${error?.message ?? error}`;
    diag(`生成失败：${message}`);
    return { ok: false, note: message, images: [] };
  }
}

/**
 * 下载上游返回的图片链接。
 *
 * 地址已经过 generate.js 的 SSRF 关卡；这里再设一次超时与体积上限，
 * 因为"关卡放行"不等于"对端会好好回包"。
 */
export function makeImageFetcher({ signal, maxImageBytes = DEFAULT_MAX_IMAGE_BYTES } = {}) {
  return async function fetchImage(url) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('下载超时')), 15000);
    try {
      // 禁止自动重定向，避免经过校验的公网地址跳转到本机或私网。
      const response = await fetch(url, { signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new ImageToolError(`下载上游图片失败：HTTP ${response.status}`, { code: 'UPSTREAM_DOWNLOAD_FAILED' });
      const mediaType = String(response.headers.get('content-type') ?? '').split(';')[0].trim();
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxImageBytes) {
            await reader.cancel();
            throw new ImageToolError(`图片下载超过 ${maxImageBytes} 字节上限`, { code: 'UPSTREAM_IMAGE_TOO_LARGE' });
          }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      return { buffer: Buffer.concat(chunks), mediaType };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}

/**
 * 装配。
 *
 * `config` 是装载那一刻的 entry config；运行期一律以 `readConfig()` 现读为准
 * （见 makeConfigReader 的说明）。
 */
export function apply(ctx, config = {}) {
  const readConfig = makeConfigReader(ctx, config);
  let confirmationCtx = {};
  ctx.inject?.(['userQuestions'], (questionCtx) => {
    confirmationCtx = questionCtx;
    questionCtx.effect?.(() => () => { confirmationCtx = {}; });
  });

  // 能力探测：一次性把关键事实写进诊断日志。
  // 插件"启动失败"时 DSH 只给使用者一行状态，不告诉你原因；而 apply 里任何一处
  // 抛出都会让整行 entry 变成失败 —— 所以这里自己留证据，避免反复试错。
  //
  // ⚠️ 探测本身也必须容错：`ctx.get('webServer')` 在未 inject 时会**抛错**，
  //    而探测写在 step 之外，一抛就把整个插件赔进去了（这正是之前「启动失败」
  //    的直接原因之一）。这里只问"能不能拿到"，并吞掉异常改成报告。
  let webServerProbe = 'n/a';
  try {
    webServerProbe = typeof (ctx.get?.('webServer') ?? ctx.webServer)?.register;
  } catch (error) {
    webServerProbe = `throws(${error?.message ?? error})`;
  }
  diag([
    'apply 开始',
    `effect=${typeof ctx.effect}`,
    `inject=${typeof ctx.inject}`,
    `tools.register=${typeof ctx.tools?.register}`,
    `tools.get=${typeof ctx.tools?.get}`,
    `settings.update=${typeof ctx.settings?.update}`,
    `settings.mutate=${typeof ctx.settings?.mutate}`,
    `attachments.saveImage=${typeof ctx.attachments?.saveImage}`,
    `webServer.register=${webServerProbe}`,
  ].join(' | '));

  /**
   * 每一步独立容错。
   *
   * 这是刻意的：平台把「apply 抛错」直接呈现为整个插件的「启动失败」，
   * 而一条 entry 上其实挂着好几件互相独立的事（工具、路由）。让其中一件失败
   * 拖垮全部，既难排障也没有必要 —— 生图工具挂不上时，外部 HTTP 接口仍可能可用，
   * 反之亦然。失败一律写进诊断日志，而不是静默。
   */
  function step(label, run) {
    try {
      const result = run();
      return result;
    } catch (error) {
      diag(`步骤失败 [${label}]：${error?.stack ?? error}`);
      return undefined;
    }
  }

  // ── 1. 生图工具 ────────────────────────────────────────────────────────────
  // 两条防线，缺一不可：
  //   ① 注册前先 `tools.get()` 查重 —— 同一层里重名注册会**直接失败**；
  //   ② 把清理交给 `ctx.effect`（存在时）—— 平台每次 volatile 更新都会重新执行
  //      apply，没有清理的话第二次就会撞上 ①，而症状（插件卡「启动失败」）
  //      几乎无法从现象反推。
  step('注册生图工具', () => {
    if (typeof ctx.tools?.get === 'function' && ctx.tools.get(TOOL_NAME)) {
      diag(`工具 ${TOOL_NAME} 已注册，跳过本次注册`);
      return;
    }
    const dispose = ctx.tools.register({
    name: TOOL_NAME,
    description: [
      '用外部生图服务按提示词生成图片。',
      '当你需要交付一张图画、插画、示意图、头像、封面等视觉产物时使用它。',
      '生成的图片会作为图片出现在对话里。',
      '参数 prompt 必填；size/count 可选，省略时使用用户在设置里配置的默认值。',
      '成功后必须在回复中展示结果里的保存路径链接；未落盘时说明原因并可使用 save_generated_image 另存。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述（越具体越好：主体、风格、构图、色调）' },
        size: { type: 'string', description: '尺寸，如 1024x1024 / 1792x1024；省略用设置里的默认值' },
        count: { type: 'integer', minimum: 1, maximum: 8, description: '生成张数，省略用设置里的默认值（默认 1）' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: '本次是否成功产出图片' },
          note: { type: 'string', description: '给模型读的结果说明（成功数量，或失败原因）' },
          images: {
            type: 'array',
            description: '生成的图片（附件引用，供渲染图片块）',
            items: { type: 'object' },
          },
        },
        required: ['ok', 'note'],
      },
      // 只使用**平台自己的** image 块，不引入任何私有块类型：
      // 平台的消息适配器不会跳过未知块 —— 私有块会让整个回合以 UNSUPPORTED_CONTENT 失败。
      // 纯文本模型那边由平台把 image 块投影成占位文本，所以两类模型共用同一条链路。
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: String(value?.note ?? '') }];
        for (const item of Array.isArray(value?.images) ? value.images : []) {
          if (item && typeof item === 'object' && item.ref) blocks.push({ type: 'image', attachment: item.ref });
        }
        return blocks;
      },
    },
    presentResult: (_args, result) => ({ card: 'generic', title: '图片生成与保存结果', content: result.content }),
    async execute(args, exec) {
      const current = readConfig();
      const prompt = String(args?.prompt ?? '').trim();
      const count = Number(args?.count ?? current.count ?? 1);
      const size = String(args?.size ?? current.size ?? '').trim();

      // 先校验配置，再谈确认。
      // 顺序反了的后果不是"少一层检查"，而是**报错误导**：配置都没填就问用户
      // "要不要生成"，用户点完"生成"才被告知没配 API —— 或者更糟，在某些
      // composition 里先撞上"没有问答通道"，于是用户以为是确认机制坏了，
      // 真正的原因（没填 apiUrl/apiKey）被盖在下面看不见。
      try {
        assertConfigured(current);
      } catch (error) {
        return { ok: false, note: error?.message ?? String(error), images: [] };
      }

      if (current.confirmBeforeGenerate !== false) {
        const verdict = await requestConfirmation(confirmationCtx, {
          prompt,
          count,
          size,
          agent: exec?.agent,
          signal: exec?.signal,
        });
        if (!verdict.allowed) return { ok: false, note: verdict.reason, images: [] };
      }
      return runGenerate(ctx, {
        config: current,
        args: { ...args, count, size },
        agent: exec?.agent,
        signal: exec?.signal,
        // 会话工作目录：图片会额外落一份到 <cwd>/generated-images/，方便你直接查看。
        cwd: cwdFromExecution(exec, ctx.sessions),
      });
    },
    });
    // effect 存在时把清理交给平台（重新装配时自动撤掉旧注册）；
    // 不存在时注册也已经生效，至少工具可用。
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose);
    diag(`工具 ${TOOL_NAME} 注册成功`);
  });

  step('注册另存工具', () => {
    const dispose = ctx.tools.register({
      name: 'save_generated_image',
      description: '将当前会话中的图片另存到工作目录内指定路径，不重新生图、不收费。不传 attachmentId 时保存本会话最近一张图片。保存成功后展示返回的路径链接。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对会话工作目录的另存路径，例如 images/天空之城.png；不能覆盖已有文件；不改图片格式。' },
          attachmentId: { type: 'string', description: '可选：生成结果中的 attachmentId；省略时使用本会话最近一张图片。' },
        },
        required: ['path'], additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, note: { type: 'string' }, diskPath: { type: 'string' }, relativePath: { type: 'string' } }, required: ['ok', 'note'] },
        render: (_args, value) => [{ type: 'text', text: String(value.note) }],
      },
      presentResult: (_args, result) => ({ card: 'generic', title: '图片另存结果', content: result.content }),
      async execute(args, exec) {
        try {
          const session = ctx.sessions.get(exec?.agent?.id);
          const ref = findSessionImage(session, args?.attachmentId);
          const saved = await saveImageAs({
            cwd: cwdFromExecution(exec, ctx.sessions), ref, targetPath: args?.path,
            readImage: (ref, signal) => ctx.attachments.readImage(ref, signal), signal: exec?.signal,
          });
          return { ok: true, ...saved, note: `已另存至 ${saved.relativePath}\n完整路径：${saved.diskPath}\n请展示保存路径的可点击链接。` };
        } catch (error) { return { ok: false, note: `另存失败：${error.message}` }; }
      },
    });
    ctx.effect?.(() => dispose);
  });

  // ── 2. 外部调用接口 ────────────────────────────────────────────────────────
  // ⚠️ 必须用 `ctx.inject([...], cb)` 来可选地拿 `webServer`，**不能**直接写
  //    `ctx.get('webServer')` / `ctx.webServer` —— 那样在没声明 inject 时抛
  //    `cannot get property "webServer" without inject`，而这行代码在 apply 里，
  //    一抛整个插件的 entry 就变成「启动失败」（使用者只看到这一行状态，看不到原因）。
  //    `inject` 是硬依赖（缺失就不激活），`ctx.inject` 才是可选依赖 —— 只有
  //    Web profile 才有 webServer，终端 profile 里这步本该整体跳过。
  step('挂载外部接口', () => {
    if (typeof ctx.inject !== 'function') {
      diag('ctx.inject 不可用：外部调用接口未挂载（工具本身不受影响）');
      return;
    }
    ctx.inject(['connection', 'webServer'], (routeCtx) => {
      const webServer = routeCtx.get?.('webServer') ?? routeCtx.webServer;
      if (!webServer?.register) {
        diag('没有 webServer：外部调用接口未挂载（工具本身不受影响）');
        return;
      }
      // connection 用于鉴权：自定义 prefix 路由会**抢在** `/api` 的鉴权之前
      // （webServer 按最长前缀派发），所以拒绝判定必须自己做。
      const connection = routeCtx.get?.('connection') ?? routeCtx.connection;
      const disposeRoutes = registerImageRoutes(webServer, {
        readConfig,
        run: (opts) => runGenerate(ctx, opts),
        // 设置页（client 半）通过这两个回调读写配置。
        // ⚠️ 服务方法的签名是**位置参数** `update(ns, patch)`，与 RPC 端点的
        //    `{ ns, patch }` 信封不是一回事 —— 混了会静默写到别的地方去。
        updateConfig: (patch) => ctx.settings.update(SETTINGS_NAMESPACE, patch),
        // 清密钥只能走 mutate/unset：写空串在 secret 字段上等于"没改"。
        clearSecret: () => ctx.settings.mutate(SETTINGS_NAMESPACE, [{ op: 'unset', path: ['apiKey'] }]),
        connection,
        readAttachment: (ref) => ctx.attachments.readImage(ref),
        log: diag,
      });
      if (typeof routeCtx.effect === 'function') routeCtx.effect(() => disposeRoutes);
    });
  });
}
