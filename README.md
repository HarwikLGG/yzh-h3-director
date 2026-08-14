# dsh-vision-bridge（识图桥接插件）

DeepSeek 本体（`deepseek-official` 适配器）是**纯文本**路由，消息里出现图片会直接报
`UNSUPPORTED_CONTENT`。本插件在每一步请求组装之前拦截用户消息：把其中的图片交给
**你指定的视觉 API 模型**识别，拿到文本描述后**原位替换图片块**，再作为普通文本转发给
DeepSeek 本体。于是 DeepSeek "看到了"图片，而你只需一个 OpenAI 兼容的视觉 API。

## 工作流程

```
你在对话框粘贴/上传图片 + 文字
        │
        ▼
① 网关放行：插件包装 ctx.llm.resolveModelInfo，把 "image" 加入模型的
  inputModalities，让 session.prompt 不再以 MODEL_DOES_NOT_SUPPORT_IMAGES 拒图
        │
        ▼
② agent/pre-step 拦截到 image 块
        │
        ▼
③ 调用你配置的视觉模型（chat/completions + image_url data URL，一张图一次请求）
        │
        ▼
④ 图片块 → "[图片名 的内容描述（由视觉模型 <model> 生成）]\n<描述文本>"
        │
        ▼
⑤ 纯文本消息继续进入 DeepSeek 请求（描述与你的原文按原位顺序排列）
```

> ①是必要的：DeepSeek 适配器声明 `inputModalities: ["text"]`，网关会在图片进入
> 消息管线之前就拒绝带图 prompt。放行是安全的——④保证真正发给适配器的内容里
> 已经没有图片块，适配器自身的 `contentHasImage` 检查不会触发。

## 安装

**前置要求**：Node.js ≥ 20（自带 corepack）、已安装 dsh（`npm install -g @deepseek-ai/dsh`）。

### Windows（PowerShell）

```powershell
# 1) 克隆插件（或手动复制文件夹）
git clone https://github.com/HarwikLGG/dsh-vision-bridge.git C:\vision-bridge

# 2) 一键安装（默认装入 web profile；其他 profile 加 -Profile headless）
cd C:\vision-bridge
powershell -ExecutionPolicy Bypass -File install.ps1
```

脚本自动完成：检查 dsh → 准备 pnpm（无 pnpm 时用 corepack 包装）→
`dsh plugin --profile web add` 安装并登记 bundle →
**Junction** 链接运行时依赖（无需管理员权限）。

配置文件位置：`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`

### Linux / macOS（bash）

```sh
# 1) 克隆插件（或手动复制文件夹）
git clone https://github.com/HarwikLGG/dsh-vision-bridge.git ~/vision-bridge

# 2) 一键安装（默认装入 web profile；其他 profile：bash install.sh headless）
cd ~/vision-bridge
bash install.sh
```

脚本自动完成：检查 dsh → 准备 pnpm（无 pnpm 时用 corepack 包装）→
`dsh plugin --profile web add` 安装并登记 bundle →
符号链接运行时依赖。

配置文件位置：`~/.dsh/profiles/web/cordis.patch.yml`

### 或手动安装（任意平台）

```sh
dsh plugin --profile web add /绝对路径/vision-bridge
# 并把 profile 的 node_modules 链接到插件目录（运行时依赖解析需要）：
#   macOS/Linux:  ln -sfn ~/.dsh/profiles/web/node_modules /绝对路径/vision-bridge/node_modules
#   Windows:      New-Item -ItemType Junction -Path C:\vision-bridge\node_modules -Target %USERPROFILE%\.dsh\profiles\web\node_modules
```

### 大图缩小后端（跨平台）

| 平台 | 缩小后端 | 说明 |
|---|---|---|
| Windows | **sharp** | 首选；安装时若未自动装上，手动执行 `cd %USERPROFILE%\.dsh\profiles\web && pnpm install sharp` |
| Linux | **sharp** | 同上 |
| macOS | **sharp → sips** | 优先 sharp；缺失时自动回退系统内置 sips，零依赖 |

> 大图（超过 `maxVisionPixels`）会先缩小到长边 `visionMaxDimension`（默认 4096）
> 再发送，避免 vLLM / LM Studio 对超大像素图报 500。两个后端都不可用时插件会
> 记录警告并按原图发送（此时超大图可能被视觉服务端拒绝）。

装完后**重启 `dsh web`** 生效（宿主侧插件需要重启加载）。

## 配置（三处之一，优先级从低到高）

1. 插件自带默认值（见下方表格）；
2. profile 用户层 `$DSH_HOME/profiles/web/cordis.patch.yml` 中按行 id 覆盖（改后需重启）；
3. **设置 → 插件 → vision-bridge 卡片**（改后**下一次请求即生效**，无需重启）。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 软开关；`false` 时完全放行（不调视觉 API，图片照旧被 DeepSeek 拒绝） |
| `apiKeyEnv` | `VISION_API_KEY` | 视觉 API Key：环境变量名，或在设置页直接填 Key（凭据服务）；**留空 = 本地端点（LM Studio/Ollama）无需 Key** |
| `baseURL` | `https://api.openai.com/v1` | 任意 OpenAI 兼容端点根地址（自动补 `/chat/completions`） |
| `model` | `gpt-4o-mini` | **你指定的视觉模型 id**，如 `gpt-4o`、`glm-4v-plus`、`qwen-vl-max` 等 |
| `systemPrompt` | 见代码 | 发给视觉模型的系统提示词（内置"文字转录最高优先"） |
| `prompt` | 中文识图指令 | 随图片发送的识图指令（内置分步要求：①逐字转录所有文字 ②主体与布局 ③风格） |
| `maxTokens` | `4096` | 视觉回复的最大 token 数（长描述 + 完整文字转录需要，原 1024 容易截断） |
| `timeoutMs` | `120000` | 单次视觉请求超时（毫秒，大图 + 本地大模型可能较慢） |
| `maxImageBytes` | `4194304` (4 MiB) | 超过此字节数的图片不识别，替换为占位说明 |
| `maxVisionPixels` | `16777216` (16.7M ≈ 4096²) | 像素数超过此值的图片先缩小再发送，避免视觉服务端（vLLM 等）对超大图报错 |
| `visionMaxDimension` | `4096` | 缩小后的长边像素（sharp/sips 缩放，保持宽高比，输出 JPEG） |
| `failOpen` | `false` | 视觉调用失败时：`false` 抛错结束当前 turn（你能看到明确原因）；`true` 用 `[图片识别失败…]` 占位继续 |

### 常见视觉端点示例

| 服务 | baseURL | model 示例 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` / `gpt-4o` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-plus` / `glm-4v-flash` |
| 阿里通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max` / `qwen2.5-vl-72b-instruct` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-VL-72B-Instruct` |
| 月之暗面 | `https://api.moonshot.cn/v1` | `moonshot-v1-8k-vision-preview` |
| 本地（LM Studio / Ollama） | `http://127.0.0.1:1234/v1` | 你本地的视觉模型名 |

> 只要实现了 OpenAI `chat/completions` 且支持 `image_url`（data URL）的端点都能用。

## 第三方视觉模型设置指南

### 方式一：GUI 设置卡片（推荐，保存即生效，无需重启）

打开 **设置 → 插件 → vision-bridge** 卡片，填三个字段：

1. **`baseURL`** — 第三方平台 OpenAI 兼容端点根地址（见下表，直接复制）
2. **`model`** — 该平台的视觉模型 id（见下表）
3. **`apiKeyEnv`** — 给 Key 起个引用名（如 `OPENAI_API_KEY`），然后在同卡片的
   **Key 输入框里粘贴你的 API Key**（保存到本机凭据服务，不会回显到页面）
   > 本地端点（LM Studio / Ollama）无需 Key：`apiKeyEnv` 留空即可

点保存 → 下一次发图立即生效。

### 方式二：环境变量（适合服务器/无 GUI 场景）

```sh
# macOS / Linux
export OPENAI_API_KEY=sk-xxxx
dsh web

# Windows PowerShell
$env:OPENAI_API_KEY = "sk-xxxx"
dsh web
```

配置里 `apiKeyEnv` 写同一个名字即可（如 `OPENAI_API_KEY`）。

### 方式三：配置文件（`$DSH_HOME/profiles/web/cordis.patch.yml`）

```yaml
- id: vision-bridge
  config:
    enabled: true
    apiKeyEnv: OPENAI_API_KEY          # 引用名（环境变量或凭据服务）
    baseURL: https://api.openai.com/v1
    model: gpt-4o-mini
```

改完重启 `dsh web` 生效。

### 主流视觉 API 平台配置速查

| 平台 | baseURL（直接复制） | model 示例 | 获取 API Key |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini`、`gpt-4o` | platform.openai.com → API keys |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-plus`、`glm-4v-flash` | open.bigmodel.cn → API 密钥 |
| 阿里百炼（通义） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max`、`qwen2.5-vl-72b-instruct` | bailian.console.aliyun.com → API-KEY |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-VL-72B-Instruct` | cloud.siliconflow.cn → API 密钥 |
| 月之暗面 | `https://api.moonshot.cn/v1` | `moonshot-v1-8k-vision-preview` | platform.moonshot.cn → API 密钥 |
| DeepSeek（无视觉，备选） | `https://api.deepseek.com` | — | 仅文本，不适用识图 |
| 本地 LM Studio（局域网） | `http://<主机IP>:1234/v1` | 本机已加载的视觉模型名 | 无需 Key，`apiKeyEnv` 留空 |
| 本地 LM Studio（本机） | `http://127.0.0.1:1234/v1` | 本机已加载的视觉模型名 | 无需 Key，`apiKeyEnv` 留空 |
| Ollama | `http://127.0.0.1:11434/v1` | `llava`、`minicpm-v`、`qwen2.5vl` | 无需 Key，`apiKeyEnv` 留空 |

> **如何确认本地模型是不是视觉模型**：浏览器打开 `http://<主机IP>:1234/v1/models`，
> 模型 id 通常带 `vl` / `vision` / `text-image` 字样；或直接发一张图试试。

## 卸载

```sh
dsh plugin --profile web remove dsh-vision-bridge
```

## 说明与限制

- 一张图一次视觉请求（兼容性最好）；同一消息多张图会按顺序逐张识别，标签带文件名或序号。
- 转换发生在 `agent/pre-step` 瀑布，替换后的文本会**持久化进会话历史**（历史回放无需再次调用视觉 API）。
- 视觉调用计入 turn 时长：识别期间 turn 处于 running 状态，UI 会显示进行中。
- 本插件不依赖任何客户端改动：浏览器侧粘贴/上传图片的既有流程原样工作。
