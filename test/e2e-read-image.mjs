/**
* dsh-vision-bridge 端到端验证（read_image 工具路径 —— 修复前的失败场景）：
* 1) sharp 生成带文字 "HELLO 9370" 的测试图，写入会话工作区
* 2) session.create 新建会话（cwd = 工作区）
* 3) 提示 agent 调用 read_image 读取该图
* 4) 轮询 session.history 断言：
*    a. 工具结果里没有 image 块（tools/post-execute 已把图片换成文本描述）
*    b. 没有 UNSUPPORTED_CONTENT 错误（turn 正常完成）
*    c. 视觉模型转录出 "HELLO 9370"，DeepSeek 回复包含该文字
* 运行：node test/e2e-read-image.mjs [baseURL]
*/
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
const require = createRequire(import.meta.url);

const base = (process.argv[2] ?? "http://127.0.0.1:3080").replace(/\/$/, "");
const sharp = require("sharp");

const cwd = "C:\\Users\\Administrator\\Documents";
const imgPath = join(cwd, "vb-e2e-read-image-test.png");

function rpcId() { return randomUUID(); }

async function call(method, payload, timeoutMs = 120000) {
	const message = { type: "client-request", rpcId: rpcId(), method, payload };
	const res = await fetch(`${base}/api/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(message),
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${method}: ${(await res.text()).slice(0, 300)}`);
	const full = await res.json();
	if (!full.result?.ok) throw new Error(`${method} failed: ${JSON.stringify(full.result)}`);
	return full.result.value;
}

// ── 1) 生成测试图 ───────────────────────────────────────────────────────
const width = 800, height = 300;
const svg = Buffer.from(`
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#1e6fd9"/>
  <text x="50%" y="52%" font-family="Arial, sans-serif" font-size="72" font-weight="bold"
        fill="white" text-anchor="middle" dominant-baseline="middle">HELLO 9370</text>
</svg>`);
const png = await sharp(svg).png().toBuffer();
writeFileSync(imgPath, png);
console.log(`✅ 测试图已写入: ${imgPath} (${png.length} bytes)`);

// ── 2) 创建会话 ─────────────────────────────────────────────────────────
const { sessionId } = await call("session.create", { cwd });
console.log(`✅ 会话已创建: ${sessionId}`);

try {
	// ── 3) 提示 agent 调用 read_image ────────────────────────────────────
	await call("session.prompt", {
		sessionId,
		mode: "queue",
		content: [
			{ type: "text", text: `请调用 read_image 工具读取这张图片：${imgPath}\n然后只回答图片里出现的文字内容，不要做其他操作。` }
		]
	});
	console.log("✅ 提示已入队，等待 agent 调用 read_image 并识别（约 1-3 分钟）…");

	// ── 4) 轮询历史 ─────────────────────────────────────────────────────
	const deadline = Date.now() + 10 * 60 * 1000;
	let toolResultText = null;
	let toolResultHasImage = false;
	let assistantText = "";
	let errorText = "";
	const toolCalls = [];
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 10000));
		const { events } = await call("session.history", { sessionId, maxMessages: 60 }, 30000);
		for (const entry of events) {
			const ev = entry.event;
			if (ev.type === "tool/call") toolCalls.push(ev.data?.name ?? "?");
			if (ev.type === "tool/result") {
				// 展开 tool-result 嵌套块（会话历史里工具结果包在 tool-result 块内）
				const blocks = [];
				const walk = (list) => {
					for (const b of list) {
						if (b.type === "tool-result") walk(b.content ?? []);
						else blocks.push(b);
					}
				};
				walk(ev.data?.message?.content ?? []);
				if (blocks.some((b) => b.type === "image")) toolResultHasImage = true;
				const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
				if (text.length > 0) toolResultText = text;
			}
			if (ev.type === "assistant/message") {
				const text = (ev.data?.message?.content ?? [])
					.filter((b) => b.type === "text")
					.map((b) => b.text).join("\n");
				if (text.length > 0) assistantText = text;
			}
			if (ev.type === "turn/end") {
				const reason = ev.data?.reason;
				if (reason?.kind === "error") errorText = reason.error?.message ?? JSON.stringify(reason.error);
			}
		}
		const done = errorText.length > 0 || (assistantText.length > 0 && events.some((e) => e.event.type === "turn/end"));
		if (done) break;
	}

	// ── 5) 输出与断言 ────────────────────────────────────────────────────
	console.log("\n===== 工具调用序列 =====");
	console.log(toolCalls.join(" → ") || "(无)");
	console.log("\n===== 工具结果（插件转换后） =====");
	console.log(toolResultText?.slice(0, 800) ?? "(未找到工具结果)");
	console.log("\n===== 助手回复（DeepSeek） =====");
	console.log(assistantText || "(未在超时前拿到回复)");
	if (errorText.length > 0) console.log(`\n⚠️ turn 错误: ${errorText}`);

	const calledReadImage = toolCalls.includes("read_image");
	const replaced = toolResultText !== null && !toolResultHasImage;
	const transcribed = /HELLO\s*9370/i.test(toolResultText ?? "");
	const deepseekSawText = /HELLO\s*9370/i.test(assistantText);
	const noAdapterError = errorText.length === 0 || !errorText.includes("does not support image content");

	console.log("\n----- 断言 -----");
	console.log(`① agent 调用了 read_image: ${calledReadImage ? "✅" : "❌"}`);
	console.log(`② 工具结果无 image 块（已转文本）: ${replaced ? "✅" : "❌"}`);
	console.log(`③ 视觉模型转录出 "HELLO 9370": ${transcribed ? "✅" : "❌"}`);
	console.log(`④ DeepSeek 回复包含图片文字: ${deepseekSawText ? "✅" : "❌"}`);
	console.log(`⑤ 无 UNSUPPORTED_CONTENT 错误: ${noAdapterError ? "✅" : "❌"}`);

	if (!calledReadImage || !replaced || !transcribed || !deepseekSawText || !noAdapterError) process.exitCode = 1;
} finally {
	// ── 6) 清理 ─────────────────────────────────────────────────────────
	try {
		const r = await call("workspace.archiveSession", { sessionId });
		console.log(`\n🧹 测试会话已归档: ${r.archivedSessionIds?.join(", ") ?? sessionId}`);
	} catch (error) {
		console.log(`\n⚠️ 归档失败（可忽略）: ${error.message}`);
	}
	try { rmSync(imgPath, { force: true }); } catch {}
}
