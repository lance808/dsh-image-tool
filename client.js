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
    const { createElement: h, useState, useEffect, useCallback, useMemo, useRef } = React

    /**
     * 全屏查看用 portal。
     *
     * 为什么非要 portal：内联的 `position: fixed` 会被任一祖先的 `transform` /
     * `overflow` / `contain` 变成"相对该祖先定位"，图片就会被裁在工具卡片那一小块里。
     * 平台自己的浮层也是挂到 body 上的。
     *
     * 拿不到 react-dom 时不假装能做到：退回"就地渲染 fixed 层"，功能可用（可能被裁），
     * 而不是整张卡片崩掉 —— 卡片渲染抛错会被宿主永久弃用，代价远大于少一个浮层。
     */
    let createPortal = null
    try { createPortal = require('react-dom').createPortal ?? null } catch { createPortal = null }
    // 第二档兜底：外壳可能把 ReactDOM 挂在 window 上而不是模块表里。
    // 两档都没有就降级（见上），功能可用、只是浮层可能被祖先容器裁切。
    if (typeof createPortal !== 'function' && typeof window !== 'undefined' && window.ReactDOM?.createPortal) {
      createPortal = window.ReactDOM.createPortal
    }

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
      overlay: 'var(--dsw-alias-bg-overlay)',
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

    // ── 工具卡片：把生成/修改的图片真正画出来 ────────────────────────────────
    //
    // 为什么需要这一整块：平台内置的图片卡片**只认 `read_image` 这一个工具名**
    // （ui-tool 的 `imageCardModel` 里写死 `call?.name !== 'read_image'` 就返回空），
    // 其余工具落到通用卡片，而通用卡片把非文本内容块 `JSON.stringify` 之后直接显示 ——
    // 也就是说，不注册这张卡，用户在对话里看到的是一坨附件引用 JSON，不是图片。
    //
    // 三条必须守住的契约（都是踩过才知道的）：
    //   ① `tool.call.toolview` 的 key 必须**逐字等于工具名**；keyed 槽位同 key 同优先级
    //      会抛错（热重载直接 fatal），所以传 `priority: -1`。
    //   ② **不能**声明 `tool.call.images` 子槽：内置 read_image 的 toolview 已经声明了它，
    //      一个子槽只能由一个 entry 声明，重复声明会让整条注册失败。
    //   ③ 取字节只能走 owner props 给的 `loadImage(attachment)`（会话授权加载器）；
    //      自己拼 URL 拿不到授权。并且我们的 inject face 里**不能**出现 loadImage 这个名字
    //      —— 渲染器展开顺序是 {...injected, ...slotProps, ...ownerProps}，同名会被静默
    //      覆盖，只表现为运行期取图走到错的分支。

    /** 这两个工具名的卡片由本插件提供，与 host 半注册的工具名逐字一致。 */
    const IMAGE_TOOL_KEYS = ['generate_image', 'image_edit']

    /** 工具结果的内容块；兼容 `block.result.content` 这层包装。 */
    function resultContentOf(block) {
      if (block && Array.isArray(block.content)) return block.content
      if (block && block.result && Array.isArray(block.result.content)) return block.result.content
      return []
    }

    /** host 半的 presentationMeta（落盘路径等界面事实）；两个位置都读一遍。 */
    function resultMetaOf(block) {
      const candidates = [block ? block.meta : null, block && block.result ? block.result.meta : null]
      for (const value of candidates) {
        if (value && typeof value === 'object' && Array.isArray(value.images)) return value
      }
      return null
    }

    /** 结果里的图片附件引用，按顺序。 */
    function imageAttachmentsOf(content) {
      const out = []
      for (const part of content) {
        if (!part || typeof part !== 'object') continue
        if (part.type === 'image' && part.attachment && typeof part.attachment === 'object') out.push(part.attachment)
      }
      return out
    }

    function textOf(content) {
      return content
        .filter(part => part && part.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n')
    }

    function formatBytes(value) {
      const bytes = Number(value)
      if (!Number.isFinite(bytes) || bytes <= 0) return ''
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }

    /** 绝对路径 → 相对会话工作目录的写法（openFile 与人读都更顺眼）。 */
    function relativizeToCwd(cwd, file) {
      if (typeof file !== 'string' || file === '') return null
      if (typeof cwd !== 'string' || cwd === '') return file
      const separator = cwd.includes('\\') ? '\\' : '/'
      const root = cwd.endsWith(separator) ? cwd : cwd + separator
      if (!file.startsWith(root)) return file
      return './' + file.slice(root.length).split('\\').join('/')
    }

    const linkStyle = {
      color: T.brand,
      fontSize: 11,
      textDecoration: 'none',
      border: `1px solid ${T.border}`,
      borderRadius: 6,
      padding: '2px 8px',
      whiteSpace: 'nowrap',
    }

    const linkButtonStyle = {
      ...linkStyle,
      background: 'transparent',
      font: 'inherit',
      cursor: 'pointer',
    }

    /**
     * 全屏查看。
     *
     * 必须 portal 到 body：内联的 `position: fixed` 会被任一祖先的 transform /
     * overflow / contain 变成"相对该祖先定位"，图片就被裁在工具卡片那一小块里。
     * 拿不到 react-dom 时退回就地渲染 —— 少一个浮层，好过整张卡片崩掉
     * （卡片渲染抛错会被宿主永久弃用）。
     */
    function Lightbox({ src, label, onClose }) {
      useEffect(() => {
        const onKey = event => { if (event.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKey)
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
          document.removeEventListener('keydown', onKey)
          document.body.style.overflow = previous
        }
      }, [onClose])
      const overlay = h('div', {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': label,
        onClick: onClose,
        style: {
          position: 'fixed', inset: 0, zIndex: 2000,
          // 用平台的浮层色令牌而不是写死的半透明黑：浅色主题下黑底白字虽然也能看，
          // 但那是一块"不属于这个界面"的颜色，会被主题切换立刻暴露出来。
          background: T.overlay,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 24, cursor: 'zoom-out',
        },
      },
        h('img', {
          src, alt: label,
          onClick: event => event.stopPropagation(),
          style: { maxWidth: '92vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: 8, border: `1px solid ${T.border}` },
        }),
        h('div', {
          style: { position: 'fixed', top: 16, right: 20, display: 'flex', gap: 10, alignItems: 'center' },
          onClick: event => event.stopPropagation(),
        },
          h('a', { href: src, download: label, style: { ...linkStyle, background: T.surface, fontSize: 12, padding: '4px 10px' } }, '下载'),
          h('button', {
            type: 'button',
            onClick: onClose,
            style: { color: T.text, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6, padding: '4px 10px', fontSize: 12, font: 'inherit', cursor: 'pointer' },
          }, '关闭（Esc）'),
        ),
      )
      return createPortal ? createPortal(overlay, document.body) : overlay
    }

    /**
     * 一张图片：缩略图 + 尺寸信息 + 下载 / 在本地打开。
     *
     * 两条加载失败路径都要接住：promise 失败（未授权、附件已被清理）与 `<img onError>`
     * （URL 拿到了但读不出来）。只接一条的话，另一种情况会留一个裂图图标在那儿。
     */
    function ImageThumb({ attachment, index, diskPath, loadImage, cwd, openFile, onZoom }) {
      const [url, setUrl] = useState(() => {
        try { return loadImage?.peek?.(attachment) ?? null } catch { return null }
      })
      const [failed, setFailed] = useState(false)

      useEffect(() => {
        let alive = true
        setFailed(false)
        if (typeof loadImage !== 'function') {
          setFailed(true)
          return () => { alive = false }
        }
        let pending
        try {
          pending = loadImage(attachment)
        } catch {
          setFailed(true)
          return () => { alive = false }
        }
        Promise.resolve(pending).then(value => {
          if (!alive) return
          if (typeof value === 'string' && value !== '') setUrl(value)
          else setFailed(true)
        }).catch(() => { if (alive) setFailed(true) })
        return () => { alive = false }
      }, [attachment, loadImage])

      const label = attachment?.name || `图片 ${index + 1}`
      const relative = diskPath ? relativizeToCwd(cwd, diskPath) : null
      const dimensions = attachment?.width && attachment?.height ? `${attachment.width}×${attachment.height}` : '尺寸未知'
      const size = formatBytes(attachment?.bytes)

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, width: 168 } },
        h('button', {
          type: 'button',
          onClick: () => { if (url && !failed) onZoom({ url, label }) },
          title: failed ? '图片加载失败' : '点击全屏查看',
          style: {
            width: 168, height: 168, padding: 0, overflow: 'hidden',
            border: `1px solid ${T.border}`, borderRadius: 8, background: T.surface2,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: url && !failed ? 'zoom-in' : 'default',
          },
        }, url && !failed
          ? h('img', {
              src: url, alt: label,
              onError: () => setFailed(true),
              style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
            })
          : h('span', { style: { color: failed ? T.error : T.muted, fontSize: 11, padding: 8, textAlign: 'center' } },
              failed ? '图片加载失败' : '加载中…')),
        h('div', { style: { color: T.muted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          size ? `${dimensions} · ${size}` : dimensions),
        h('div', { style: { display: 'flex', gap: 6 } },
          url && !failed ? h('a', { href: url, download: label, style: linkStyle }, '下载') : null,
          relative ? h('button', {
            type: 'button',
            onClick: () => openFile?.(relative),
            title: relative,
            style: linkButtonStyle,
          }, '打开') : null),
      )
    }

    /**
     * `generate_image` / `image_edit` 的工具卡。
     *
     * 展开状态自己管，而不是用 owner 给的 `useDisclosure`：后者是外部传入的 Hook，
     * "存在才调用"会违反 Hook 调用规则，而无条件调用又要求宿主一定给 —— 一个纯粹的
     * 折叠状态不值得赌这个契约。
     */
    function ImageResultRow(props) {
      const { block, phase, toolName, cwd, loadImage, openFile } = props
      const [expanded, setExpanded] = useState(true)
      const [zoom, setZoom] = useState(null)
      const [elapsed, setElapsed] = useState(0)
      const running = phase !== 'result'

      useEffect(() => {
        if (!running) return undefined
        const started = Date.now()
        const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000)
        return () => clearInterval(timer)
      }, [running])

      const content = useMemo(() => (running ? [] : resultContentOf(block)), [block, running])
      const meta = useMemo(() => (running ? null : resultMetaOf(block)), [block, running])
      const attachments = useMemo(() => imageAttachmentsOf(content), [content])
      const text = useMemo(() => textOf(content), [content])
      const failed = !running && block?.isError === true
      const verb = toolName === 'image_edit' ? '改图' : '生成图片'

      const summary = running
        ? `正在${verb}… 已等待 ${elapsed}s（同步接口几十秒很正常）`
        : failed
          ? '失败'
          : attachments.length > 0
            ? `${attachments.length} 张 · ${attachments[0]?.width ?? '?'}×${attachments[0]?.height ?? '?'}`
            : '没有产出图片'

      return h('div', {
        style: { border: `1px solid ${T.border}`, borderRadius: 10, background: T.surface, overflow: 'hidden', margin: '2px 0' },
      },
        h('button', {
          type: 'button',
          onClick: () => setExpanded(value => !value),
          style: {
            width: '100%', display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 12px', background: 'transparent', border: 'none',
            font: 'inherit', cursor: 'pointer', textAlign: 'left',
          },
        },
          h('span', { style: { color: T.text, fontSize: 13, fontWeight: 600, flex: '0 0 auto' } }, verb),
          h('span', {
            style: { color: failed ? T.error : T.muted, fontSize: 12, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, summary),
          h('span', { style: { color: T.muted, fontSize: 11, flex: '0 0 auto' } }, expanded ? '收起' : '展开'),
        ),
        expanded && (attachments.length > 0 || text || meta?.origin)
          ? h('div', { style: { padding: '4px 12px 14px', display: 'flex', flexDirection: 'column', gap: 12 } },
              attachments.length > 0
                ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12 } },
                    ...attachments.map((attachment, index) => h(ImageThumb, {
                      key: attachment?.attachmentId ?? `image-${index}`,
                      attachment,
                      index,
                      diskPath: meta?.images?.[index]?.diskPath ?? null,
                      loadImage,
                      cwd,
                      openFile,
                      onZoom: setZoom,
                    })))
                : null,
              meta?.origin
                ? h('div', { style: { color: T.muted, fontSize: 11 } }, `原图：${meta.origin}`)
                : null,
              text
                ? h('pre', {
                    style: {
                      margin: 0, padding: 10, borderRadius: 6, overflowX: 'auto',
                      background: T.surface2, color: T.muted, fontSize: 11.5, lineHeight: 1.7,
                      border: `1px solid ${T.border}`, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    },
                  }, text)
                : null)
          : null,
        zoom ? h(Lightbox, { src: zoom.url, label: zoom.label, onClose: () => setZoom(null) }) : null,
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
            '把外部生图服务接成平台工具。模型在对话里调用 generate_image 生成新图、'
            + '调用 image_edit 改已有图（含局部重绘）；图片直接显示在对话里，可点开全屏、下载、在工作区打开。'
            + '这里的接口与对话模型完全独立 —— 你可以在 DeepSeek 上聊天、在别处画图。'),
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
            h(Row, {
              label: '改图模型',
              hint: '留空则沿用上面的生图模型。改图走 /images/edits，有些服务商生图与改图是两个模型名',
            },
              h(Input, {
                value: config.editModel,
                onChange: value => set('editModel', value),
                placeholder: '留空：沿用生图模型',
              }),
            ),
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
          h(Row, {
            label: '改图尺寸',
            hint: '留空则沿用上面的尺寸；两处都留空就完全不带 size，由上游按原图尺寸处理（改图通常希望这样）',
          },
            h(Select, {
              value: config.editSize,
              onChange: value => set('editSize', value),
              options: sizeOptionsFor(config.editSize),
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
          subtitle: '开启后，模型每次想画图或改图都会先弹窗问你一次 —— 两者都真实计费，'
            + '不希望你不在场时被刷。改图的确认框里会写明改的是哪张图。',
        },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: T.text } },
            h('input', {
              type: 'checkbox',
              checked: config.confirmBeforeGenerate !== false,
              onChange: event => set('confirmBeforeGenerate', event.target.checked),
            }),
            '每次生图前向我确认',
          ),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: T.text, marginTop: 8 } },
            h('input', {
              type: 'checkbox',
              checked: config.confirmBeforeEdit !== false,
              onChange: event => set('confirmBeforeEdit', event.target.checked),
            }),
            '每次改图前向我确认（确认框里会写明改的是哪张图）',
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
            'POST /api/image-tool/edit        → 改图；body 需带 cwd（路径边界）与 image/prompt',
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
      // ── 工具卡片 ────────────────────────────────────────────────────────────
      // 每个工具名一条独立注册：
      //   · `key` 必须逐字等于 host 半注册的工具名，写错就是"永远不渲染"，没有任何提示；
      //   · `priority: -1` —— keyed 槽位同 key 同优先级会抛错（热重载时旧注册还在的
      //     那一瞬间就会撞上），压低优先级让它始终是一个"可替换的补位"；
      //   · 外层 try/catch：这条失败不该连设置页一起没有，工具本身更不该受影响。
      try {
        for (const key of IMAGE_TOOL_KEYS) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
            name: 'tool.call.toolview',
            key,
            priority: -1,
          }, ImageResultRow))
        }
      } catch (error) {
        console.warn('[dsh-image-tool] 工具图片卡注册失败（工具与设置页不受影响）：', error)
      }

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
