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

### 从 GitHub 克隆（推荐）

```sh
git clone https://github.com/HarwikLGG/dsh-vision-bridge.git ~/vision-bridge
cd ~/vision-bridge
bash install.sh          # 默认装入 web profile；其他 profile：bash install.sh headless
```

### 一键安装脚本

`install.sh` 会自动完成：检查 dsh → 准备 pnpm（无 pnpm 时用 corepack 包装）→
`dsh plugin --profile <name> add <插件目录>` 安装并登记 bundle →
链接运行时依赖（把 profile 的 hoisted node_modules 链接到插件目录）。

### 或手动安装

```sh
dsh plugin --profile web add /绝对路径/vision-bridge
# 并把 profile 的 node_modules 链接到插件目录（运行时依赖解析需要）：
ln -sfn ~/.dsh/profiles/web/node_modules /绝对路径/vision-bridge/node_modules
```

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
| `visionMaxDimension` | `4096` | 缩小后的长边像素（sips 缩放，保持宽高比，输出 JPEG） |
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

## 卸载

```sh
dsh plugin --profile web remove dsh-vision-bridge
```

## 说明与限制

- 一张图一次视觉请求（兼容性最好）；同一消息多张图会按顺序逐张识别，标签带文件名或序号。
- 转换发生在 `agent/pre-step` 瀑布，替换后的文本会**持久化进会话历史**（历史回放无需再次调用视觉 API）。
- 视觉调用计入 turn 时长：识别期间 turn 处于 running 状态，UI 会显示进行中。
- 本插件不依赖任何客户端改动：浏览器侧粘贴/上传图片的既有流程原样工作。
