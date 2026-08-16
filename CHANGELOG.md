# 更新日志（Changelog）

本项目的版本变更记录。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.1] - 2026-08-16

### 修复

**工具结果图片触发 `UNSUPPORTED_CONTENT`（`read_image` 读截图路径）—— 本次核心修复**

- **根因**：`agent/pre-step` 只看到新领取的 prompt 批次，而 dsh 组装请求时用的是
  整个会话历史（`session.deriveMessages()`）。`read_image` 等工具返回的 `image`
  内容块写入会话历史后，会在下一步请求中**直达 DeepSeek 适配器**，触发
  `The DeepSeek chat-completions adapter does not support image content.`；
  且图片永久留在历史里，会话后续每一步请求都报同样的错（会话卡死）。
- **修复 1 — `tools/post-execute` 拦截**：工具结果在**落库之前**把 `image` 块
  替换为视觉模型生成的文本描述。描述随会话持久化，同一张图只识别一次，
  之后每一步请求都是纯文本。
- **修复 2 — `llm.stream` / `llm.prepareCall` 请求级兜底**：旧会话历史里已经
  持久化的图片（插件安装前产生的）不经过任何事件拦截点，这里在请求到达
  适配器之前**现场转文本**；按附件哈希（`attachmentId`）缓存，每进程每图
  只识别一次，已卡死的旧会话恢复后可直接继续使用。
- **附带改进**：
  - 主模型原生支持图片时（pi-ai 等 `inputModalities` 含 `image` 的路由），
    两个新拦截点自动**原样放行**图片，桥接自动休眠；切回 DeepSeek 自动恢复。
  - `callVision` 支持无 `signal` 调用（`AbortSignal.any` 空数组守卫），
    适配器兜底路径在无取消信号时不再报错。

### 新增

- `test/e2e-read-image.mjs`：`read_image` 工具路径端到端验证脚本
  （真实系统验证：工具结果无 image 块、视觉模型正确转录、DeepSeek 正常回答、
  无 UNSUPPORTED_CONTENT）。
- `test/run-test.mjs` 新增用例 10–13：
  - 用例 10：工具结果图片块 → `tools/post-execute` 替换为描述文本；
  - 用例 11：同一张图重复出现只识别一次（描述缓存）；
  - 用例 12：适配器兜底安全网（`llm.stream` / `prepareCall`）请求级转换 + 缓存；
  - 用例 13：原生视觉路由 → 安全网放行，图片原样传递。
  （共 13 项，全部通过）

### 变更

- 图片描述新增**进程内缓存**（LRU，上限 128 条，键 = `attachmentId` + 视觉模型），
  同一张图只调用一次视觉 API。
- 运行日志细化：三个拦截点（`[agent/pre-step]`、`[tools/post-execute]`、
  `[请求兜底]`）分别标注触发的图片数量与视觉模型，视觉识别记录单次耗时。

### 文档

- README 更新：工作流程图改为三个拦截点，补充"为什么需要三个拦截点"的根因
  说明、同图缓存、原生视觉路由自动休眠等说明。
- 新增本 CHANGELOG。

## [0.2.0] - 2026-08-14

### 新增（首个完整版本）

- `agent/pre-step` 拦截 + `ctx.llm.resolveModelInfo` 网关图片准入放行：
  把用户消息中的图片交给指定的 OpenAI 兼容视觉 API 识别，文本描述原位替换
  图片块后转发给 DeepSeek 本体（text-only 适配器）。
- 大图自动缩小（sips → JPEG，防 vLLM 500；后续版本改为 sharp 优先）。
- 文字转录最高优先的识图指令 + 多图序号上下文（"第 N/共 M 张"）。
- 本地端点免 Key（`apiKeyEnv` 留空 = 不带 Authorization 头）。
- 失败行为可配：`failOpen=false` 抛错结束 turn / `true` 占位文本继续。
- 设置页热更新（设置 → 插件 → vision-bridge 卡片，保存即生效）。
- 抗更新设计：dsh 内部 API 运行时动态探测，缺失时优雅降级。
- 一键安装脚本（install.ps1 / install.sh）+ 9 个单元测试。

### 变更

- 大图缩小改为 **sharp 优先**（跨平台、纯内存处理、EXIF 方向矫正），
  macOS 回退系统内置 sips；sharp 加入 optionalDependencies。
- install.ps1：Windows PowerShell 一键安装（corepack 包装 pnpm +
  Junction 链接依赖，无需管理员权限）。
- README 增加 Windows / Linux+macOS 详细安装章节、大图缩小后端对照表、
  第三方视觉模型设置指南（GUI 卡片 / 环境变量 / 配置文件三种方式 +
  8 个平台配置速查）。

## [0.1.0] - 2026-08-14

### 新增

- 项目初始化：识图桥接插件骨架（Initial commit）。
