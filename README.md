# dsh-image-tool

> 给 **DeepSeek Harness** 补上生图与改图能力：把任意 OpenAI 兼容的生图服务接成平台工具，
> 模型在对话里说要画图或改图，图片就以**平台原生图片卡**出现在对话中。

*An image generation & editing plugin for DeepSeek Harness — any OpenAI-compatible image API,
exposed as native platform tools.*

- **生图 API 与对话模型 API 完全独立** —— 用 DeepSeek 聊天、用别处画图，各配各的密钥
- **两个工具**：`generate_image` 生成新图；`image_edit` 基于已有图做修改（局部重绘 / 换风格 / 扩图）
- **连续改图**：`image_edit` 不传原图就取本会话最近一张 —— 「把这张图改成…」可以直接连着说
- **对话里就是图** —— 注册平台工具卡，缩略图、点击全屏、下载、在工作区打开展开即用
- **不引入任何私有内容块** —— 只用平台自己的 `image` 块，纯文本模型也能安全经过
- **调用前弹窗确认**（生图与改图各自一个开关）—— 真实计费，不希望你不在场时被刷
- **完整的设置页** —— DSH「设置 → 图像生成」里填接口、密钥、默认参数与保存目录
- **一键识别上游模型** —— 设置页点「识别上游模型」即从 `{apiUrl}/models` 拉取列表并选择
- **外部调用接口** —— `/api/image-tool/*`，不想经过模型时由别的程序直接调
- **不依赖构建** —— 宿主半是普通 ESM，浏览器半是手写的 ModuleLoader bundle

---

## 目录

- [1. 它解决了什么问题](#1-它解决了什么问题)
- [2. 安装](#2-安装)
- [3. 配置](#3-配置)
- [4. 使用](#4-使用)
- [5. 安全与隐私](#5-安全与隐私)
- [6. 关于"纯文本模型看到的占位文本"](#6-关于纯文本模型看到的占位文本)
- [7. 项目结构](#7-项目结构)
- [8. 开发与测试](#8-开发与测试)
- [9. 已知限制](#9-已知限制)
- [10. 许可证](#10-许可证)

---

## 1. 它解决了什么问题

DeepSeek Harness 里**没有"生图协议"这条通道**。LLM 适配器的契约是
`stream() → 文本 + 工具调用`，图片想进入对话，只有一条正路：

> 由**工具结果**携带平台的 `{ type: 'image', attachment }` 内容块。

所以"补全生图接口"不是发明一个协议，而是**把图片接进既有的内容块体系**。
本插件做的就是这件事：注册一个工具，工具内部打生图接口，结果渲染成平台自己的图片块。

**为什么不能用私有内容块**：平台的消息适配器**不会跳过未知块** —— 一个自定义块类型
会让整个回合以 `UNSUPPORTED_CONTENT` 失败，连文本都拿不到。用平台自己的 `image` 块，
纯文本模型与多模态模型就能共用同一条链路，无需任何配置分叉。

**为什么还要自己画卡片**：平台内置的图片卡**只认 `read_image` 这一个工具名**
（`ui-tool` 的 `imageCardModel` 写死了这一点）。别的工具落到通用卡片，而通用卡片会把
非文本内容块 `JSON.stringify` 之后显示 —— 也就是说，只把 `image` 块塞进结果、
不注册工具卡的话，用户在对话里看到的是一坨附件引用 JSON，而不是图片。
本插件注册 `tool.call.toolview` 的 `generate_image` / `image_edit` 两个 key，把图真正画出来
（缩略图、点击全屏、下载、在工作区打开），并且**不**声明 `tool.call.images` 子槽 ——
那个子槽已被内置的 `read_image` 声明，一个子槽只能由一个 entry 声明。

**改图为什么是另一个工具**：`generate_image` 与 `image_edit` 的必填项不同（改图必须有一张原图）、
上游端点不同（`/images/generations` 收 JSON，`/images/edits` 收 multipart/form-data）、
闸门也不同（改图确认框要写明改的是哪张图）。合成一个带 `action` 参数的工具有百害而无一利。

---

## 2. 安装

```bash
node scripts/install-into-profile.mjs desktop
```

参数是 **profile 名**（不传则读 `DSH_PROFILE`，再不然默认 `web`）。脚本做三件事，全部幂等：

1. `~/.dsh/plugins/dsh-image-tool` → 本目录（人工可读的"安装位"）
2. `<profile>/node_modules/dsh-image-tool` → ①（Node 的解析路径，缺了加载不起来）
3. `<profile>/package.json` 的 `dependencies` + `dsh.profile.bundles`

装完 **重启 DSH**。

> **为什么不用 `dsh plugin add`**：那条路依赖 dsh CLI 与 pnpm，很多只有桌面端的环境没有。
> 本插件是纯 JS、只有一个普通依赖，两层目录链接 + 一行 profile 声明就够了，不需要构建步骤。

脚本对已存在的链接**不会静默覆盖**：如果目标指向别处，它会报错并打印当前值与期望值，
让你自己决定 —— 默默覆盖等于替你做了一个你不知情的决定。

---

## 3. 配置

### 3.1 在 DSH 设置页里填（推荐）

**设置 → 图像生成**，一个完整表单：

| 分组 | 内容 |
|---|---|
| 接口 | 接口地址、API Key、生图模型、改图模型（可点「识别上游模型」拉取列表选择） |
| 默认出图参数 | 尺寸、改图尺寸（均为 1K / 2K / 4K 分组下拉）、张数 |
| 图片保存 | 默认保存路径 |
| 调用前确认 | 每次生图 / 改图前向我确认（两个独立开关） |
| 高级 | 超时、单张大小上限、四个可选透传项 |

它由插件的**浏览器半**（`client.js`）注册到 `settings.section` 槽位，数据走插件自己的
同源路由 `/api/image-tool/config`。

**密钥永远不会回传到这个页面**：只显示 `已设置（…abcd）`，输入框留空即"不修改"，
清除必须点专门的按钮。

浏览器半是**手写的 ModuleLoader bundle，没有构建步骤** —— React 由外壳提供，
本插件不带任何前端依赖。

#### 识别上游模型

「生图模型」右侧的 **识别上游模型** 按钮会拉取 `{apiUrl}/models`，把结果去重排序后
列成下拉框，选中即填入输入框（**仍然要点「保存」才生效**）。

几个刻意的选择：

- **不自动请求**：只在点按钮时才打上游。打开设置页就自动查，等于每次进设置都替你
  发一次你没要求的网络请求，而且会在你还没填完 Key 的时候就报错。
- **超时 20 秒**：列表接口不该让人等几十秒；慢到这个程度就报错，让你手动填写。
- **失败原因如实回报**：分清"Key 被拒（HTTP 401）"和"这个上游根本不提供 `/models`"，后者要明确提示手动填写。
- **兼容多种回包形态**：`{data:[{id}]}`、`{data:["x"]}`、`{models:[...]}`、裸数组，
  以及用 `name` / `model` 代替 `id` 的网关。
- **识别结果不落盘**：它只是帮你把值填进输入框；配置以点「保存」写入的为准。
- **改过接口地址或密钥后列表作废**：保存成功会清空已识别的列表，避免选到一个不属于当前上游的模型。

### 3.2 用附带的 CLI

```bash
node scripts/configure.mjs                 # 交互式逐项询问
node scripts/configure.mjs --show          # 查看当前状态（含权威的 hasKey）
node scripts/configure.mjs --api-url=https://api.openai.com/v1 --api-key=sk-xxx --model=gpt-image-1
node scripts/configure.mjs --set count=2   # 改单个字段（可重复出现）
node scripts/configure.mjs --clear-key     # 清除已保存的密钥
```

适合脚本化或在没有浏览器时使用。它把 settings RPC（连同本机 Cookie 铸造）包成一条命令。

### 3.3 或者直接调 settings API

配置就是一个标准的 settings 命名空间 **`image-tool`**：

```jsonc
// POST /api/settings/update
{ "ns": "image-tool",
  "patch": { "apiUrl": "https://api.openai.com/v1", "apiKey": "sk-...", "model": "gpt-image-1" } }
```

> ⚠️ 服务方法签名是**位置参数** `update(ns, patch)`，与 RPC 端点的 `{ ns, patch }` 信封不是一回事。

### 3.4 字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `apiUrl` | `''` | 生图接口基址，如 `https://api.openai.com/v1`。**允许本机**（`http://127.0.0.1:7860` 这类本地服务是正当用法） |
| `apiKey` | `''` | 生图服务密钥。与对话模型凭据无关 |
| `model` | `''` | 生图模型名；留空则不发送 `model` 字段，由上游默认。设置页可点「识别上游模型」从 `{apiUrl}/models` 拉取列表后选择 |
| `editModel` | `''` | 改图模型名；留空沿用 `model`。有些服务商的生图与改图是两个模型名，共用一个字段会让改图必然 404 |
| `size` | `''` | 默认尺寸。设置页是**分组下拉**：1K / 2K / 4K 三档，覆盖 1:1、4:3、3:2、16:10、16:9、21:9 电影，以及各自的竖屏方向（3:4 / 2:3 / 10:16 / 9:16 / 9:21），另附 OpenAI 官方固定尺寸。需要列表外的特殊尺寸时，在对话里让模型传 `size` 参数 |
| `editSize` | `''` | 改图尺寸；留空沿用 `size`，两处都留空则**完全不发送 `size`**（由上游按原图尺寸处理 —— 改图通常希望这样） |
| `count` | `1` | 默认张数（1~8） |
| `savePath` | `''` | 默认保存目录；留空保持当前会话的 `generated-images/`，支持绝对目录或相对会话工作目录的目录 |
| `confirmBeforeGenerate` | `true` | 生图前弹窗确认 |
| `confirmBeforeEdit` | `true` | 改图前弹窗确认（独立开关；确认框里会写明改的是哪张图） |
| `timeoutMs` | `180000` | 单次调用上限。生图是同步接口，实测几十秒很正常 |
| `maxImageBytes` | `20971520` | 单张图片字节上限（同时是改图读取原图的上限） |
| `quality` / `style` / `background` / `outputFormat` | `''` | 可选透传项，**只在你填了值时才发给上游**；生图与改图都带 |

配置是 **`live`** 的：改完即时生效，不需要重启，下一次调用就用新值。

### 3.5 端点约定

**生图**打 `{apiUrl}/images/generations`（OpenAI 兼容；如果 `apiUrl` 已经写到这个端点上，
不会重复拼接）：

```jsonc
{ "prompt": "...", "n": 1, "model": "...", "size": "...", "response_format": "b64_json" }
```

**改图**打 `{apiUrl}/images/edits`，`multipart/form-data`，字段为
`model` / `prompt` / `size` / `n` / `response_format` / `image`（二进制）/ `mask`（可选，二进制）。
把 `apiUrl` 填成生图端点也不会拼错 —— 解析时会先把 `/images/generations` 退掉。

> 为什么不走 `generations` + 参考图字段（如 `input_image`）：那类字段各家网关支持不一，
> OpenAI 形态的中转会直接以 `Unknown parameter: 'input_image'` 拒绝；
> `/images/edits` 反而是每个 OpenAI 兼容中继都实现的 portable 路径。

两种请求的回包都支持三种现实形态：`data[].b64_json`、`data[].url`、`data[].image_url.url`。
**媒体类型按魔数嗅探**，不信任上游声明的字段。

---

## 4. 使用

### 4.1 对话工具 `generate_image`

模型在对话里调用即可出图：

```text
用户：画一只在雨里等公交的猫
模型：→ generate_image({ prompt: "一只在雨里等公交的猫", size: "1024x1024" })
```

生成的图片以平台原生 `image` 块进入对话，并在界面上渲染成**图片卡**
（缩略图、点击全屏、下载、在工作区打开）。**保存路径会立即显示在工具结果里**，
不需要额外询问：

```text
第 1 张已生成至 ./generated-images/generated-1730000000000-1.png
已保存到：D:\...\generated-images\generated-1730000000000-1.png
```

落盘位置规则：

- `savePath` 留空 → 保存到当前会话工作目录的 `generated-images/`
- `savePath` 填了 → 保存到该目录（不存在时自动创建）
- 目录不可写 / 拿不到会话工作目录 → **只存附件库**，并在结果里说明原因

**尺寸**：设置页的下拉覆盖常用档位与比例（含竖屏与电影画幅）；需要列表外的特殊尺寸时，
在对话里直接说，模型会把 `size` 传给工具 ——

```text
用户：用 3200x1440 画一张雪山日出
模型：→ generate_image({ prompt: "雪山日出", size: "3200x1440" })
```

这条路径不受下拉限制。若设置页里的当前值是手填的特殊尺寸，下拉会把它单独列成
「…（当前值，不在预设内）」，不会因为找不到匹配项而显示空白。

### 4.2 改图工具 `image_edit`

基于一张已有图片做修改，走 `/images/edits`（multipart 上传原图）：

```json
{ "prompt": "把背景换成夜晚，加几盏路灯", "image": "generated-images/generated-1730000000000-1.png" }
```

**原图（`image` 参数）有三种写法**，按这个顺序判定：

| 写法 | 例子 | 说明 |
|---|---|---|
| 省略 | `{"prompt": "改成水彩风"}` | 取**本会话最近一张图** —— 连续改图就靠它 |
| 附件 ID | `{"image": "sha256:…"}` | 指定会话里某一张（含你自己上传的图） |
| 工作目录路径 | `{"image": "generated-images/…png"}` | 读磁盘上的文件，**必须在当前会话工作目录内** |

"最近一张"同时覆盖两种情况：模型上一轮刚生成的图，以及**你自己上传到对话里的参考图**。
用了哪张会在结果里写明（`原图来源：…`），你可以核对模型改的是不是你以为的那张 ——
这是花钱之前最值得拦住的一种误解，所以确认弹窗里也会带上它。

**局部重绘（mask）**：

```json
{ "prompt": "把这个区域换成一片星空", "mask": "masks/sky.png" }
```

`mask` 与 `image` 一样支持附件 ID 或工作目录路径。约定是 PNG、与原图同尺寸、
**透明处就是允许改动的范围**；媒体类型不是 PNG 时放行但在结果里给一句提示
（有些中继接受别的写法，硬拦反而挡住了能用的路径）。

**尺寸**：`editSize` 与 `size` 都留空时**完全不发送 `size` 字段**，由上游按原图尺寸处理 ——
这通常是改图最不容易出错的行为。

连续改图的完整例子：

```text
用户：画一只在雨里等公交的猫
模型：→ generate_image({ prompt: "一只在雨里等公交的猫" })
用户：把这张图改成晴天
模型：→ image_edit({ prompt: "改成晴天，阳光透过云层" })      # 没传 image → 取最近一张
用户：再给它加一把伞
模型：→ image_edit({ prompt: "给猫加一把黄色的伞" })          # 又取刚改出来的那张
```

### 4.3 另存工具 `save_generated_image`

把已生成的图片另存到别处，**不重新生图、不计费**：

```json
{ "path": "images/天空之城.png" }
```

不传 `attachmentId` 时保存当前会话最近一张图片；指定时从生成结果里取 id：

```json
{ "path": "images/另一份.png", "attachmentId": "sha256:..." }
```

从当前会话的图片块恢复附件引用，因此**不依赖进程内索引，重启后仍可用**。
只接受工作目录内部路径、不覆盖已有文件、不转换编码；省略扩展名时补上实际格式。

### 4.4 外部调用接口

供**不需要经过模型**的调用方使用：

```bash
# 配置状态（不回显密钥，只给 hasKey 与末四位指纹）
GET  /api/image-tool/status

# 读 / 写配置（设置页用的就是这两个）
GET  /api/image-tool/config
POST /api/image-tool/config      { "apiUrl": "...", "apiKey": "...", "clearApiKey": false, ... }

# 识别上游可用模型（设置页的「识别上游模型」按钮用的就是它）
GET  /api/image-tool/models      → { ok, models: ["..."], endpoint, count }

# 生图；includeData=1 时额外返回 base64 字节
POST /api/image-tool/generate
     { "prompt": "一只猫", "size": "1024x1024", "count": 1 }

# 改图；HTTP 调用必须传 cwd（路径边界），image 用工作目录内的相对路径
POST /api/image-tool/edit
     { "cwd": "D:\\work", "image": "input.png", "prompt": "改成夜景", "mask": "mask.png" }

# 读取本次挂载期间生成的附件字节（需要同一会话鉴权 Cookie）
GET /api/image-tool/image?id=<attachmentId>
GET /api/image-tool/image?id=<attachmentId>&download=1   # 带 Content-Disposition，可浏览器另存
```

生成与改图的响应形状**完全一致**：`images[]` 包含完整 `ref`、`fetchUrl` 与 `downloadUrl`；
改图额外带 `origin`（用了哪张原图）。外部调用方不需要为"这次是改图"换一套解析逻辑。

> `/image` 的引用索引最多保存 200 条，插件重新挂载（含配置更新）或进程重启后失效。
> 长期保留字节请用 `includeData=1` 并自行保存。
>
> 外部 HTTP 调用**没有会话工作目录**，所以 `/generate` 不落盘；`/edit` 需要按路径读原图，
> 因此要在请求体里显式给出 `cwd` —— 我们既无法替你判断"这个路径在不在允许范围内"，
> 也不该拿进程当前目录去猜。给了 `cwd` 就与工具路径一样落盘。

#### ⚠️ 鉴权是**自己做的**，不是白捡的

这一点很容易想当然，而想错的后果是安全漏洞：

> 挂在 `webServer` 上的自定义 prefix 路由会**抢在** `/api` 的会话鉴权之前
> —— webServer 按**最长前缀**派发，本插件的前缀比 `/api` 更长。

所以这些端点**不会**自动继承 `/api/*` 的鉴权。本插件显式向 `connection` 服务要判定
（`connection.requestRejection(request)`）；拿不到 `connection` 时**不假装安全**：
只提供只读面，配置写入、生图与**上游模型查询**一律 403。

**工具路径与 HTTP 路径共用同一份 `runGenerate` / `runEdit`**，所以协议、校验、SSRF 关卡、
附件落地完全一致，不存在"两条路行为不同"。唯一差别是：**确认弹窗只加在工具路径上** ——
那个闸门要防的是"模型自作主张花钱生图"；HTTP 调用是调用方主动发起的明确意图，
再弹一次窗既问错了人，也会让自动化无法工作。

> 本插件**不含任何聊天平台相关内容**，是通用的生图工具。

---

## 5. 安全与隐私

### ⚠️ 密钥的落盘语义（请务必知道）

`apiKey` 标记为 `role('secret')`，它保证的是：

- ✅ **不会回传到浏览器**：平台的 settings 投影会把它结构化剥离，API 只报告
  `secrets: [{ path: ['apiKey'], set: true }]`，前端永远拿不到原值。
- ❌ **不是加密存储**：它会以**明文**写进 `<profile>/cordis.patch.yml` 里那条 entry 的
  `config` 段。该文件的权限是**默认 ACL**（本机用户与管理员可读），**不是 0600**。

如果这个取舍不可接受：请只填权限受限的 Key，或改用 DSH 的凭据服务自行托管密钥。

### 清除密钥要用 unset，不是写空串

把 `apiKey` 写成 `""` **不会**清除它 —— secret 字段把空串当作"本次没有改动"，
这是平台为避免"没渲染出来的密钥被空表单误删"而定的语义。正确做法：

```bash
node scripts/configure.mjs --clear-key
# 等价于 settings/mutate 的 { op: 'unset', path: ['apiKey'] }
```

### 两条地址的可信度是**分开**对待的

| 地址 | 来源 | 策略 |
|---|---|---|
| `apiUrl` | **你自己填的** | **允许本机/私网**。本地生图服务（SD WebUI、ComfyUI、one-api…）是正当用法，拦掉等于把本地部署判死 |
| 回包里的图片 `url` | **上游给的** | **过 SSRF 关卡**：只允许 http/https，拒绝环回、私网、链路本地（含 `169.254.169.254` 云元数据）、`.local`、IPv6 的 `fc`/`fd`/`fe80`/`::1` 及 IPv4-mapped 形态 |

把这两条混成一条，不是把本地用户拦死，就是把内网暴露出去。

图片下载另有约束：**禁止自动重定向**（避免校验过的公网地址跳进内网）、
按流累计校验大小（不只是信任 `Content-Length`）、并接受调用方的取消信号。

### 其他

- 没有显式 Key 时**一个字节都不发**（不会拿别处的凭据顶上）。
- 回包正文有 32 MiB 上限，图片下载有 15 秒 / `maxImageBytes` 上限。
- **不做自动重试**：生图按张计费，盲目重试会在"其实已经出图、只是回包慢"时重复计费。
  失败就把原因讲清楚，由你决定要不要再来一次。
- 另存工具**限定在工作目录内**，拒绝覆盖已有文件，且会逐段拒绝符号链接目录。
- **改图会把原图字节上传给上游**（这正是 `/images/edits` 的工作方式），
  而且它只读**当前会话工作目录内**的文件 —— 想改别处的图，先复制进来。

---

## 6. 关于"纯文本模型看到的占位文本"

如果当前对话模型只接受文本，平台会在派发前把每个 `image` 块替换成一段占位：

```text
[image omitted because this model accepts text only; attachment sha256:...]
```

**这是正常行为，不是错误** —— 图片已经生成并落进附件库，**界面上照样显示图片卡**
（卡片读的是工具结果的附件引用与 `presentationMeta`，与模型能不能看图无关），
只是这个模型看不到像素。换成多模态模型就能直接看到。

之所以要这么设计：平台的消息适配器不会跳过未知块，而用一个私有块去渲染图片会让
整个回合失败。用平台自己的 `image` 块，两类模型就能共用同一条链路，无需任何配置。
改图工具同理：把图交给外部服务改，根本不依赖当前模型有没有视觉能力。

---

## 7. 项目结构

```text
dsh-image-tool/
├── package.json                dsh.bundle.patch + dsh.client（宿主半 + 浏览器半）
├── cordis.patch.yml            bundle patch；entry id 必须是 image-tool
├── client.js                   浏览器半：注册「图像生成」设置页（settings.section）
│                               + generate_image / image_edit 的工具卡（tool.call.toolview）
│                               手写 ModuleLoader bundle，无构建步骤
├── lib/
│   ├── index.js                入口：Config schema / apply（step() 逐步容错）/
│   │                           runGenerate + runEdit / imageToolOutput（render + presentationMeta）
│   │                           落盘：makeDiskSaver + cwdFromExecution + makeImageFetcher
│   ├── generate.js             协议核心：生图 JSON / 改图 multipart 两条请求的构造与发送、
│   │                           回包解析 / SSRF 关卡 / 附件与磁盘落地 / 上游模型列表
│   │                           （纯逻辑，不碰 ctx，可离线测）
│   ├── image-source.js         改图输入解析：会话最近一张 / 附件 ID / 工作目录路径（含越界与
│   │                           符号链接防护），mask 与警告
│   ├── routes.js               外部接口 + 鉴权 + /image 取字节 + /models 识别 + /edit
│   ├── save.js                 另存：会话图片恢复 / 路径限制 / 不覆盖写入
│   └── diag.js                 诊断日志
├── scripts/
│   ├── configure.mjs           配置读写 CLI（自包含 Cookie 铸造）
│   ├── install-into-profile.mjs 安装进 profile（幂等）
│   ├── mock-image-api.mjs      本地假服务（返回**真实编码**的 PNG；生图 + 改图两个端点）
│   ├── test-generate.mjs       协议：生图 JSON / 改图 multipart / 回包解析 / SSRF / 超时 / 模型列表
│   ├── test-image-source.mjs   原图解析：路径越界 / 符号链接 / 魔数判定 / 最近一张 / mask
│   ├── test-plugin.mjs         插件契约：命名空间 / volatile / secret / 确认闸门 /
│   │                           两个工具的形状 / 配置接口 / 落盘 / 改图与 /edit 路由
│   ├── test-client.mjs         浏览器半：ModuleLoader 加载 / 槽位 / 工具卡渲染（图片、下载、
│   │                           打开、错误态）/ 设置页 / 主题 / 不碰密钥
│   ├── test-save.mjs           另存：引用恢复 / 越界拒绝 / 不覆盖 / 扩展名校验
│   └── test-mock-api.mjs       用插件自己的解析器验证 mock 服务
├── README.md
└── LICENSE                     MIT
```

**为什么 entry id 必须是 `image-tool`**：DSH 的 settings 命名空间由 loader entry 的 id
推导，写成包名 `dsh-image-tool` 会让 `settings.update({ns:'image-tool'})` 永远抛
`No configurable plugin entry "image-tool"`，于是"在设置里填 API"这条路直接断掉。

---

## 8. 开发与测试

```bash
npm test                     # 五套全跑（不需要 DSH、不联网、不花钱）
npm run test:generate        # 协议：生图 JSON / 改图 multipart / 回包解析 / SSRF 关卡 / 超时
npm run test:image-source    # 改图原图解析：路径越界 / 符号链接 / 魔数 / 最近一张 / mask
npm run test:plugin          # 插件契约：命名空间名 / volatile / secret / render / 确认闸门 / 配置 / 落盘
npm run test:client          # 浏览器半：ModuleLoader 加载 / 槽位注册 / 工具卡渲染 / 不写死颜色 / 不碰密钥

# 端到端（用本地假服务，仍然不花钱）
npm run mock:api             # 另开一个终端：起假服务（默认 18577，返回真实合法 PNG）
npm run test:mock            # 用插件自己的解析器验证 mock 的输出，再走一遍完整链路
```

`scripts/mock-image-api.mjs` 返回的是**真正编码出来的 PNG**（按请求的 `size` 生成正确尺寸），
不是随机字节 —— 否则附件服务的魔数嗅探与解码校验根本不会被触发，验收结论也就不可信。
它同时实现 `/images/generations`（JSON）与 `/images/edits`（**真的解析 multipart**），
后者用另一套色板，于是"改图分支到底有没有生效"可以靠字节差异直接验出来。
提示词里含 `__fail__` 会返回 401、含 `__nolink__` 会返回空 `data`，用于验证错误路径。

诊断日志：`$TMPDIR/dsh-image-tool.log`（可用 `DSH_IMAGE_TOOL_DIAG` 覆盖；设为空串则关闭）。
DSH 本身没有独立日志目录，所以插件「启动失败」的原因只能靠它 —— 这正是 `apply` 里
做能力探测的动机。

### 关于 mock 的宽容度

测试里的 mock **必须如实抛错**。项目早期因为这个吃过亏：mock 里
`ctx.get('webServer')` 返回 `undefined` 而不是抛错，于是"直接读未声明依赖"这个写法
一路溜进真实环境，把整个插件变成「启动失败」——而使用者只看到插件卡上那一个词。

只有能抓住 bug 的测试才算测试。验证修法有效的方式：**临时把代码改回错误写法 →
测试应当 FAIL → 还原 → PASS**。

---

## 9. 已知限制

- **可选服务必须用 `ctx.inject`，不能直接 `ctx.get('x')` / `ctx.x`。**
  这是本项目踩过的最贵的坑：访问**未在 `inject` 里声明**的服务会抛
  `cannot get property "webServer" without inject`，而这行如果在 `apply` 里，
  整个插件的 entry 就直接变成「启动失败」—— 使用者只看到插件卡上那一个词，
  看不到任何原因。只有 Web profile 才有 `webServer`，所以它天然是**可选依赖**：

  ```js
  // ❌ 抛错：webServer 不在 inject 里
  const webServer = ctx.get('webServer') ?? ctx.webServer
  // ✅ 可选依赖的正确写法
  ctx.inject(['connection', 'webServer'], routeCtx => { const ws = routeCtx.get('webServer') })
  ```

  `inject = [...]`（模块导出）是**硬依赖**：缺了插件就不激活。
  `ctx.inject([...], cb)` 才是"可用时才执行"。另外 `apply` 里每一步都独立 try/catch
  （见 `lib/index.js` 的 `step()`）—— 工具挂不上不该拖垮路由，反之亦然。

- **改代码要重启 DSH；改配置不用。** 这两条是真的不一样：
  - **配置**走 `settings.describe()`，是每次调用现读的运行时值（`applies: 'live'`），写入即生效；
  - **代码**是模块，Node 会缓存已加载的 ESM（浏览器半同理，由外壳的模块加载器持有）。
    只改配置文件不会重新加载 `lib/*.js` 或 `client.js`。
  - 另外每次 volatile 更新都会**重新执行 `apply`**，所以诊断日志里会看到多次 `apply:` ——
    这是平台的正常行为，不是重复装载（loader entry 只有一条）。
    ⚠️ 正因如此，工具与路由的注册**必须经 `ctx.effect`**：同一层里重名注册会直接失败，
    症状是插件卡显示「启动失败」，而且**第一次是好的、动过配置之后才坏**。

- **浏览器半依赖外壳的槽位与主题契约**（`settings.section`、`tool.call.toolview`、
  `--dsw-alias-*`、宿主提供 `react`）。这些是平台内部约定，跨大版本升级时可能变；
  `npm run test:client` 会在加载层先把最典型的几种破裂挡下来。
  全屏浮层还需要 `react-dom` 的 `createPortal`：拿不到时**降级**成就地 `fixed` 渲染
  （功能可用，但浮层可能被祖先容器的 `transform` / `overflow` 裁切），不会让卡片崩掉 ——
  卡片渲染抛错会被宿主永久弃用，代价远大于少一个浮层。

- **确认通道依赖 `userQuestions`**：没有它的 composition 里，开启确认会**拒绝生图**并说明原因
  （fail-closed：宁可画不出来，也不要在"说了要问却没问"的情况下花钱）。

- **URL 过滤不是完整的 DNS 出站隔离**：当前检查 URL 主机名与 IP 字面量，
  不做 DNS 解析校验；不可信上游的域名解析仍需由部署环境的网络策略限制。

- **`/image` 引用索引不是持久存储**：配置更新导致重新挂载或进程重启后，
  旧 `fetchUrl` 会返回 404。长期保存请用 `includeData=1`。

- **另存的是附件里的版本**：图片附件可能经过平台规范化（缩放/重编码），
  自动落盘保存的才是上游原图。

- **改图的原图只能来自会话或工作目录**：不接受远程 URL（那等于让模型指挥服务端去请求
  任意地址）。要改远程图，先把它下载进工作目录。
  工作目录内的路径会做**词法 + `realpath` 双重校验**，符号链接/junction 指向盘外时会被拒绝。

- **改图的 `mask` 只做软校验**：OpenAI 约定 mask 必须是 PNG、与原图同尺寸、透明处为编辑区；
  本插件在**不是 PNG 时会给一句提示，但不会替你拦下** —— 不同中继的接受度差别很大，
  硬拦反而挡住了能用的路径。另外**原图与 mask 的尺寸一致性由上游判定**，
  这里不做像素级比对（那需要引入图像库）。

- **`/edit` 的 HTTP 调用必须自带 `cwd`**：会话工作目录在 HTTP 路径上并不存在，
  而"哪些路径允许读"必须有一个边界，插件不会拿进程当前目录去猜。

- **`--set` 的值里不能有前导 `--`**：参数解析把 `--` 开头当作下一个 flag。
  值里真需要时用 `--set key=--value` 形式（带 `=` 的那种解析路径不受影响）。

---

## 10. 许可证

MIT
