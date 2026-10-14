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

    function Select({ value, onChange, options, width = '100%' }) {
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
      }, options.map(option => h('option', { key: option.value, value: option.value }, option.label)))
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

    const SIZE_PRESETS = [
      { value: '', label: '（使用上游默认）' },
      { value: '512x512', label: '512 × 512' },
      { value: '1024x1024', label: '1024 × 1024' },
      { value: '1024x1536', label: '1024 × 1536（竖）' },
      { value: '1536x1024', label: '1536 × 1024（横）' },
      { value: '1792x1024', label: '1792 × 1024（宽）' },
    ]

    function SettingsPage() {
      const [config, setConfig] = useState(null)
      const [hasKey, setHasKey] = useState(false)
      const [keyHint, setKeyHint] = useState(null)
      const [apiKeyInput, setApiKeyInput] = useState('')
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)

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
          h(Row, { label: '生图模型', hint: '留空则不发送 model 字段，由上游决定' },
            h(Input, {
              value: config.model,
              onChange: value => set('model', value),
              placeholder: 'gpt-image-1',
            }),
          ),
        ),

        h(Card, { title: '默认出图参数', subtitle: '模型调用工具时可以不传这些，就会用这里的默认值。' },
          h(Row, { label: '尺寸' },
            h(Select, {
              value: config.size,
              onChange: value => set('size', value),
              options: SIZE_PRESETS,
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
