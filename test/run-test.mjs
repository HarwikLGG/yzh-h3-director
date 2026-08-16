/**
* dsh-vision-bridge 单元验证：用本地 mock 视觉 API 走一遍完整转换链路。
* 运行：node test/run-test.mjs
*/
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";
import { apply } from "../lib/index.js";

// ── 最小 PNG 编码器（用于生成"大图"测试 sips 缩小链路）──────────────────────
function crc32(buf) {
	let c = ~0;
	for (let i = 0; i < buf.length; i++) {
		c ^= buf[i];
		for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return (~c) >>> 0;
}
function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const typeBuf = Buffer.from(type, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
	return Buffer.concat([len, typeBuf, data, crc]);
}
function makePng(width, height, paint) {
	const raw = Buffer.alloc(height * (1 + width * 4));
	for (let y = 0; y < height; y++) {
		raw[y * (1 + width * 4)] = 0;
		for (let x = 0; x < width; x++) {
			const [r, g, b, a = 255] = paint(x, y);
			const o = y * (1 + width * 4) + 1 + x * 4;
			raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; ihdr[9] = 6;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0))
	]);
}

const received = [];
let failNext = false;

const server = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		const parsed = JSON.parse(body);
		const content = parsed.messages?.[1]?.content ?? [];
		const imagePart = content.find((p) => p.type === "image_url");
		const imageUrl = imagePart?.image_url?.url ?? "";
		received.push({ auth: req.headers.authorization ?? "", model: parsed.model, imageUrl, content });
		res.writeHead(failNext ? 500 : 200, { "content-type": "application/json" });
		res.end(
			failNext
				? JSON.stringify({ error: { message: "mock server error" } })
				: JSON.stringify({ choices: [{ message: { content: "这是一张测试图片：蓝色背景上有一个白色圆点。" } }] })
		);
	});
});

function makeCtx(services = {}) {
	const handlers = new Map();
	return {
		handlers,
		get(name) {
			return services[name];
		},
		inject() {},
		on(event, handler) {
			handlers.set(event, handler);
		},
		logger: { info() {}, warn() {}, error() {} },
		attachments: {
			async readImage(ref) {
				return { ref, data: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) };
			}
		}
	};
}

function imageMessage(attachmentId = "a1") {
	return {
		id: "m1",
		role: "user",
		content: [
			{ type: "text", text: "这张图里是什么？" },
			{ type: "image", attachment: { attachmentId, mediaType: "image/png", bytes: 7, width: 4, height: 4, name: "test.png" } }
		],
		source: { kind: "user" }
	};
}

async function runStep(ctx, config, attachmentId) {
	const handler = ctx.handlers.get("agent/pre-step");
	const message = imageMessage(attachmentId);
	const decision = await handler({ agent: {}, signal: new AbortController().signal, messages: [message] }, () =>
		Promise.resolve({ kind: "enter", messages: [message] })
	);
	return decision;
}

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const baseURL = `http://127.0.0.1:${port}`;

try {
	process.env.VISION_API_KEY = "test-key-123";

	// ── 用例 1：正常识别，图片块被描述文本原位替换 ────────────────────────────
	const ctx1 = makeCtx();
	apply(ctx1, { enabled: true, baseURL, model: "mock-vl", apiKeyEnv: "VISION_API_KEY", failOpen: false });
	const decision = await runStep(ctx1, {});
	assert.equal(decision.kind, "enter");
	assert.equal(decision.messages.length, 1);
	const content = decision.messages[0].content;
	assert.equal(content.length, 2, "文本块保留 + 描述块替换图片块");
	assert.equal(content[0].text, "这张图里是什么？");
	assert.equal(content[1].type, "text");
	assert.ok(content[1].text.includes("这是一张测试图片"), "描述内容已注入");
	assert.ok(content[1].text.includes("test.png"), "保留图片文件名");
	assert.ok(content[1].text.includes("mock-vl"), "标注视觉模型");
	assert.equal(received.length, 1, "恰好一次视觉请求");
	assert.equal(received[0].model, "mock-vl");
	assert.equal(received[0].auth, "Bearer test-key-123");
	assert.ok(received[0].imageUrl.startsWith("data:image/png;base64,"), "data URL 正确");
	console.log("✅ 用例 1：正常识图 → 描述文本原位替换，请求格式正确");

	// ── 用例 2：failOpen=false 时 API 失败抛错结束 turn ──────────────────────
	const ctx2 = makeCtx();
	apply(ctx2, { enabled: true, baseURL, model: "mock-vl", apiKeyEnv: "VISION_API_KEY", failOpen: false });
	failNext = true;
	await assert.rejects(() => runStep(ctx2, {}, "a2"), /HTTP 500/);
	failNext = false;
	console.log("✅ 用例 2：failOpen=false 时视觉失败 → 抛错（结束当前 turn）");

	// ── 用例 3：failOpen=true 时失败降级为占位文本 ────────────────────────────
	const ctx3 = makeCtx();
	apply(ctx3, { enabled: true, baseURL, model: "mock-vl", apiKeyEnv: "VISION_API_KEY", failOpen: true });
	failNext = true;
	const degraded = await runStep(ctx3, {}, "a3");
	failNext = false;
	const text = degraded.messages[0].content[1].text;
	assert.ok(text.startsWith("[test.png：视觉识别失败"), `占位文本：${text}`);
	console.log("✅ 用例 3：failOpen=true 时失败 → 占位文本继续对话");

	// ── 用例 4：超过 maxImageBytes 的图片跳过识别 ──────────────────────────────
	const ctx4 = makeCtx();
	apply(ctx4, { enabled: true, baseURL, model: "mock-vl", apiKeyEnv: "VISION_API_KEY", failOpen: true, maxImageBytes: 4 });
	const oversized = await runStep(ctx4, {}, "a4");
	const skipText = oversized.messages[0].content[1].text;
	assert.ok(skipText.includes("超过上限"), `跳过文本：${skipText}`);
	console.log("✅ 用例 4：超限图片 → 占位说明，不调用视觉 API");

	// ── 用例 5：enabled=false 完全放行 ────────────────────────────────────────
	const ctx5 = makeCtx();
	apply(ctx5, { enabled: false, baseURL, model: "mock-vl", apiKeyEnv: "VISION_API_KEY" });
	const before = received.length;
	const passthrough = await runStep(ctx5, {}, "a5");
	assert.equal(passthrough.messages[0].content[1].type, "image", "图片块原样保留");
	assert.equal(received.length, before, "没有发起视觉请求");
	console.log("✅ 用例 5：enabled=false 放行，图片块原样保留");

	// ── 用例 6：无图片的消息不动 ───────────────────────────────────────────────
	const ctx6 = makeCtx();
	apply(ctx6, { enabled: true, baseURL, model: "mock-vl", apiKeyEnv: "VISION_API_KEY" });
	const plain = { id: "m2", role: "user", content: [{ type: "text", text: "你好" }], source: { kind: "user" } };
	const handler6 = ctx6.handlers.get("agent/pre-step");
	const decision6 = await handler6({ agent: {}, signal: new AbortController().signal, messages: [plain] }, () =>
		Promise.resolve({ kind: "enter", messages: [plain] })
	);
	assert.equal(decision6.messages[0], plain, "同一消息对象，未重建");
	console.log("✅ 用例 6：无图片消息零改动");

	// ── 用例 7：apiKeyEnv 留空 = 本地端点，请求不带 Authorization 头 ────────────
	const ctx7 = makeCtx();
	apply(ctx7, { enabled: true, baseURL, model: "mock-vl", apiKeyEnv: "" });
	const localDecision = await runStep(ctx7, {}, "a7");
	assert.ok(localDecision.messages[0].content[1].text.includes("这是一张测试图片"));
	const last = received[received.length - 1];
	assert.equal(last.auth, "", "本地端点不发送 Authorization 头");
	console.log("✅ 用例 7：apiKeyEnv 留空 → 请求不带 Authorization 头（LM Studio 场景）");

	// ── 用例 8：大图（超过 maxVisionPixels）自动缩小后发送 ─────────────────────
	const bigPng = makePng(2000, 1500, () => [10, 200, 30]);
	const ctx8 = makeCtx();
	ctx8.attachments.readImage = async (ref) => ({ ref, data: bigPng });
	apply(ctx8, { enabled: true, baseURL, model: "mock-vl", apiKeyEnv: "", maxVisionPixels: 1000000, visionMaxDimension: 800 });
	const bigMessage = {
		id: "m8",
		role: "user",
		content: [
			{ type: "text", text: "这张图里有什么？" },
			{ type: "image", attachment: { attachmentId: "a8", mediaType: "image/png", bytes: bigPng.length, width: 2000, height: 1500, name: "big.png" } }
		],
		source: { kind: "user" }
	};
	const handler8 = ctx8.handlers.get("agent/pre-step");
	const decision8 = await handler8({ agent: {}, signal: new AbortController().signal, messages: [bigMessage] }, () =>
		Promise.resolve({ kind: "enter", messages: [bigMessage] })
	);
	assert.ok(decision8.messages[0].content[1].text.includes("这是一张测试图片"), "缩小后仍成功识图");
	const last8 = received[received.length - 1];
	assert.ok(last8.imageUrl.startsWith("data:image/jpeg;base64,"), `缩小后发送 JPEG（got ${last8.imageUrl.slice(0, 40)}）`);
	const jpegBytes = Buffer.from(last8.imageUrl.split(",")[1], "base64");
	assert.equal(jpegBytes[0], 0xff, "JPEG 魔数 FF");
	assert.equal(jpegBytes[1], 0xd8, "JPEG 魔数 D8");
	console.log("✅ 用例 8：大图自动缩小（sips → JPEG）后发送");

	// ── 用例 9：多图消息携带序号上下文（第 N/共 M 张）────────────────────────
	const ctx9 = makeCtx();
	apply(ctx9, { enabled: true, baseURL, model: "mock-vl", apiKeyEnv: "" });
	const multiMessage = {
		id: "m9",
		role: "user",
		content: [
			{ type: "text", text: "比较这两张图" },
			{ type: "image", attachment: { attachmentId: "a9a", mediaType: "image/png", bytes: 7, width: 4, height: 4, name: "one.png" } },
			{ type: "image", attachment: { attachmentId: "a9b", mediaType: "image/png", bytes: 7, width: 4, height: 4, name: "two.png" } }
		],
		source: { kind: "user" }
	};
	const handler9 = ctx9.handlers.get("agent/pre-step");
	const decision9 = await handler9({ agent: {}, signal: new AbortController().signal, messages: [multiMessage] }, () =>
		Promise.resolve({ kind: "enter", messages: [multiMessage] })
	);
	const reqs = received.slice(-2);
	assert.ok(reqs.length === 2, "两张图两次请求");
	const second = reqs[1];
	const seqText = second.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
	assert.ok(seqText.includes("第 2/2 张"), `第二张请求带序号上下文（got: ${seqText.slice(0, 120)}）`);
	assert.ok(decision9.messages[0].content.length === 3, "两张图都替换为描述文本（1 原文 + 2 描述）");
	console.log("✅ 用例 9：多图消息携带序号上下文（第 N/共 M 张）");

	// ── 用例 10：工具结果里的图片块在 tools/post-execute 被替换为描述 ────────
	// 复现真实故障：read_image 返回 text+image 的工具结果，pre-step 看不到它，
	// 图片会直达 DeepSeek 适配器触发 UNSUPPORTED_CONTENT。这里验证 post-execute
	// 在结果落库前把图片换成文本描述。
	const ctx10 = makeCtx();
	apply(ctx10, { enabled: true, baseURL, model: "mock-vl", apiKeyEnv: "" });
	const postExecute = ctx10.handlers.get("tools/post-execute");
	assert.ok(typeof postExecute === "function", "tools/post-execute 监听器已注册");
	const toolResult = {
		content: [
			{ type: "text", text: "<path>shot.png</path>\n<type>image</type>" },
			{ type: "image", attachment: { attachmentId: "tr10", mediaType: "image/png", bytes: 7, width: 4, height: 4, name: "shot.png" } }
		],
		isError: false
	};
	const exec10 = { name: "read_image", agent: {}, signal: new AbortController().signal };
	const before10 = received.length;
	const decision10 = await postExecute(
		exec10,
		toolResult,
		async () => ({ kind: "accept" })
	);
	assert.equal(decision10.kind, "accept");
	assert.equal(decision10.content.length, 2);
	assert.equal(decision10.content[0].type, "text", "原文本块保留");
	assert.equal(decision10.content[1].type, "text", "图片块被描述文本替换");
	assert.ok(decision10.content[1].text.includes("这是一张测试图片"), "描述内容已注入");
	assert.equal(received.length, before10 + 1, "恰好一次视觉请求");
	console.log("✅ 用例 10：工具结果图片块 → tools/post-execute 替换为描述文本");

	// ── 用例 11：同一张图重复出现只识别一次（描述缓存）────────────────────────
	const ctx11 = makeCtx();
	apply(ctx11, { enabled: true, baseURL, model: "mock-vl", apiKeyEnv: "" });
	const postExecute11 = ctx11.handlers.get("tools/post-execute");
	const before11 = received.length;
	const result11 = {
		content: [
			{ type: "text", text: "<path>shot.png</path>" },
			{ type: "image", attachment: { attachmentId: "tr11", mediaType: "image/png", bytes: 7, width: 4, height: 4, name: "shot.png" } }
		],
		isError: false
	};
	const exec11 = { name: "read_image", agent: {}, signal: new AbortController().signal };
	const d1 = await postExecute11(exec11, result11, async () => ({ kind: "accept" }));
	const d2 = await postExecute11(exec11, result11, async () => ({ kind: "accept" }));
	assert.equal(d1.content[1].text, d2.content[1].text, "两次描述一致（缓存命中）");
	assert.equal(received.length, before11 + 1, "同一 attachmentId 只调用一次视觉 API");
	console.log("✅ 用例 11：同图重复出现 → 描述缓存，只识别一次");

	// ── 用例 12：适配器兜底安全网 —— llm.stream / llm.prepareCall 请求级转换 ──
	// 旧会话历史里已持久化的图片不经过 pre-step / post-execute，会在每次请求
	// 时直达适配器；包装后的 stream 必须在请求到达适配器前把图片转成文本。
	const makeLlmMock = () => {
		const seen = [];
		return {
			seen,
			resolveModelInfo: async () => ({ inputModalities: ["text"] }),
			stream: async function* (options) {
				seen.push(options);
				yield { type: "finish", reason: { kind: "stop" } };
			},
			prepareCall: async (config) => ({
				config,
				stream: async function* (options) {
					seen.push(options);
					yield { type: "finish", reason: { kind: "stop" } };
				}
			})
		};
	};
	const requestWithImage = {
		provider: "deepseek-official",
		model: "deepseek-v4-flash",
		sessionId: "s12",
		messages: [
			{ role: "user", content: [
				{ type: "text", text: "看看这张图" },
				{ type: "image", attachment: { attachmentId: "net12", mediaType: "image/png", bytes: 7, width: 4, height: 4, name: "legacy.png" } }
			] }
		]
	};
	const llm12 = makeLlmMock();
	const ctx12 = makeCtx({ llm: llm12 });
	apply(ctx12, { enabled: true, baseURL, model: "mock-vl", apiKeyEnv: "" });
	const before12 = received.length;
	const chunks12 = [];
	for await (const chunk of ctx12.get("llm").stream(requestWithImage)) chunks12.push(chunk);
	assert.equal(chunks12.length, 1, "stream 正常产出 chunk");
	assert.equal(llm12.seen.length, 1, "底层 stream 被调用一次");
	const sent12 = llm12.seen[0];
	assert.equal(sent12.messages[0].content.length, 2);
	assert.equal(sent12.messages[0].content[1].type, "text", "请求级转换：图片块已替换为文本");
	assert.ok(sent12.messages[0].content[1].text.includes("这是一张测试图片"));
	assert.equal(received.length, before12 + 1, "恰好一次视觉请求");
	// prepareCall 路径（agent loop 实际走的路径）
	const prepared12 = await ctx12.get("llm").prepareCall({ provider: "deepseek-official", model: "deepseek-v4-flash" });
	const chunks12b = [];
	for await (const chunk of prepared12.stream(requestWithImage)) chunks12b.push(chunk);
	assert.equal(llm12.seen.length, 2, "prepareCall.stream 也经过包装");
	assert.equal(llm12.seen[1].messages[0].content[1].type, "text", "prepareCall 路径同样转换图片");
	assert.equal(received.length, before12 + 1, "同图缓存命中，未再次调用视觉 API");
	console.log("✅ 用例 12：适配器兜底安全网（llm.stream / prepareCall）请求级转换 + 缓存");

	// ── 用例 13：主模型原生支持图片（pi-ai 视觉模型）时安全网原样放行 ────────
	const llm13 = makeLlmMock();
	llm13.resolveModelInfo = async () => ({ inputModalities: ["text", "image"] });
	const ctx13 = makeCtx({ llm: llm13 });
	apply(ctx13, { enabled: true, baseURL, model: "mock-vl", apiKeyEnv: "" });
	const before13 = received.length;
	for await (const chunk of ctx13.get("llm").stream(requestWithImage)) void chunk;
	assert.equal(llm13.seen[0].messages[0].content[1].type, "image", "视觉模型：图片块原样放行");
	assert.equal(received.length, before13, "未调用视觉 API");
	console.log("✅ 用例 13：原生视觉路由 → 安全网放行，图片原样传递");

	console.log("\n全部用例通过 ✅");
} finally {
	server.close();
	delete process.env.VISION_API_KEY;
}
