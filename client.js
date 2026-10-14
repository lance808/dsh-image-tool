/**
 * dsh-image-tool —— 浏览器半（设置页）。
 *
 * 贡献一个设置分区（`settings.section`，id `image-tool`，标题「图像生成」），
 * 里面是所有生图相关的配置：接口地址、密钥、模型、尺寸、张数、确认开关等。
 *
 * 三个刻意的选择：
 *
 * 1. **手写 ModuleLoader bundle，没有构建步骤。** 外壳自己提供 `react`，
 *    这个文件只 `require('react')`。所以本插件不需要打包器、不需要 TypeScript、
 *    不需要在 profile 里装任何前端依赖 —— 改完直接生效。
 *
 * 2. **数据走插件自己的同源 HTTP 路由**（`/api/image-tool/config`），而不是
 *    typed Remote 绑定。那条路由由 host 半用 `ctx.webServer.register` 挂上，
 *    与其它 `/api/*` 共用同一个会话鉴权层。这样前端不依赖任何会随内核版本变化的
 *    RPC 契约，也不需要把 settings 的读写权限暴露给客户端。
 *
 * 3. **绝不在前端持有或回显密钥。** 服务端只会回 `hasKey` 和末四位指纹；
 *    输入框留空即"不改动已存的密钥"，清除必须显式点按钮（走 mutate/unset，
 *    因为给 secret 字段写空串在平台语义里等于"本次没有改动"）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-image-tool',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React

    /** 只声明真正用到的 client 服务，与 host 半的 inject 是两回事。 */
    const inject = ['slots']

    const API = '/api/image-tool'

    // ── 主题 ──────────────────────────────────────────────────────────────────
    // 全部取自外壳的主题变量，不写死任何一个颜色值，这样深浅色切换后依然可读。
    const T = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      surface2: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    }

    // ── 小组件 ────────────────────────────────────────────────────────────────

    /** 一行：左标签 + 右控件。label 宽度固定，多行输入也不会跳动。 */
    function Row({ label, hint, children }) {
      return h('div', { style: { display: 'flex', gap: 12, alignItems: 'flex-start', padding: '8px 0' } },
        h('div', { style: { flex: '0 0 168px', paddingTop: 6, color: T.text, fontSize: 13 } },
          label,
          hint ? h('div', { style: { color: T.muted, fontSize: 11, marginTop: 2, lineHeight: 1.5 } }, hint) : null,
        ),
        h('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', gap: 8, alignItems: 'center' } }, children),
      )
    }

    function Input({ value, onChange, type = 'text', placeholder, width = '100%' }) {
      return h('input', {
        type,
        value: value ?? '',
        placeholder,
        onChange: event => onChange(event.target.value),
        style: {
          width,
          boxSizing: 'border-box',
          padding: '6px 10px',
          fontSize: 13,
          color: T.text,
          background: T.surface2,
          border: `1px solid ${T.border}`,
          borderRadius: 6,
          outline: 'none',
          fontFamily: 'inherit',
        },
      })
    }

    /**
     * 下拉框。`options` 支持两种形状：
     *   { value, label }                       —— 普通项
     *   { group, options: [{ value, label }] } —— 分组项，渲染成 <optgroup>
     *
     * 尺寸预设必须分组：1K/2K/4K 加起来三十多项，扁平列表找起来很痛苦，
     * 而分组标题能让扫读快得多。
     */
    function Select({ value, onChange, options, width = '100%' }) {
      const items = options.map((option, index) => (Array.isArray(option.options)
        ? h('optgroup', { key: `group-${index}`, label: option.group },
            option.options.map(item => h('option', { key: item.value, value: item.value }, item.label)))
        : h('option', { key: option.value === '' ? `__blank-${index}` : option.value, value: option.value }, option.label)))
      return h('select', {
        value: value ?? '',
        onChange: event => onChange(event.target.value),
        style: {
          width,
          boxSizing: 'border-box',
          padding: '6px 10px',
          fontSize: 13,
          color: T.text,
          background: T.surface2,
          border: `1px solid ${T.border}`,
          borderRadius: 6,
          outline: 'none',
          fontFamily: 'inherit',
        },
      }, items)
    }

    function Button({ children, onClick, disabled, tone = 'default' }) {
      const color = tone === 'primary' ? T.brand : tone === 'danger' ? T.error : T.text
      return h('button', {
        type: 'button',
        onClick,
        disabled,
        style: {
          padding: '6px 14px',
          fontSize: 13,
          fontFamily: 'inherit',
          color: disabled ? T.muted : color,
          background: 'transparent',
          border: `1px solid ${disabled ? T.border : color}`,
          borderRadius: 6,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          whiteSpace: 'nowrap',
        },
      }, children)
    }

    function Card({ title, subtitle, children, tone }) {
      return h('section', {
        style: {
          border: `1px solid ${tone === 'warn' ? T.warn : T.border}`,
          borderRadius: 10,
          padding: '14px 16px',
          marginBottom: 14,
          background: T.surface,
        },
      },
        title ? h('div', { style: { color: T.text, fontSize: 14, fontWeight: 600, marginBottom: subtitle ? 2 : 10 } }, title) : null,
        subtitle ? h('div', { style: { color: T.muted, fontSize: 12, marginBottom: 10, lineHeight: 1.6 } }, subtitle) : null,
        children,
      )
    }

    // ── 设置页 ────────────────────────────────────────────────────────────────

    /**
     * 尺寸预设，按分辨率档位分组。
     *
     * 标签只写"比例 · 像素"（不再重复档位），因为分组标题已经写明档位。
     * 比例覆盖：1:1 / 4:3 / 3:2 / 16:10 / 16:9 / 21:9 电影，以及各自的竖屏方向
     * （3:4 / 2:3 / 10:16 / 9:16 / 9:21），另附 OpenAI 官方支持的几个固定尺寸。
     *
     * ⚠️ 这只是**省手打**的便利列表，不是能力边界：不同上游接受的尺寸集合差别很大
     * （OpenAI 只认几个固定值，自建 / 中转站往往任意尺寸）。需要特殊尺寸时，在对话里
     * 直接让模型传 `size` 参数即可（例如 3200x1440），那条路不受这个下拉限制。
     */
    const SIZE_GROUPS = [
      {
        group: '1K（约 100 万像素）',
        sizes: [
          ['1024x1024', '1:1 · 1024×1024'],
          ['1024x768', '4:3 · 1024×768'],
          ['1152x768', '3:2 · 1152×768'],
          ['1280x800', '16:10 · 1280×800'],
          ['1280x720', '16:9 · 1280×720'],
          ['1344x576', '21:9 电影 · 1344×576'],
          ['768x1024', '3:4 竖屏 · 768×1024'],
          ['768x1152', '2:3 竖屏 · 768×1152'],
          ['800x1280', '10:16 竖屏 · 800×1280'],
          ['720x1280', '9:16 竖屏 · 720×1280'],
          ['576x1344', '9:21 竖屏电影 · 576×1344'],
        ],
      },
      {
        group: '2K（约 200–400 万像素）',
        sizes: [
          ['2048x2048', '1:1 · 2048×2048'],
          ['2048x1536', '4:3 · 2048×1536'],
          ['2160x1440', '3:2 · 2160×1440'],
          ['1920x1200', '16:10 · 1920×1200'],
          ['1920x1080', '16:9 · 1920×1080'],
          ['2560x1080', '21:9 电影 · 2560×1080'],
          ['1536x2048', '3:4 竖屏 · 1536×2048'],
          ['1440x2160', '2:3 竖屏 · 1440×2160'],
          ['1200x1920', '10:16 竖屏 · 1200×1920'],
          ['1080x1920', '9:16 竖屏 · 1080×1920'],
          ['1080x2560', '9:21 竖屏电影 · 1080×2560'],
        ],
      },
      {
        group: '4K（约 500 万像素以上，上游可能拒绝）',
        sizes: [
          ['4096x4096', '1:1 · 4096×4096'],
          ['3840x2160', '16:9 · 3840×2160'],
          ['3840x2400', '16:10 · 3840×2400'],
          ['3440x1440', '21:9 电影 · 3440×1440'],
          ['3200x1440', '20:9 超宽 · 3200×1440'],
          ['2160x3840', '9:16 竖屏 · 2160×3840'],
        ],
      },
      {
        group: 'OpenAI 官方固定尺寸',
        sizes: [
          ['1536x1024', '横 · 1536×1024'],
          ['1024x1536', '竖 · 1024×1536'],
          ['1792x1024', '宽 · 1792×1024'],
          ['1024x1792', '高 · 1024×1792'],
          ['512x512', '小图 · 512×512'],
        ],
      },
    ]

    const SIZE_PRESETS = [
      { value: '', label: '（使用上游默认）' },
      ...SIZE_GROUPS.map(g => ({ group: g.group, options: g.sizes.map(([value, label]) => ({ value, label })) })),
    ]

    /** 预设里出现过的全部尺寸值，用来判断"当前值是否需要额外补一项"。 */
    const PRESET_SIZE_VALUES = new Set(SIZE_GROUPS.flatMap(g => g.sizes.map(([value]) => value)))

    /**
     * 组装尺寸下拉的选项。
     *
     * 当前值是**手填的特殊尺寸**时（例如之前用 CLI 写进去的 3200x1440），必须把它
     * 补成一项显示出来 —— 否则下拉会因为没有匹配项而显示空白，用户既看不到自己
     * 设了什么，也容易误以为配置丢了。
     */
    function sizeOptionsFor(current) {
      const size = String(current ?? '')
      if (size === '' || PRESET_SIZE_VALUES.has(size)) return SIZE_PRESETS
      return [
        { value: '', label: '（使用上游默认）' },
        { value: size, label: `${size}（当前值，不在预设内）` },
        ...SIZE_GROUPS.map(g => ({ group: g.group, options: g.sizes.map(([value, label]) => ({ value, label })) })),
      ]
    }

    function SettingsPage() {
      const [config, setConfig] = useState(null)
      const [hasKey, setHasKey] = useState(false)
      const [keyHint, setKeyHint] = useState(null)
      const [apiKeyInput, setApiKeyInput] = useState('')
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)
      const [models, setModels] = useState([])
      const [detecting, setDetecting] = useState(false)

      const note = useCallback((text, tone = 'muted') => {
        setMessage(text ? { text, color: tone === 'error' ? T.error : tone === 'success' ? T.success : T.muted } : null)
      }, [])

      const load = useCallback(async () => {
        try {
          const response = await fetch(`${API}/config`, { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          setConfig(payload.config ?? {})
          setHasKey(payload.hasKey === true)
          setKeyHint(payload.keyHint ?? null)
          setApiKeyInput('')
        } catch (error) {
          note(`读取配置失败：${error?.message ?? error}（插件 host 半可能未启动）`, 'error')
          setConfig({})
        }
      }, [note])

      useEffect(() => { load() }, [load])

      const set = useCallback((key, value) => {
        setConfig(current => ({ ...(current ?? {}), [key]: value }))
      }, [])

      const save = useCallback(async (extra = {}) => {
        setBusy(true)
        note('保存中…')
        try {
          const body = { ...(config ?? {}), ...extra }
          delete body.apiKey
          // 输入框留空 → 不动已存的密钥；填了才提交。
          if (apiKeyInput.trim() !== '') body.apiKey = apiKeyInput.trim()
          const response = await fetch(`${API}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload.ok !== true) {
            throw new Error(payload.error ?? `HTTP ${response.status}`)
          }
          await load()
          // apiUrl / 密钥可能刚刚改过，旧的模型列表就不再可信 —— 清掉，让用户重新识别。
          setModels([])
          note('已保存，下一次调用即生效。', 'success')
        } catch (error) {
          note(`保存失败：${error?.message ?? error}`, 'error')
        } finally {
          setBusy(false)
        }
      }, [apiKeyInput, config, load, note])

      const clearKey = useCallback(async () => {
        setBusy(true)
        note('清除中…')
        try {
          const response = await fetch(`${API}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clearApiKey: true }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? `HTTP ${response.status}`)
          await load()
          note('密钥已清除。', 'success')
        } catch (error) {
          note(`清除失败：${error?.message ?? error}`, 'error')
        } finally {
          setBusy(false)
        }
      }, [load, note])

      /**
       * 识别上游模型。
       *
       * 只在点了按钮时才打上游 —— 打开设置页**不**自动请求：那等于每次进设置都替你
       * 发一次网络请求，而且会在你还没填完 Key 的时候就报错。
       */
      const detectModels = useCallback(async () => {
        setDetecting(true)
        note('正在向上游查询模型列表…')
        try {
          const response = await fetch(`${API}/models`, { headers: { accept: 'application/json' } })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? `HTTP ${response.status}`)
          const list = Array.isArray(payload.models) ? payload.models : []
          setModels(list)
          note(`识别到 ${list.length} 个模型，可在下方下拉里选择。`, 'success')
        } catch (error) {
          setModels([])
          note(`识别失败：${error?.message ?? error}`, 'error')
        } finally {
          setDetecting(false)
        }
      }, [note])

      const ready = hasKey && String(config?.apiUrl ?? '').trim() !== ''

      if (config === null) {
        return h('div', { style: { padding: 20, color: T.muted, fontSize: 13 } }, '正在读取配置…')
      }

      return h('div', { style: { padding: '4px 2px 28px', color: T.text, fontSize: 13, maxWidth: 880 } },
        h('div', { style: { marginBottom: 14 } },
          h('div', { style: { fontSize: 16, fontWeight: 600 } }, '图像生成'),
          h('div', { style: { color: T.muted, fontSize: 12, marginTop: 4, lineHeight: 1.6 } },
            '把外部生图服务接成平台工具。模型在对话里调用 generate_image 即可出图，'
            + '图片以平台原生图片块显示。这里的接口与对话模型完全独立 —— 你可以在 DeepSeek 上聊天、在别处画图。'),
        ),

        h(Card, { title: '状态', tone: ready ? undefined : 'warn' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('span', { style: { color: ready ? T.success : T.warn } }, ready ? '● 可以生图' : '● 配置还不完整'),
            h('span', { style: { color: T.muted, fontSize: 12 } },
              ready
                ? `密钥已设置（${keyHint ?? '…'}）`
                : '需要同时填好「接口地址」和「API Key」'),
          ),
        ),

        h(Card, {
          title: '接口',
          subtitle: '任意 OpenAI 兼容端点：OpenAI、智谱、通义千问、SiliconFlow，以及各类中转服务。'
            + '本机生图服务（如 http://127.0.0.1:7860）同样支持。',
        },
          h(Row, { label: '接口地址', hint: '形如 https://api.openai.com/v1' },
            h(Input, {
              value: config.apiUrl,
              onChange: value => set('apiUrl', value),
              placeholder: 'https://api.openai.com/v1',
            }),
          ),
          h(Row, {
            label: 'API Key',
            hint: hasKey ? '已保存。留空表示不修改' : '只存在本机，不会回传到浏览器',
          },
            h(Input, {
              type: 'password',
              value: apiKeyInput,
              onChange: setApiKeyInput,
              placeholder: hasKey ? '••••••••（已设置）' : 'sk-…',
            }),
            hasKey ? h(Button, { onClick: clearKey, disabled: busy, tone: 'danger' }, '清除') : null,
          ),
          h('div', null,
            h(Row, { label: '生图模型', hint: '留空则不发送 model 字段，由上游决定。也可点右侧按钮从上游识别' },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', width: '100%', minWidth: 0 } },
                h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                  h(Input, {
                    value: config.model,
                    onChange: value => set('model', value),
                    placeholder: 'gpt-image-1',
                  }),
                ),
                h(Button, { onClick: detectModels, disabled: busy || detecting }, detecting ? '识别中…' : '识别上游模型'),
              ),
            ),
            models.length > 0
              ? h(Row, { label: '选择模型', hint: `上游共 ${models.length} 个模型；选中即填入上面的输入框` },
                  h(Select, {
                    value: '',
                    onChange: value => { if (value !== '') set('model', value) },
                    options: [{ value: '', label: `（共 ${models.length} 个，点此选择）` }]
                      .concat(models.map(name => ({ value: name, label: name }))),
                  }),
                )
              : null,
          ),
        ),

        h(Card, { title: '默认出图参数', subtitle: '模型调用工具时可以不传这些，就会用这里的默认值。' },
          h(Row, { label: '尺寸', hint: '需要特殊尺寸时，在对话里让模型传 size 参数（例如「用 3200x1440 画」）' },
            h(Select, {
              value: config.size,
              onChange: value => set('size', value),
              options: sizeOptionsFor(config.size),
            }),
          ),
          h(Row, { label: '张数' },
            h(Select, {
              value: String(config.count ?? 1),
              onChange: value => set('count', Number(value)),
              options: [1, 2, 3, 4].map(n => ({ value: String(n), label: `${n} 张` })),
              width: 160,
            }),
          ),
        ),

        h(Card, { title: '图片保存', subtitle: '生成后自动保存到此目录；不填写时继续使用当前会话的 generated-images 文件夹。' },
          h(Row, { label: '默认保存路径', hint: '填写文件夹路径；绝对路径或相对会话工作目录的路径均可' },
            h(Input, {
              value: config.savePath,
              onChange: value => set('savePath', value),
              placeholder: '留空：./generated-images/',
            }),
          ),
        ),

        h(Card, {
          title: '调用前确认',
          subtitle: '开启后，模型每次想画图都会先弹窗问你一次 —— 生图是真实计费的，'
            + '不希望你不在场时被刷。关掉则直接生成。',
        },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: T.text } },
            h('input', {
              type: 'checkbox',
              checked: config.confirmBeforeGenerate !== false,
              onChange: event => set('confirmBeforeGenerate', event.target.checked),
            }),
            '每次生图前向我确认',
          ),
        ),

        h(Card, {
          title: '高级',
          subtitle: '超时不要设得太小：生图是同步接口，实测几十秒很正常。',
        },
          h(Row, { label: '超时（毫秒）' },
            h(Input, {
              value: String(config.timeoutMs ?? 180000),
              onChange: value => set('timeoutMs', Number(value.replace(/[^\d]/g, '')) || 0),
              width: 180,
            }),
          ),
          h(Row, { label: '单张大小上限', hint: '字节；超过就拒绝保存这张图' },
            h(Input, {
              value: String(config.maxImageBytes ?? 20971520),
              onChange: value => set('maxImageBytes', Number(value.replace(/[^\d]/g, '')) || 0),
              width: 180,
            }),
          ),
          h(Row, { label: '可选透传', hint: '只在你填了值时才发给上游；留空则不发送该字段' },
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, width: '100%' } },
              ...[['quality', 'quality（画质）'], ['style', 'style（风格）'], ['background', 'background（背景）'], ['outputFormat', 'outputFormat（格式）']]
                .map(([key, label]) => h('div', { key, style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  h('span', { style: { color: T.muted, fontSize: 11, flex: '0 0 124px' } }, label),
                  h(Input, { value: config[key], onChange: value => set(key, value) }),
                )),
            ),
          ),
        ),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, position: 'sticky', bottom: 0, padding: '10px 0', background: T.surface } },
          h(Button, { onClick: () => save(), disabled: busy, tone: 'primary' }, busy ? '处理中…' : '保存'),
          h(Button, { onClick: () => load(), disabled: busy }, '重新读取'),
          message ? h('span', { style: { color: message.color, fontSize: 12 } }, message.text) : null,
        ),

        h(Card, { title: '外部调用接口', subtitle: '不想经过模型时，任何程序都可以直接调这两个端点。' },
          h('pre', {
            style: {
              margin: 0, padding: 10, borderRadius: 6, overflowX: 'auto',
              background: T.surface2, color: T.muted, fontSize: 11.5, lineHeight: 1.7,
              border: `1px solid ${T.border}`,
            },
          }, [
            'GET  /api/image-tool/status      → 配置状态（hasKey + 指纹，不含密钥）',
            'GET  /api/image-tool/config      → 当前配置（已剔除 apiKey）',
            'POST /api/image-tool/config      → 写入配置（{ apiUrl, apiKey, model, ... }）',
            'POST /api/image-tool/generate    → 生图；加 ?includeData=1 直接拿 base64',
          ].join('\n')),
        ),

        h('div', { style: { color: T.muted, fontSize: 11.5, lineHeight: 1.8 } },
          '密钥以明文保存在 profile 的 cordis.patch.yml 里（平台会把它从 API 回包中剥掉，但不加密存储）。',
          '如果这不可接受，请只填权限受限的 Key。',
        ),
      )
    }

    // ── 装配 ──────────────────────────────────────────────────────────────────

    function apply(ctx) {
      // `inject` 先声明依赖，再 register：这样槽位在 settings 页就绪后才挂上，
      // 也保证卸载时注册被成对回收。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'image-tool',
        order: 42,
        label: () => '图像生成',
      }, () => h(SettingsPage)))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-image-tool'
    return module.exports
  },
})
