/**
* dsh-vision-bridge — 识图桥接插件（自动适配版）。
*
* 背景：DeepSeek 官方 chat-completions 适配器是纯文本路由，消息里出现图片
* 块会直接以 `UNSUPPORTED_CONTENT` 拒绝。本插件在三个位置拦截图片内容块，
* 把它们交给用户指定的 OpenAI 兼容视觉 API（chat/completions +
* image_url data URL）识别，得到文本描述后，用描述文本块原位替换图片块，
* 再交给主模型（DeepSeek）。主模型因此"看得到"图片内容，而适配器只收到文本。
*
* 拦截点（缺一不可）：
* 1. `agent/pre-step` —— 对话框直接粘贴/上传的图片（已领取的 prompt 批次）。
* 2. `tools/post-execute` —— 工具返回的图片（如 `read_image` 读截图）。pre-step
*    只看到新领取的批次，而请求是从整个会话历史（session.deriveMessages()）
*    组装的，工具结果里的图片块会直达适配器触发 UNSUPPORTED_CONTENT；在这里
*    转换并在落库前替换，描述文本随会话持久化，同一张图只识别一次。
* 3. `llm.stream` / `llm.prepareCall` 包装 —— 请求兜底安全网：旧会话历史里
*    已经持久化的图片（插件安装前产生的）不经过上面任何拦截点，这里在请求
*    到达适配器之前现场转文本（按附件哈希缓存，每进程每图只识别一次）。
*
* 抗更新设计（dsh 0.1.x rc 阶段内部 API 可能变化）：
* - 所有 @deepseek-ai/dsh-* 内部 API 一律运行时动态探测（getApi()），
*   缺失/改名时优雅降级而非让 dsh web 崩溃：
*   · dsh-credentials.credentialRef 缺失 → apiKeyEnv 直接当环境变量名用
*     （resolveApiKey 已有 process.env 兜底）
*   · dsh-launch-environment.launchEnvironmentOf 缺失 → 跳过可信环境层
*   · dsh-settings.settingsNamespace / installSettingsSection 缺失 →
*     跳过设置页注册（识图功能本身不受影响）
*   · ctx.attachments.readImage 缺失 → 尝试 attachment.data / attachment.url
*     直接读取（attachment 结构稳定时仍可用）
*   · ctx.llm.resolveModelInfo 缺失 → 跳过图片准入放行（仅影响网关入口检查）
* - apply() 主体包 try/catch：任何初始化异常只记录日志，不让插件把
*   dsh web 进程带崩（插件静默失效 < 整个服务崩溃）。
* - 每次启动输出 API 探测报告（ctx.logger.info），dsh 升级后一眼看出
*   哪个 API 变了、插件降级到了什么模式。
*
* 配置既可写在 profile 的 cordis.patch.yml 行里，也可在
* 设置 → 插件 页面的 vision-bridge 卡片中实时修改（settings 命名空间
* `vision-bridge`），下一次请求即生效，无需重启。
*
* @module dsh-vision-bridge
*/
import z from "@deepseek-ai/schemastery";
import "@deepseek-ai/cordis";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Cordis 插件名，用于 loader 诊断。 */
const name = "vision-bridge";
/** 保证 agents 服务就绪后再注册事件监听；attachments 用于读取图片字节（Cordis 4 要求注入后才能属性访问）。 */
const inject = ["agents", "attachments"];

// ── dsh 内部 API 动态探测层（抗更新）──────────────────────────────────────
// dsh 0.1.x rc 阶段，@deepseek-ai/dsh-* 的导出可能改名/移除/改签名。
// 全部延迟到运行时 import + 校验，缺失时返回 null，调用方降级。
const apiCache = new Map();
async function getApi(pkg, names) {
	const key = `${pkg}:${names.join(",")}`;
	if (apiCache.has(key)) return apiCache.get(key);
	let mod = null;
	try {
		mod = await import(pkg);
	} catch (error) {
		apiCache.set(key, null);
		return null;
	}
	const out = {};
	for (const n of names) out[n] = typeof mod[n] === "function" ? mod[n] : null;
	apiCache.set(key, out);
	return out;
}
function apiLog(ctx, label, found) {
	ctx.logger.info("vision-bridge: API 探测 %s → %s", label, found ? "✓ 存在" : "✗ 缺失(已降级)");
}

/** 凭据引用构造器（异步探测，可能返回 null）。 */
async function credentialRefOf(ctx) {
	const api = await getApi("@deepseek-ai/dsh-credentials", ["credentialRef"]);
	const fn = api && api.credentialRef;
	apiLog(ctx, "dsh-credentials.credentialRef", Boolean(fn));
	return fn;
}
/** 可信环境层读取器（异步探测，可能返回 null）。 */
async function launchEnvironmentOf(ctx) {
	const api = await getApi("@deepseek-ai/dsh-launch-environment", ["launchEnvironmentOf"]);
	const fn = api && api.launchEnvironmentOf;
	apiLog(ctx, "dsh-launch-environment.launchEnvironmentOf", Boolean(fn));
	return fn;
}
/** 设置页注册器（异步探测，可能返回 null）。 */
async function settingsRegistrar(ctx) {
	const api = await getApi("@deepseek-ai/dsh-settings", ["settingsNamespace", "installSettingsSection"]);
	const ok = api && api.settingsNamespace && api.installSettingsSection;
	apiLog(ctx, "dsh-settings.settingsNamespace+installSettingsSection", Boolean(ok));
	if (!ok) return null;
	return {
		namespace: api.settingsNamespace("vision-bridge"),
		install: api.installSettingsSection
	};
}

const DEFAULT_API_KEY_ENV = "VISION_API_KEY";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_SYSTEM_PROMPT =
	"你是一个专业的图片描述助手，为无法直接查看图片的文本模型提供准确、详尽、结构化的图片描述。" +
	"当图片中包含任何文字（海报、截图、界面、代码、报错、水印、艺术字等）时，逐字完整转录文字是你最重要的任务，优先级高于对画面风格的描述。";
const DEFAULT_PROMPT =
	"请用中文详细描述这张图片：\n" +
	"1. 【文字转录·最高优先】完整逐字转录图片中出现的所有文字，包括标题、正文、小字、水印、艺术字，按从上到下、从左到右的顺序，不得省略、概括或改写；看不清的文字请标注[看不清]并描述其位置。\n" +
	"2. 画面主体、场景、人物/物体及其布局。\n" +
	"3. 颜色、风格等视觉特征（在完成文字转录后简要补充）。\n" +
	"如果图片内容不清晰或无法识别，请如实说明。";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MiB
/** 超过此像素数的图片先缩小再发送（vLLM/LM Studio 对大图会 500）。 */
const DEFAULT_MAX_VISION_PIXELS = 16 * 1024 * 1024; // 16.7M ≈ 4096×4096
/** 缩小后的长边像素。 */
const DEFAULT_VISION_MAX_DIMENSION = 4096;

/** Schemastery 校验 schema；默认值同时是设置页面的字段默认值。 */
const Config = z.object({
	/** 软开关；为 false 时本插件完全放行（不调用视觉 API）。 */
	enabled: z.boolean().default(true),
	/** 视觉 API Key 的凭据引用（环境变量名，或凭据服务里存的名字）；留空 = 本地端点无需 Key。 */
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	/** OpenAI 兼容端点根地址，如 https://open.bigmodel.cn/api/paas/v4 。 */
	baseURL: z.string().default(DEFAULT_BASE_URL),
	/** 用户指定的视觉模型 id，如 gpt-4o、glm-4v-plus、qwen-vl-max。 */
	model: z.string().default(DEFAULT_MODEL),
	/** 发给视觉模型的系统提示词。 */
	systemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT),
	/** 发给视觉模型的识图指令（随图片一起发送）。 */
	prompt: z.string().default(DEFAULT_PROMPT),
	/** 视觉模型回复的最大 token 数。 */
	maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
	/** 单次视觉请求超时（毫秒）。 */
	timeoutMs: z.number().min(1000).default(DEFAULT_TIMEOUT_MS),
	/** 超过该字节数的图片跳过识别（用占位文本说明）。 */
	maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
	/** 像素数超过此值的图片先缩小（长边 visionMaxDimension）再发送，避免视觉服务端拒绝大图。 */
	maxVisionPixels: z.number().step(1).min(1).default(DEFAULT_MAX_VISION_PIXELS),
	/** 缩小后的长边像素（sips 缩放，保持宽高比）。 */
	visionMaxDimension: z.number().step(1).min(1).default(DEFAULT_VISION_MAX_DIMENSION),
	/**
	* 视觉调用失败时的行为：false（默认）→ 抛出错误结束当前 turn，用户能看到
	* 明确的失败原因；true → 用 `[图片识别失败...]` 占位文本继续，不中断对话。
	*/
	failOpen: z.boolean().default(false),
});

/** 已解析、校验的连接事实（来自组合配置或设置快照）。 */
function resolveOptions(config) {
	if (config.timeoutMs !== void 0 && (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1000)) {
		throw new TypeError(`vision-bridge: timeoutMs 必须是不小于 1000 的数字，got ${String(config.timeoutMs)}`);
	}
	if (config.maxTokens !== void 0 && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens < 1)) {
		throw new TypeError(`vision-bridge: maxTokens 必须是正整数，got ${String(config.maxTokens)}`);
	}
	if (config.maxImageBytes !== void 0 && (!Number.isSafeInteger(config.maxImageBytes) || config.maxImageBytes < 1)) {
		throw new TypeError(`vision-bridge: maxImageBytes 必须是正整数，got ${String(config.maxImageBytes)}`);
	}
	if (config.maxVisionPixels !== void 0 && (!Number.isSafeInteger(config.maxVisionPixels) || config.maxVisionPixels < 1)) {
		throw new TypeError(`vision-bridge: maxVisionPixels 必须是正整数，got ${String(config.maxVisionPixels)}`);
	}
	if (config.visionMaxDimension !== void 0 && (!Number.isSafeInteger(config.visionMaxDimension) || config.visionMaxDimension < 1)) {
		throw new TypeError(`vision-bridge: visionMaxDimension 必须是正整数，got ${String(config.visionMaxDimension)}`);
	}
	if (config.model === void 0 || config.model.length === 0) {
		throw new Error('vision-bridge: 未配置视觉模型 model（请在设置 → 插件 → vision-bridge 中填写，如 "gpt-4o-mini"）');
	}
	return {
		enabled: config.enabled !== false,
		// apiKeyEnv 为空字符串 = 本地端点（LM Studio / Ollama 等）不需要 API Key
		apiKeyEnv: (config.apiKeyEnv ?? "") === "" ? null : config.apiKeyEnv,
		baseURL: config.baseURL ?? DEFAULT_BASE_URL,
		model: config.model,
		systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
		prompt: config.prompt ?? DEFAULT_PROMPT,
		maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
		timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		maxImageBytes: config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
		maxVisionPixels: config.maxVisionPixels ?? DEFAULT_MAX_VISION_PIXELS,
		visionMaxDimension: config.visionMaxDimension ?? DEFAULT_VISION_MAX_DIMENSION,
		failOpen: config.failOpen === true
	};
}

/** 把端点归一化为完整的 /chat/completions URL。 */
function chatCompletionsURL(baseURL) {
	let base = baseURL.trim();
	while (base.endsWith("/")) base = base.slice(0, -1);
	if (/\/chat\/completions$/i.test(base)) return base;
	return `${base}/chat/completions`;
}

function formatBytes(bytes) {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
	return `${bytes} B`;
}

/**
* 解析视觉 API Key：apiKeyEnv 为 null（本地端点）直接返回 null，请求不带
* Authorization 头；否则先问凭据服务，再问可信环境层，最后退回 process.env。
* credentialRef / launchEnvironmentOf 构造器由调用方注入（探测结果），
* 缺失时 apiKeyEnv 直接当环境变量名 / 跳过可信环境层。
*/
async function resolveApiKey(ctx, credentialRefFn, launchEnvOfFn, apiKeyEnv) {
	if (apiKeyEnv === null) return null;
	const ref = credentialRefFn !== null ? credentialRefFn(apiKeyEnv) : apiKeyEnv;
	const credentials = ctx.get("credentials");
	if (credentials !== void 0) {
		const hit = await credentials.resolve(ref);
		if (hit !== void 0 && hit.value.length > 0) return hit.value;
	}
	if (launchEnvOfFn !== null) {
		try {
			const ambient = launchEnvOfFn(ctx).get(ref);
			if (ambient !== void 0 && ambient.value.length > 0) return ambient.value;
		} catch (error) {
			// 可信环境层实现变化时忽略，继续走 env 兜底
		}
	}
	if (process.env[apiKeyEnv] !== void 0 && process.env[apiKeyEnv].length > 0) return process.env[apiKeyEnv];
	throw new Error(
		`vision-bridge: 未找到视觉 API Key（${apiKeyEnv}）。请在 设置 → 插件 → vision-bridge 中填写 apiKeyEnv 对应的 Key，或在启动环境中导出 ${apiKeyEnv}。`
	);
}

/** 从 OpenAI 兼容响应里抽取文本内容（兼容 string 与分段数组两种形态）。 */
function extractContentText(content) {
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.map((part) => (part !== null && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
			.join("")
			.trim();
	}
	return "";
}

/**
* 调用一次视觉模型（一张图片一个请求，兼容性最好）。
* @param index - 本条消息中第几张图片（1 起）；total - 本条消息图片总数。
* @returns 描述文本（已 trim，非空）。
*/
async function callVision(ctx, credentialRefFn, launchEnvOfFn, options, attachment, data, signal, index, total) {
	const apiKey = await resolveApiKey(ctx, credentialRefFn, launchEnvOfFn, options.apiKeyEnv);
	const base64 = Buffer.from(data).toString("base64");
	const content = [
		{ type: "text", text: options.prompt },
		...(total !== void 0 && total > 1
			? [{ type: "text", text: `[这是第 ${index}/${total} 张图片，请仅描述这一张。]` }]
			: []),
		{ type: "image_url", image_url: { url: `data:${attachment.mediaType};base64,${base64}` } }
	];
	const body = {
		model: options.model,
		messages: [
			{ role: "system", content: options.systemPrompt },
			{ role: "user", content }
		],
		max_tokens: options.maxTokens,
		stream: false
	};
	const effectiveSignal = AbortSignal.any([...(signal === void 0 ? [] : [signal]), AbortSignal.timeout(options.timeoutMs)]);
	let response;
	const headers = { "content-type": "application/json" };
	if (apiKey !== null) headers.authorization = `Bearer ${apiKey}`;
	try {
		response = await fetch(chatCompletionsURL(options.baseURL), {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: effectiveSignal
		});
	} catch (error) {
		if (effectiveSignal.aborted) {
			const cause = effectiveSignal.reason;
			const why = cause instanceof Error ? cause.message : String(cause);
			throw new Error(`vision-bridge: 视觉请求失败（${options.timeoutMs}ms 超时或已取消）: ${why}`);
		}
		throw new Error(`vision-bridge: 视觉请求网络错误: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) {
		const snippet = await response.text().catch(() => "");
		const hint =
			response.status === 401 || response.status === 403
				? "（请检查 API Key 是否正确、是否有该模型的访问权限）"
				: response.status === 429
					? "（触发了限流，请稍后重试）"
					: "";
		throw new Error(
			`vision-bridge: 视觉模型 API 返回 HTTP ${response.status}${hint}${snippet ? `：${snippet.slice(0, 300)}` : ""}`
		);
	}
	const payload = await response.json().catch(() => null);
	const text = extractContentText(payload?.choices?.[0]?.message?.content);
	if (text.length === 0) {
		throw new Error(`vision-bridge: 视觉模型（${options.model}）返回了空描述`);
	}
	return text;
}

/**
* 读取图片字节。优先 ctx.attachments.readImage；缺失时降级尝试
* attachment.data（Buffer/Uint8Array/ArrayBuffer）与 attachment.url。
*/
async function readImageBytes(ctx, attachment, signal) {
	const attachments = ctx.attachments;
	if (attachments !== void 0 && typeof attachments.readImage === "function") {
		return await attachments.readImage(attachment, signal);
	}
	if (attachment.data !== void 0) {
		const d = attachment.data;
		if (Buffer.isBuffer(d)) return { data: d };
		if (d instanceof Uint8Array) return { data: Buffer.from(d) };
		if (d instanceof ArrayBuffer) return { data: Buffer.from(d) };
		if (typeof d === "string") return { data: Buffer.from(d, "base64") };
	}
	throw new Error("vision-bridge: 当前 dsh 版本不提供 attachments.readImage 且 attachment 无内联 data，无法读取图片字节");
}

/** sharp 模块探测缓存（跨平台缩放首选；缺失时回退 sips）。 */
let sharpModule = null;
let sharpProbed = false;
async function loadSharp() {
	if (!sharpProbed) {
		sharpProbed = true;
		try {
			const mod = await import("sharp");
			sharpModule = mod.default ?? mod;
		} catch {
			sharpModule = null;
		}
	}
	return sharpModule;
}

/**
* 用 macOS 内置 sips 把图片缩放到长边不超过 maxDimension（保持宽高比），
* 输出 JPEG。返回 { data, mediaType }；sips 不可用/失败时返回 null。
* 仅 macOS 有 sips；Windows/Linux 走 sharp。
*/
function downscaleWithSips(data, maxDimension) {
	let dir = null;
	try {
		dir = mkdtempSync(join(tmpdir(), "vision-bridge-"));
		const input = join(dir, "input");
		const output = join(dir, "output.jpg");
		writeFileSync(input, data);
		const result = spawnSync(
			"sips",
			["-Z", String(maxDimension), "-s", "format", "jpeg", "-s", "formatOptions", "85", input, "--out", output],
			{ encoding: "utf8" }
		);
		if (result.status !== 0) {
			throw new Error(result.stderr || `sips exit ${String(result.status)}`);
		}
		return { data: readFileSync(output), mediaType: "image/jpeg" };
	} catch (error) {
		return null;
	} finally {
		if (dir !== null) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// 清理失败可忽略
			}
		}
	}
}

/**
* 跨平台大图缩小：优先 sharp（Windows/Linux/macOS 通用，纯内存处理），
* 失败时回退 macOS 内置 sips。返回 { data, mediaType } 或 null（无法缩小）。
*/
async function downscaleImage(data, maxDimension) {
	// 1) sharp：跨平台首选
	const sharp = await loadSharp();
	if (sharp !== null) {
		try {
			const out = await sharp(data)
				.rotate() // 按 EXIF 方向摆正（手机照片）
				.resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
				.jpeg({ quality: 85 })
				.toBuffer();
			return { data: out, mediaType: "image/jpeg" };
		} catch (error) {
			// sharp 处理失败 → 回退 sips
		}
	}
	// 2) sips：macOS 原生兜底
	return downscaleWithSips(data, maxDimension);
}

/**
* 描述缓存：同一 (attachmentId, 视觉模型) 每进程只调用一次视觉 API。
* 转换后的描述文本会随会话历史持久化，缓存只服务于兜底路径（旧会话
* 历史里的图片会在每次请求时重新出现）与同一张图被多次读取的场景。
* LRU：超过上限时淘汰最早插入的条目。
*/
const descriptionCache = new Map();
const DESCRIPTION_CACHE_LIMIT = 128;
function cachedDescribe(key, produce) {
	const hit = descriptionCache.get(key);
	if (hit !== void 0) return hit;
	const entry = Promise.resolve()
		.then(produce)
		.catch((error) => {
			descriptionCache.delete(key);
			throw error;
		});
	descriptionCache.set(key, entry);
	if (descriptionCache.size > DESCRIPTION_CACHE_LIMIT) {
		const oldest = descriptionCache.keys().next().value;
		if (oldest !== void 0) descriptionCache.delete(oldest);
	}
	return entry;
}

/** 单张图片的实际识别（未缓存，含失败占位逻辑）。 */
async function describeAttachment(ctx, credentialRefFn, launchEnvOfFn, options, attachment, signal, index, total) {
	const label = attachment.name !== void 0 && attachment.name.length > 0 ? attachment.name : `图片 #${index}`;
	let stored;
	try {
		stored = await readImageBytes(ctx, attachment, signal);
	} catch (error) {
		if (options.failOpen) {
			return `[${label}：读取图片字节失败（${error instanceof Error ? error.message : String(error)}），已跳过识别]`;
		}
		throw new Error(
			`vision-bridge: 读取图片（${label}）失败: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (stored.data.byteLength > options.maxImageBytes) {
		return `[${label}：文件大小 ${formatBytes(stored.data.byteLength)} 超过上限 ${formatBytes(options.maxImageBytes)}，未发送给视觉模型]`;
	}
	// 大图先缩小：vLLM/LM Studio 对超大像素图（如 7952×5304）会直接 500
	let sendAttachment = attachment;
	let sendData = stored.data;
	const pixels = attachment.width * attachment.height;
	if (pixels > options.maxVisionPixels) {
		const scaled = await downscaleImage(sendData, options.visionMaxDimension);
		if (scaled !== null) {
			sendAttachment = { ...attachment, mediaType: scaled.mediaType };
			sendData = scaled.data;
			ctx.logger.info(
				"vision-bridge: 图片 %s 像素 %d 超过上限，已缩小到长边 %d（%s → %s）",
				label,
				pixels,
				options.visionMaxDimension,
				formatBytes(stored.data.byteLength),
				formatBytes(sendData.byteLength)
			);
		} else {
			ctx.logger.warn(
				"vision-bridge: 图片 %s 像素 %d 超过上限且缩小失败（sharp/sips 均不可用），按原图发送，视觉服务端可能拒绝",
				label,
				pixels
			);
		}
	}
	let description;
	const visionStartedAt = Date.now();
	try {
		description = await callVision(
			ctx,
			credentialRefFn,
			launchEnvOfFn,
			options,
			sendAttachment,
			sendData,
			signal,
			index,
			total
		);
		ctx.logger.info("vision-bridge: 视觉识别完成（模型 %s，耗时 %.1fs）", options.model, (Date.now() - visionStartedAt) / 1000);
	} catch (error) {
		if (options.failOpen) {
			return `[${label}：视觉识别失败（${error instanceof Error ? error.message : String(error)}），已跳过]`;
		}
		throw error;
	}
	return `[${label} 的内容描述（由视觉模型 ${options.model} 生成）]\n${description}`;
}

/**
* 单张图片的描述文本（带缓存）。缓存键 = 附件 id + 视觉模型 id；
* 无 attachmentId 的图片（极端形状）不缓存，直接识别。
*/
function describeOne(ctx, credentialRefFn, launchEnvOfFn, options, attachment, signal, index, total) {
	if (attachment.attachmentId === void 0) {
		return describeAttachment(ctx, credentialRefFn, launchEnvOfFn, options, attachment, signal, index, total);
	}
	const key = `${attachment.attachmentId}:${options.model}`;
	return cachedDescribe(key, () =>
		describeAttachment(ctx, credentialRefFn, launchEnvOfFn, options, attachment, signal, index, total)
	);
}

/** 统计内容块中的图片总数（含 tool-result 嵌套）。 */
function countImages(content) {
	let count = 0;
	for (const block of content) {
		if (block.type === "image") count += 1;
		else if (block.type === "tool-result") count += countImages(block.content);
	}
	return count;
}

/**
* 递归转换内容块：image 块 → 描述文本块；tool-result 块递归其内部 content；
* 其余块原样保留。返回 null 表示没有图片（无需重建消息）。
*/
async function transformContent(ctx, credentialRefFn, launchEnvOfFn, options, content, signal, state) {
	if (state.total === void 0) state.total = countImages(content);
	let out = null;
	for (let index = 0; index < content.length; index += 1) {
		const block = content[index];
		if (block.type === "image") {
			state.count += 1;
			const text = await describeOne(
				ctx,
				credentialRefFn,
				launchEnvOfFn,
				options,
				block.attachment,
				signal,
				state.count,
				state.total
			);
			if (out === null) out = content.slice(0, index);
			out.push({ type: "text", text });
		} else if (block.type === "tool-result") {
			const inner = await transformContent(ctx, credentialRefFn, launchEnvOfFn, options, block.content, signal, state);
			if (inner !== null) {
				if (out === null) out = content.slice(0, index);
				out.push({ ...block, content: inner });
			} else if (out !== null) {
				out.push(block);
			}
		} else if (out !== null) {
			out.push(block);
		}
	}
	return out;
}

/**
* 把一组请求消息里的图片块全部替换为文本描述（适配器兜底安全网用）。
* 每条消息独立计数（与 pre-step 行为一致）。
* @returns 新消息数组；没有任何图片时原样返回原数组（同一引用）。
*/
async function transformRequestMessages(ctx, credentialRefFn, launchEnvOfFn, options, messages, signal) {
	let out = null;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		const content = await transformContent(ctx, credentialRefFn, launchEnvOfFn, options, message.content, signal, { count: 0 });
		if (content === null) {
			if (out !== null) out.push(message);
			continue;
		}
		if (out === null) out = messages.slice(0, index);
		out.push({ ...message, content });
	}
	return out ?? messages;
}

/**
* 注册 `agent/pre-step` 转换器与设置面板。
* 顶层 try/catch：任何异常只记录，不让插件初始化失败拖垮 dsh web。
* @param ctx - 插件上下文；监听器随 ctx 卸载。
* @param config - 组合配置（行默认值 + 用户覆盖）。
*/
function apply(ctx, config) {
	try {
		let current = () => config;
		let lastRaw;
		let lastGood;
		/** 每次事件重新解析配置（设置页改动即时生效），校验失败保留上一份。 */
		const options = () => {
			const raw = current();
			if (raw === lastRaw && lastGood !== void 0) return lastGood;
			try {
				const next = resolveOptions(raw);
				lastRaw = raw;
				lastGood = next;
				return next;
			} catch (error) {
				if (lastGood === void 0) throw error;
				lastRaw = raw;
				ctx.logger.error("vision-bridge: 设置快照无效，继续使用上一份有效配置");
				ctx.logger.error(error);
				return lastGood;
			}
		};
		options();

		// ── API 探测（异步，结果缓存到模块级；探测失败只降级不崩溃）─────────
		let credentialRefFn = null;
		let launchEnvOfFn = null;
		void Promise.allSettled([credentialRefOf(ctx), launchEnvironmentOf(ctx), settingsRegistrar(ctx)]).then(
			([cr, le, sr]) => {
				credentialRefFn = cr.status === "fulfilled" ? cr.value : null;
				launchEnvOfFn = le.status === "fulfilled" ? le.value : null;
				if (sr.status === "fulfilled" && sr.value !== null) {
					sr.value.install(ctx, sr.value.namespace, Config, config, {
						setSource: (source) => {
							current = source;
						},
						onChange: () => {}
					});
					ctx.logger.info("vision-bridge: 设置页已注册（vision-bridge 卡片）");
				} else {
					ctx.logger.warn("vision-bridge: 设置页注册不可用（dsh-settings API 缺失），配置仅在 patch 层生效");
				}
			}
		);

		// ── 网关图片准入放行 ──────────────────────────────────────────────────
		// session.prompt 在网关层检查所选模型的 inputModalities，DeepSeek 声明为
		// ["text"]，带图消息会被 MODEL_DOES_NOT_SUPPORT_IMAGES 直接拒绝，根本到
		// 不了 pre-step。这里包装 ctx.llm.resolveModelInfo，把 "image" 加入
		// inputModalities 让图片进入消息管线；随后各拦截点转换保证真正发给
		// 适配器的内容里已经没有图片块（adapter 的 contentHasImage 检查不会触发），
		// 所以这个放行是无害的"能力声明"。
		const llm = ctx.get("llm");
		const origResolveModelInfo = llm !== void 0 && typeof llm.resolveModelInfo === "function" ? llm.resolveModelInfo.bind(llm) : null;
		if (origResolveModelInfo !== null) {
			llm.resolveModelInfo = async (provider, model, signal) => {
				const info = await origResolveModelInfo(provider, model, signal);
				if (info.inputModalities !== void 0 && !info.inputModalities.includes("image")) {
					return { ...info, inputModalities: [...info.inputModalities, "image"] };
				}
				return info;
			};
			ctx.logger.info("vision-bridge: 已放行图片准入（resolveModelInfo 包装），图片将交给视觉模型转文本");
		} else {
			ctx.logger.warn("vision-bridge: ctx.llm.resolveModelInfo 不可用，跳过图片准入放行（图片可能被网关拒绝）");
		}
		/**
		* 主模型是否原生接受图片（用未包装的 resolveModelInfo 判断，避免自己
		* 的准入包装造成误判）。DeepSeek 为 false → 需要桥接转文本；将来切到
		* pi-ai 等原生视觉模型时返回 true → 图片原样放行，桥接自动休眠。
		*/
		const routeAcceptsImages = async (provider, model, signal) => {
			if (origResolveModelInfo === null || provider === void 0 || model === void 0) return false;
			try {
				const info = await origResolveModelInfo(provider, model, signal);
				return info.inputModalities !== void 0 && info.inputModalities.includes("image");
			} catch {
				return false;
			}
		};

		// ── 工具结果图片转换（read_image 等工具返回的 image 块）────────────────
		// agent/pre-step 只看到新领取的 prompt 批次，而请求是从整个会话历史
		// （session.deriveMessages()）组装的——工具结果里的图片块不在 pre-step
		// 视野内，会直接进入下一次请求触发适配器 UNSUPPORTED_CONTENT。这里在
		// 工具结果落库之前把图片换成文本描述，描述随会话持久化，同一张图只
		// 识别一次，且后续每一步请求都是纯文本。
		ctx.on("tools/post-execute", async (exec, result, next) => {
			const decision = await next();
			if (decision.kind !== "accept") return decision;
			if (result?.isError === true) return decision;
			const resolved = options();
			if (!resolved.enabled) return decision;
			const content = decision.content !== void 0 ? decision.content : result?.content;
			if (!Array.isArray(content) || countImages(content) === 0) return decision;
			const routed = exec.agent?.session?.requestHeader?.()?.config;
			if (routed !== void 0 && await routeAcceptsImages(routed.provider, routed.model, exec.signal)) return decision;
			const state = { count: 0 };
			const transformed = await transformContent(ctx, credentialRefFn, launchEnvOfFn, resolved, content, exec.signal, state);
			if (transformed === null) return decision;
			ctx.logger.info("vision-bridge: [tools/post-execute] 工具 %s 的结果含 %d 张图片，已替换为视觉模型（%s）的文本描述", exec.name, state.count, resolved.model);
			return {
				kind: "accept",
				content: transformed,
				...decision.additionalContexts !== void 0 ? { additionalContexts: decision.additionalContexts } : {}
			};
		});

		// ── 适配器兜底安全网：请求级转换 ───────────────────────────────────────
		// 旧会话历史里已持久化的图片（插件安装前产生的、或转换失败留下的）
		// 不经过上面任何拦截点，会在每次请求时直达适配器。这里包装
		// llm.stream / llm.prepareCall（agent loop 的所有请求都经过 prepareCall
		// 的 stream），请求消息里只要还有图片就现场转文本；同一张图按附件
		// 哈希缓存，每进程只识别一次，之后每次请求都是缓存命中。
		const wrapStream = (request, original) => {
			if (request === null || typeof request !== "object" || !Array.isArray(request.messages)) return original(request);
			return (async function* () {
				if (!request.messages.some((message) => countImages(message.content) > 0)) {
					yield* original(request);
					return;
				}
				const resolved = options();
				if (!resolved.enabled) {
					yield* original(request);
					return;
				}
				if (await routeAcceptsImages(request.provider, request.model, request.signal)) {
					yield* original(request);
					return;
				}
				const signal = request.signal ?? new AbortController().signal;
				const legacyImages = request.messages.reduce((n, message) => n + countImages(message.content), 0);
				const messages = await transformRequestMessages(ctx, credentialRefFn, launchEnvOfFn, resolved, request.messages, signal);
				ctx.logger.info("vision-bridge: [请求兜底] 请求含 %d 张历史图片，已现场转文本（视觉模型 %s）", legacyImages, resolved.model);
				yield* original(messages === request.messages ? request : { ...request, messages });
			})();
		};
		if (llm !== void 0) {
			if (typeof llm.stream === "function") {
				const stream = llm.stream.bind(llm);
				llm.stream = (request) => wrapStream(request, stream);
				ctx.logger.info("vision-bridge: 已包装 llm.stream（请求级图片兜底转换）");
			}
			if (typeof llm.prepareCall === "function") {
				const prepareCall = llm.prepareCall.bind(llm);
				llm.prepareCall = async (config, signal) => {
					const prepared = await prepareCall(config, signal);
					if (prepared === null || typeof prepared !== "object" || typeof prepared.stream !== "function") return prepared;
					const preparedStream = prepared.stream.bind(prepared);
					return {
						...prepared,
						stream: (request) => wrapStream(request, preparedStream)
					};
				};
				ctx.logger.info("vision-bridge: 已包装 llm.prepareCall（请求级图片兜底转换）");
			}
		}

		ctx.on(
			"agent/pre-step",
			async ({ signal }, next) => {
				const resolved = options();
				if (!resolved.enabled) return next();
				const decision = await next();
				if (decision.kind === "reject" || signal.aborted) return decision;
				let changed = false;
				let replacedMessages = 0;
				let replacedImages = 0;
				let messages = decision.messages;
				for (let index = 0; index < messages.length; index += 1) {
					const message = messages[index];
					if (message.role !== "user") continue;
					const state = { count: 0 };
					const content = await transformContent(ctx, credentialRefFn, launchEnvOfFn, resolved, message.content, signal, state);
					if (content === null) continue;
					replacedMessages += 1;
					replacedImages += state.count;
					if (!changed) {
						messages = messages.slice();
						changed = true;
					}
					messages[index] = { ...message, content };
				}
				if (!changed) return decision;
				ctx.logger.info("vision-bridge: [agent/pre-step] 已将 %d 条消息中的 %d 张图片替换为视觉模型（%s）的文本描述", replacedMessages, replacedImages, resolved.model);
				return { kind: "enter", messages };
			}
		);
	} catch (error) {
		ctx.logger.error("vision-bridge: 插件初始化失败（已降级为不处理图片）: %s", error instanceof Error ? error.stack : String(error));
	}
}

export { Config, apply, inject, name };
