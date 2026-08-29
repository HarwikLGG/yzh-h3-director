/**
 * @dsh-external/yzh-h3-director — 妖猪猪H3连续剧情导演插件（工具包形态）。
 *
 * 同一套技能、单条流程、零 LLM 调用：
 *   yzh_h3_director_generate(剧情) →
 *     ① 自动提取搜索关键词（含剧情专名/地名/主题/风格，支持用户补充）
 *     ② 联网搜索资料（DDG 主通道 + Bing 兜底，Node fetch 直连，无需 API Key）
 *     ③ 打包【联网检索资料】+【剧情输入】+【生成要求】+【六字段规范提示词全文】
 *     ④ 对话推理模型拿到任务包后：分析打磨剧情 → 严格按六字段输出
 *        （subject_definitions / summary / retention_analysis / detailed_description /
 *          overall_soundscape / non_diegetic_music）
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { H3_PROMPT } from './prompt.js'
import { NOVEL_PROMPT } from './novel_prompt.js'

export const name = "@dsh-external/yzh-h3-director"
export const inject = ['tools']

export interface Config {
  /** 搜索超时(毫秒) */
  searchTimeout: number
  /** 每个关键词最多返回结果数 */
  maxResults: number
  /** 最多搜索关键词数 */
  maxQueries: number
}

export const Config = z.object({
  searchTimeout: z.number().default(15000),
  maxResults: z.number().default(4),
  maxQueries: z.number().default(5),
})

// ── 工具内部：HTML 清洗 / 关键词提取 / 搜索 ────────────────────────────────
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeDdgUrl(href: string): string {
  const m = /uddg=([^&]+)/.exec(href)
  if (!m) return href
  try { return decodeURIComponent(m[1]) } catch { return href }
}

interface SearchResult { title: string; url: string; snippet: string }

async function searchDdg(q: string, max: number, timeoutMs: number): Promise<SearchResult[]> {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q) + '&kl=cn-zh&kp=-1'
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  })
  const html = await res.text()
  const out: SearchResult[] = []
  const blockRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  const snippets = [...html.matchAll(snipRe)]
  const blocks = [...html.matchAll(blockRe)]
  for (let i = 0; i < blocks.length && out.length < max; i++) {
    const title = stripHtml(blocks[i][2])
    if (!title) continue
    const snippet = i < snippets.length ? stripHtml(snippets[i][1]) : ''
    out.push({ title, url: decodeDdgUrl(blocks[i][1]), snippet: snippet.slice(0, 260) })
  }
  return out
}

async function searchBing(q: string, max: number, timeoutMs: number): Promise<SearchResult[]> {
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&mkt=zh-CN&count=' + max + '&setlang=zh-hans'
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  })
  const html = await res.text()
  const out: SearchResult[] = []
  // b_algo 块: li class="b_algo" ... <h2 class=""><a ... href=URL>TITLE</a></h2> ... <div class="b_caption"><p ...>SNIPPET</p>
  const blockRe = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<div class="b_caption">[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html)) !== null && out.length < max) {
    const title = stripHtml(m[2])
    if (!title) continue
    out.push({ title, url: m[1], snippet: stripHtml(m[3]).slice(0, 260) })
  }
  // 兜底: 无 b_caption 的块, 至少取标题
  if (out.length === 0) {
    const looseRe = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
    let m2: RegExpExecArray | null
    while ((m2 = looseRe.exec(html)) !== null && out.length < max) {
      const title = stripHtml(m2[2])
      if (!title) continue
      out.push({ title, url: m2[1], snippet: '' })
    }
  }
  return out
}

async function searchSogou(q: string, max: number, timeoutMs: number): Promise<SearchResult[]> {
  const url = 'https://www.sogou.com/web?query=' + encodeURIComponent(q)
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'referer': 'https://www.sogou.com/',
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  })
  const html = await res.text()
  const out: SearchResult[] = []
  // 搜狗: <div class="vrwrap"><h3 class="vr-title"><a href="...">标题</a> / <p class="str_info">摘要
  const re = /<div class="vrwrap"[\s\S]*?<h3 class="vr-title"[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p class="str_info"[^>]*>([\s\S]*?)<\/p>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null && out.length < max) {
    const title = stripHtml(m[2])
    if (!title) continue
    out.push({ title, url: m[1], snippet: stripHtml(m[3]).slice(0, 260) })
  }
  return out
}

/** Scrapling 优先通道: spawn Python 桥 (百度/搜狗/必应/DDG, 反爬稳) */
const PY_PATHS = [
  'C:/Users/Administrator/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe',
  'C:/Users/Administrator/AppData/Local/hermes/hermes-agent/venv/python.exe',
  'python',
  'py',
]

function findPython(): string | null {
  for (const p of PY_PATHS) {
    if (p === 'python' || p === 'py') return p
    if (existsSync(p)) return p
  }
  return null
}

function scraplingSearch(q: string, max: number, timeoutMs: number): SearchResult[] | null {
  try {
    const py = findPython()
    if (!py) return null
    const bridge = join(dirname(fileURLToPath(import.meta.url)), 'scrapling_search.py')
    if (!existsSync(bridge)) return null
    const r = spawnSync(py, [bridge, q, String(max)], {
      encoding: 'utf8', timeout: timeoutMs + 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    })
    if (r.status !== 0) return null
    const out = JSON.parse(r.stdout.trim() || '[]')
    if (!Array.isArray(out)) return null
    return out.filter((x: any) => x && x.title).map((x: any) => ({
      title: String(x.title).slice(0, 200),
      url: String(x.url || ''),
      snippet: String(x.snippet || '').slice(0, 260),
    }))
  } catch {
    return null
  }
}

async function searchOne(q: string, max: number, timeoutMs: number): Promise<{ q: string; results: SearchResult[]; error?: string; via?: string }> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  // ① 优先 Scrapling(Python桥)
  const sp = scraplingSearch(q, max, timeoutMs)
  if (sp && sp.length > 0) return { q, results: sp, via: 'scrapling' }
  // ② 回退 Node fetch 多引擎轮询: Bing(主) → DDG → 搜狗 → Bing 重试
  const attempt = async (engine: 'bing' | 'ddg' | 'sogou') => {
    try {
      if (engine === 'bing') return await searchBing(q, max, timeoutMs)
      if (engine === 'ddg') return await searchDdg(q, max, timeoutMs)
      return await searchSogou(q, max, timeoutMs)
    } catch {
      return [] as SearchResult[]
    }
  }
  const engines: Array<'bing' | 'ddg' | 'sogou' | 'bing'> = ['bing', 'ddg', 'sogou', 'bing']
  const waits = [0, 400, 700, 600]
  for (let i = 0; i < engines.length; i++) {
    if (waits[i]) await sleep(waits[i])
    const r = await attempt(engines[i])
    if (r.length > 0) return { q, results: r, via: engines[i] }
  }
  return { q, results: [], via: 'none' }
}

/** 无 LLM 关键词提取：补充词 + 地名/专名(不含"的") + 引号内容 + 高频专名字串 + 风格词; 主题头兜底 */
function extractKeywords(story: string, extra?: string): string[] {
  const kws = new Set<string>()
  if (extra) {
    for (const t of extra.split(/[;,，、;；\n]/)) {
      const tt = t.trim()
      if (tt.length >= 2 && tt.length <= 24) kws.add(tt)
    }
  }
  // 地名/专名后缀词（匹配不含"的"的专名, 如 贞子岛/雾隐镇/城堡）
  const suf = ['岛', '山', '城', '镇', '村', '寺', '宫', '殿', '园', '街', '巷', '堡', '谷', '河', '湖', '桥', '庄', '墓', '塔', '楼', '林', '洞', '湾', '坊', '庙', '寨', '港', '滩', '丘']
  const placeRe = new RegExp('([\\u4e00-\\u9fa5]{1,6}?(?:' + suf.join('|') + '))', 'g')
  let m: RegExpExecArray | null
  while ((m = placeRe.exec(story)) !== null && kws.size < 24) {
    const t = m[1]
    if (t.length >= 2 && !/[的了和与在是被往向从至到把将的]/.test(t)) kws.add(t)
  }
  // 引号内容
  const quoteRe = /[《「『"“]([^》」』"”]{2,16})[》」』"”]/g
  while ((m = quoteRe.exec(story)) !== null) {
    if (!/[的了和与在是被往向从至到把将的]/.test(m[1])) kws.add(m[1])
  }
  // 高频专名字串（2-4字 n-gram 计数, 低噪词加权; 抓"躲避球弹平"这类用户认识但模型不认识的语）
  const noiseRe = /[的了和与在是被往向从至到把将也都很这那是有一他她它们而则且或但并又]/
  const counts = new Map<string, number>()
  const plain = story.replace(/[^\u4e00-\u9fa5A-Za-z]/g, ' ')
  const words = plain.split(/\s+/).filter(Boolean)
  for (const w of words) {
    const len = w.length
    const maxN = Math.min(4, len)
    for (let n = 2; n <= maxN; n++) {
      for (let i = 0; i + n <= len; i++) {
        const sub = w.slice(i, i + n)
        if (noiseRe.test(sub)) continue
        counts.set(sub, (counts.get(sub) || 0) + 1)
      }
    }
  }
  // 排序: 频率降序, 长度优先(长的更可能是专名), 前6个
  const frequent = [...counts.entries()]
    .filter(([s, c]) => c >= 2 && s.length >= 2)
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))
    .slice(0, 6)
    .map(([s]) => s)
  for (const s of frequent) kws.add(s)
  // 风格类型词
  for (const s of ['恐怖', '悬疑', '惊悚', '爱情', '奇幻', '科幻', '古装', '武侠', '仙侠', '都市', '校园', '治愈', '灾难', '末日', '穿越', '吸血鬼', '僵尸', '丧尸', '怪兽', '神仙', '妖怪', '民国', '赛博朋克']) {
    if (story.includes(s)) kws.add(s)
  }
  // 兜底: 主题头(去掉动词介词后取核心, 仅当仍空)
  if (kws.size === 0) {
    const head = story.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, 14)
    if (head.length >= 4) kws.add(head)
  }
  return [...kws]
}

export function apply(ctx: Context, config: Config): void {
  const { searchTimeout = 15000, maxResults = 4, maxQueries = 5 } = config

  // 单一技能工具：搜索资料 + 规范提示词 一次打包，对话模型直接分析打磨并六字段输出
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'yzh_h3_director_generate',
    description: '妖猪猪H3连续剧情导演(单条流程): 自动联网检索角色/设定→打包生成要求+Picture放置规则+六字段规范→对话模型两轮打磨(首轮+审核二修)后严格输出官方六字段。只需提供剧情文本。',
    parameters: {
      story: { type: 'string', required: true, description: '你的剧情/故事(人物、场景、剧情梗概等, 越详细越好)' },
      search_topics: { type: 'string', description: '可选补充搜索主题(分号分隔); 不填则由插件从剧情自动提取关键词' },
      segments: { type: 'number', description: '可选指定Segment段数; 不填则由AI根据剧情自动决定' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { story: string; search_topics?: string; segments?: number }) {
      const story = (args.story || '').trim()
      if (!story) return '❌ 缺少 story 参数'
      const segLine = args.segments && args.segments >= 1
        ? `分段数量：严格采用 ${args.segments} 段（如若不完整则增加段数）。`
        : '分段方式：AI自动分段（AI分析故事后自动分段，每段时长上限12秒，具体段数由AI根据整体剧情决定）。'

      const kws = extractKeywords(story, args.search_topics).slice(0, maxQueries)
      const searchParts: string[] = []
      let viaSet = new Set<string>()
      for (const q of kws) {
        const { results, error, via } = await searchOne(q, maxResults, searchTimeout)
        if (via) viaSet.add(via)
        if (error) {
          searchParts.push(`【关键词】${q}\n   检索失败: ${error}`)
          continue
        }
        if (results.length === 0) {
          searchParts.push(`【关键词】${q}\n   (无结果)`)
          continue
        }
        const lines = results.map((r, i) => `   ${i + 1}. ${r.title}\n      URL: ${r.url}\n      摘要: ${r.snippet}`)
        searchParts.push(`【关键词】${q}\n` + lines.join('\n'))
      }
      const viaNote = [...viaSet].length ? `\n(检索通道: ${[...viaSet].join(' + ')})\n` : ''
      const searchBlock = searchParts.length
        ? '\n\n【联网检索资料】（供你分析剧情、补充细节、查漏补缺，并非硬性要求）' + viaNote + '\n\n' + searchParts.join('\n\n')
        : '\n\n【联网检索资料】\n(无检索结果——请以剧情原文与你的知识为准)\n'

      return (
        `# 任务：设计「连续剧情导演版」完整连续剧情，并严格按官方六字段输出。\n\n` +
        `# 一、生成要求（必须严格遵守，优先级最高）\n` +
        `- ${segLine}\n` +
        (args.search_topics ? `- 补充搜索主题：${args.search_topics}\n` : '') +
        `- 【Segment 时长（按节奏安排）】每个 Segment 时长最短不低于 8 秒、最长不超过 13 秒（duration 在 00:08.000–00:13.000 之间，任何一段不得低于 8 秒或超过 13 秒）；时长由剧情节奏决定：对白多/动作复杂的段取 12–13 秒，安静/短节的段取 8–10 秒，不得为凑固定时长加快对白或拖慢动作。每段时间从 00:00.000 独立开始。\n` +
        `- 【对白语速】对白按中文自然语速 3–4 字/秒 规划，一句话通常需 2–4 秒（均匀念白）或更长（有停顿/情绪）；不得为了塞进固定时长而加速语速或连读台词；对白过多时增加时长到上限 13 秒，仍放不下则把该 Beat 拆到下一 Segment，保持对白自然节奏。\n` +
        `- 公共人物绑定只出现一次：完整人物资产只在最上方「公共人物绑定:」区定义；后续 Segment 不再输出 subject_definitions，禁止重抄人物完整外貌，直接引用 <Subject N>。\n` +
        `- 【人物资产详细度（圣经级·硬性）】公共人物绑定区的每个 <Subject N> 必须逐项展开为"角色资产圣经"级别的详细描述，绝不允许压缩成一句话——每个角色必须完整包含以下全部字段：①身份（姓名/职业/组织/双重身份）②性别/年龄 ③体型（身高视觉/头身比/肩宽/腰臀/四肢比例/肤色/体态）④面部资产（脸型/额头/眉形眉色/眼型眼距/虹膜/鼻梁鼻尖/唇形唇色/固定识别点如朱砂痣）⑤皮肤微细节（肤质/睫毛/眼周晕染/妆感）⑥发型（发色/长度/发量/束法/碎发/发饰）⑦手部职责表（左手=什么手/右手=什么手/全片锁定）⑧服装（颜色/面料/纹饰/内衬/束腰/衣摆/佩件/剑的长短与细节）⑨整体气质（一句话定调，如"美得不可方物，慵懒中自带疏离"）⑩人物目标（贯穿全章）。\n` +
        `  正确样例（以 <Subject 1> 为例）：\n<Subject 1> 是 <Picture 1>中的一位绝美的少年舞姬——于昔。身份：静雨楼的当红舞姬，兼图隐阁凤甲城分坛的刺客。性别/年龄：少年，视觉年龄约十七八岁；体型：身姿清瘦颀长、体态轻盈，肩窄腰细，头身比接近 1:7，四肢修长，肤色白皙如玉。面部资产：鹅蛋脸，脸型窄长、下颌尖而线条干净；额头光洁饱满；眉形细长而微弯（柳叶眉），眉色墨黑；眼型为狭长的桃花眼——眼尾微挑、带天然眼线感，双眼皮窄而清晰，眼距适中，虹膜为浅琥珀色，常含一层水光；鼻梁挺直、鼻尖微翘；唇形小巧而上唇微薄、唇峰分明，唇色偏浅（常以朱红轻点）；眉心一点朱砂痣（固定识别点）。皮肤微细节：肤质细腻，无疤痕；眼周与嘴角有极轻的薄红晕染（妆感），睫毛浓密。发型：长发乌黑如墨，长及腰下，以一支玉簪挽成半束发髻，前额两侧自然垂落几缕碎发至眉眼；发量浓密、发尾微卷。手部职责表：左手=佩剑手（悬长剑侧，仅指尖轻叩剑柄/理鬓），右手=隐形祭剑手（"抚腰收剑"动作）+行礼客套手；全片锁定，禁止换手。服装：一袭红色锦衣（正红织暗金云纹），内衬黑缎中衣与黑缎束腰，宽袖，衣摆及踝；腰系黑绸腰带，左侧悬一长一短两柄剑（长剑约三尺、短剑约一尺五），剑鞘乌黑缀银丝穗。整体气质：容色绝艳而不俗，"美得不可方物"，慵懒中自带疏离，看似弱不禁风、实则身怀暗杀绝技。人物目标（贯穿全章）：以歌舞立足静雨楼、收集修炼资源，静待作为刺客出鞘的时机。\n` +
        `  每个 <Subject N> 都要达到此级别（身份/年龄/体型/面部/皮肤/发型/手部/服装/气质/目标十项齐全），且**开头必须写"<Subject N> 是 <Picture N>中的一位/一位绝美的……"**（用 Picture 完成人物图像绑定）；女性/男性/儿童/动物类别按其中相应字段展开（动物用"同一头"）。\n` +
        `- 人物绑定格式统一 <Subject N> 是 <Picture N>中的一位……（动物：<Subject N> 是 <Picture N>中的同一头……）；同一人物严禁拆成多个 Subject。\n` +
        `- 【人物出场纪律（硬性）】每个 Segment 只允许出现**该段画面内实际出场的人物**：未在本段入画的人物，其 <Subject N> 与其中文名在该 Segment 输出的全部字段（summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music）中一律不得出现——也不要写"不出画/未出场/零提及/以画外声音出现"等任何元说明（这类标注本身也含 Subject 字眼，会自伤；正确做法是**干脆不写它、让文本自然不含该人物**）。仅当真的需要隔门/隔楼的画外声音时，才能在 detailed_description 中用"一个声音从门外传来"这类**不点名**方式表达（不得写出 Subject N 也不得写人名）。\n` +
        `- 【单一称呼锁定（硬性）】每个 <Subject N> 在整个章节中只允许使用**一个统一称呼**（既不能混用中文名/外号/身份称呼，也不能在不同镜头换称呼）——例如"于昔"就全片只写"<Subject 1>"或只写"于昔"，禁止在同一 Segment 中它既被叫"于昔"又被叫"小倌/舞姬/昔儿"等不同名号（多称呼会让模型把同一实体当成多个人物复制渲染）。对话中他人对人物的称呼除外（对白本身可以有"昔儿/于美人"等原台词），但叙述描述文字必须统一单一称呼。\n` +
        `- 场景/道具/参考图 <Picture N> 如需引用，仅在 detailed_description 中以"（场景见 <Picture N>）"形式简注；Picture 编号整个项目全局连续，不因 Segment 重排。\n` +
        `- 【无重复 subject_definitions（硬性）】公共人物绑定区已一次性完成全部人物定义，**后续各 Segment 不再输出 subject_definitions 字段**，也禁止在 summary / retention_analysis / overall_soundscape / non_diegetic_music 等任何字段重复人物绑定描述——人物出现时直接在 detailed_description 中用 <Subject N> 引用即可（如"<Subject 1> 沿楼梯缓步走下"）。需要时场景/道具/参考图 <Picture N> 只在对于理解该段画面所必需时以"（场景见 <Picture N>）"形式在 detailed_description 内简注。\n` +
        `- 导演台连续生成：不使用 <Video N>、不使用 [video continuation]；每个 Segment 一律 [reference generation]；从上一段最后一帧直接继续，禁止动作倒带、禁止恢复默认状态、禁止黑场/淡出（非最终段）、禁止无理由瞬移。\n` +
        `- 输出结构：最上方一次「公共人物绑定:」（= subject_definitions 区，仅出现一次置顶，完成全部人物设定后不再出现）；随后每个 Segment 依次只输出 5 个字段：summary: / retention_analysis: / detailed_description: / overall_soundscape: / non_diegetic_music:——不再输出 subject_definitions 字段。技术标签保持英文（<Subject N>、<Picture N>、fully_preserved、[Shot N] At 00:00.000、[reference generation]、<d>[Chinese] ……</d>）。\n` +
        `- 【语言策略（硬性）】对白一律中文并用 <d>[中文]……</d> 包裹（英文对白仅当台词本身是英文时用 <d>[English]……</d>）。**除对白外的其余正文必须全部使用英文书写**——summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music 的全部正文，以及机位、镜头、位置、空间、动作、表演、光影、焦点、声音指导等所有描述一律英文；位置坐标用罗盘词与英文字符，镜头/景别/机位/运镜/构图等一律英文术语；禁止任何中文叙事（<d>标签内的中文除外），禁止模糊方位词。\n` +
        `- 【画面唯一性（硬性）】每个镜头（Shot）画面内，每个出场 <Subject N> 必须且只能出现一次；绝对禁止同一人物在同一画面中的双像/分身/镜像/复制渲染（无论正影倒影、远景近景同时出现）；同一人物在同一 Segment 内任何时刻只能处于一处，位置变化必须有 Movement Path 与物理过程，禁止瞬移（尤其禁止"黑场/切镜后人物凭空换位"）。若剧情需要"人物面对自己的倒影"，使用「旁观机位正拍 + 镜中人物单独入画、真实人物全部画外」实现。\n` +
        `- 【对白格式（硬性）】所有人物对白必须以 <d>[中文]……</d> 标签包裹（英文对白用 <d>[English]……</d>）；任何人物的对白必须同时提供①说话人标识 <Subject N> (SN) ②英文声音表演指导（vocal direction：音量、音色、音域、节奏、气息、情绪语气、必须避免的念法，用完整英文描述句）③<d>标签内的中文对白原文。\n` +
        `  正确范例：<Subject 1> (S1) 声音沉稳克制：and a slight chest undertone; low in volume, clearly articulated, cut in short phrases, with restrained impatience and pauses at sentence endings. Avoid a cute voice, domineering breathiness, announcer delivery, false maturity, or cartoon exaggeration. Do not play the line as narration: it is a controlled command directed at her. The volume dips slightly on“三个愿望” and the ending closes without a flourish.\n<d>[中文]女人，把领队带回家，可以实现你三个愿望。</d>\n  禁止把对白写成一串引号包裹的中文台词（如 女客"……"）；禁止把英文声音指导改成中文；禁止缺省 <d> 标签。\n` +
        `- 对白只出现在 detailed_description 内；尽量给每个主要角色固定 Speaker ID（首现即标注 <Subject N> (SN)），后续一致。\n` +
        `- 【原对白全量输出（硬性）】用户提供的小说章节/剧情中的所有原对白，一条都不能忽略、不能减省、不能更改大意——必须全部完整输出，并安插在对应场景与镜头中。多句对白链（如"你来这静雨楼就拿这些货色欺我等？"—"哎呦，客官…"—"你一个夫道人家…"）必须逐句完整呈现，不得合并、不得用叙述替代（如"女客不满地说了几句"）、不得只保留部分关键词。原对白中的人物、关系、态度、关键信息不得改变（仅当用户未要求逐字保留时才可做极轻微口语化整理）。\n` +
        `- 每条对白都要落在合理的场景内：对话发生的地点/人物在场关系必须与原文一致；同一场景连续对话要按原文顺序推进，跨场景的对白要随场景迁移而迁移。\n` +
        `- 字段名不得翻译/改写，字段顺序不得改变；不得伪造 <Picture N>（场景无参考图时自然语言描述）。\n` +
        `- 非最终 Segment 必须留下清晰动作接口帧（运动矢量+朝向+道具位置），最终段才允许完整收束。\n` +
        `- 【稳定复现·绝对空间】全片必须建立两份一次性公共资产：①【世界坐标系】——以"东西南北罗盘 + 房间固定锚点(A/B/C…)"定义场景四向布局与关键位置，全片不变量；②【机位登记表】——为每个用过的机位命名（CAM-A/B/C…），写清绝对位置、朝向、高度、俯仰与默认景别，后续镜头只引用名字。所有方位描述只用罗盘词，禁止"前方/后方/左边/旁边/一侧/前面"等无参照词。\n` +
        `- 【稳定复现·开局占位】每个非首 Segment 的 detailed_description 开头必须输出【开局占位核对】：人物身体轴向（头朝x、脚朝y）、体位（仰/俯/站/坐）、方位角、左右手状态、道具位置——逐项声明与上一段出口帧完全一致；人物占位只允许剧情明文规定的变化。\n` +
        `- 【稳定复现·肢体纪律】在公共人物绑定区为每个角色建立手部职责表（如 江宴辞：左手=腕表手·唯一触碰、右手=平板手·全程持物），全片锁定：禁止换手、禁止新增第三只手、禁止"一只手干两件事"；每帧画面内的手必须能指认到职责表；特写镜头必须限制画面内肢体件数（明确列出允许出现的肢体件，其余声明"在画面外，禁止入画"）。\n` +
        `- 【稳定复现·禁用镜面反射】禁止实体镜子/玻璃/水面等反射面与倒影入画——反射会把肢体复制（出现"三只手"）；文学上的"镜中"视角用「旁观机位正拍+对称构图」替代实现。若剧情硬性必须用镜：只允许单镜头纯反射视角（真实空间人物全部在画外），"真实+反射"同框严格禁止。\n` +
        `- 【稳定复现·微动作禁位移（防贴墙瞬移）】人物的"看/侧头/闭眼/松手/抬眉"等微动作绝对禁止伴随任何身体位移（起身/转身/平移/靠近边界）；禁止人物靠近、贴靠或朝向墙/窗/镜等环境边界的构图与视线；窗只作为光源出现（斜射光斑），禁止"走向窗边/看向窗外"类指示。光源方向务必与人物脸部朝向自洽：顺光=光从镜头方向来、逆光=光从人物背后方向来、侧光=光从一侧来——同一镜头只写一种，禁止自相矛盾（矛盾会诱发模型把人物挪向光源，造成瞬移）。\n\n` +
        `# 二、剧情输入（用户提供）\n\n${story}\n\n` +
        searchBlock +
        `\n\n# 三、工作流（本任务包为 B 路；完整链条 = A 路影视化 → B 路六字段 → 全内容回头审核 → 格式校验）\n` +
        `说明：用户给的内容（无论网络小说、剧情设定还是梗概）一律先经 A 路影视化分镜（yzh_novel_storyboard），取其【AI视频剧情提示词】作为本段 story；此处执行 B 路 + 最终审核。\n` +
        `第一轮：结合上述要求与检索资料，设计完整连续剧情并输出全部 Segment 的官方六字段（含公共人物绑定区）。\n` +
        `审核轮（全内容回头审核：场景/人物/道具/动作/位置/镜头/连续性/物理合理性，逐项核对）：\n` +
        `① 人物动作：动作是否有物理过程（起始状态→动作发生→动作结果）、是否完成全程、有无"没拿起突然已在嘴边"式跳跃、有无动作倒带/重复执行上一段已完成动作。\n` +
        `② 位置：人物真实世界位置（靠 A/B/C 空间锚点描述）、进出前后是否一致、有无瞬移、人物与道具/场景距离关系是否合理。\n` +
        `③ 镜头：机位是否从上一段机位接力（开头约 0.5–2 秒延续原机位再切换）、Camera Vector 是否与 Character Movement Vector 分离、镜头有没有改变人物真实路径、切点是否在动作进行中。\n` +
        `④ 物理：重心、蹬地方向、朝向角、转身支点（如以左脚为支点旋转约180°）、水渍/破损/妆发等状态是否符合前一帧、重力与时间的物理连续性。\n` +
        `⑤ 其余：再对照「四、六字段格式规范」第五十九节《输出前内部连续性检查》37 项逐项自查（人物资产/时长/首尾接口/状态/空间/场景/声音），并核对格式是否全部符合上述生成要求。\n` +
        `⑥ 肢体：每拍画面的手/腿数量是否可指认到手部职责表；有无第三只手、多余肢体或反射复制（三只手）；特写是否声明了肢体件数上限。\n` +
        `⑦ 位置细节：微动作是否伴随位移；人物有无贴靠墙/窗/镜边界；"看/侧头"指示与光源描述是否自洽（顺光/逆光矛盾会诱发瞬移）；机位是否只引用登记表命名并完成 0.5–2 秒接力。\n` +
        `⑧ 对白格式：每句人物对白是否都是「<Subject N> (SN) + 英文声音表演指导 + <d>[中文]……</d>」结构；有无把对白写成中文引号串；Speaker ID 是否全程一致；英文指导是否完整可用（音量/音色/节奏/情绪/避免事项）。\n` +
        `⑨ 画面唯一性：每个镜头画面内每个人物是否只出现一次、同一人物有无双像/分身/镜像/复制渲染；同一人物在同一 Segment 内是否始终处于一处、有无瞬移（切镜/黑场后位置变化）；倒影场景是否符合"真实人物画外"规则；位置变化是否都有 Movement Path 支撑。\n` +
        `⑩ 原对白完整性：用户提供的原对白是否逐句完整输出（可对照原文核对，一条不落）；有无用叙述替代、合并、关键词截断；对白所在场景/人物在场关系/顺序是否与原文一致；跨镜头连续对白是否随场景推进而完整保留。\n` +
        `⑪ 人物出场纪律：未出场人物的 <Subject N> 与中文名是否在本 Segment 全部字段零提及（连"不出画"也不要写）；画外声音是否用"一个声音从门外传来"类不点名方式；同一人物是否全程只用一个统一称呼（有无"于昔+小倌+昔儿"混用导致复制渲染）。\n` +
        `⑫ 时长与语速：每段时长是否在 8–14 秒区间（不低于 8、不超过 14）；对白是否按 3–4 字/秒 自然语速规划；有无为凑固定时长而加速台词或拖慢动作；对白多时是否给了足额时长或合理拆分。\n` +
        `⑬ 人物资产详细度：公共人物绑定区的每个 <Subject N> 是否达到"角色资产圣经"级别（身份/年龄/体型/面部/皮肤/发型/手部职责表/服装/气质/目标十项齐全，非一句话压缩）；有无把人物写成一两句简略概述。\n` +
        `⑭ 语言策略：除 <d>[中文]…</d> / 【OS】内的对白外，其余正文是否全部为英文（机位/镜头/位置/动作/表演/光影/summary/retention/detailed/soundscape/music），有无中文叙事残留；镜头/景别/机位/运镜/构图是否英文术语；有无模糊方位词。\n` +
        `⑮ 场景与道具：每个 Segment 的场景（地点/时间/光线/空间状态）是否与上一段一致或按剧情推进；场景变化是否给出明确移动/时间跳跃；道具（含佩剑/血镯/丹药等）位置、持有者、状态是否随剧情连续（无复活/无凭空出现/无消失后重现）；道具状态变化是否只由剧情明文规定触发。\n` +
        `发现任何冲突（如时长低于8秒或超过14秒、Picture 遗漏、字段名松动、动作倒带、位置瞬移、镜头跳切、物理不合理、恢复默认状态、对白缺失<d>标签、同人物分身/双像/瞬移、原对白遗漏或改写、未出场人物误入画面、对白语速过快、中文叙事残留、场景/道具不连续），必须先自行重新设计对应 Segment，再输出。\n` +
        `二修轮：修正全部不合理处后输出最终版本——只呈现一次完整设计（公共人物绑定: + 各 [Segment N | duration 00:XX.XXX] 六字段）。\n` +
        `格式终检（最后一步，严格校验输出形式）：字段名是否严格官方英文（summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music）、顺序是否固定、公共人物绑定(subject_definitions)是否仅前置一次、每段是否无重复 subject_definitions、对白是否一律 <d>[中文]…</d>、未出场人物是否零提及、单称呼、8–14 秒、16:9 横屏、无 <Video N>/[video continuation]；有任何不符即修正后重新输出，直到格式完全满足。\n\n` +
        `# 四、六字段格式规范（完整提示词，必须严格遵照）\n\n${H3_PROMPT}`
      )
    },
  })), '@dsh-external/yzh-h3-director: generate tool')

  // 前端工作流: 网络小说章节 → 影视分镜(4.0提示词) → 输出内容可直接投喂 generate
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'yzh_novel_storyboard',
    description: '网络小说章节影视化/分镜/视频提示词生成(4.0): 粘贴一整章小说, 先按影视分镜4.0规范改编为场景+Beat+Segment+专业分镜+【AI视频剧情提示词】, 结果可直接作为 story 投喂 yzh_h3_director_generate 生成官方六字段连续剧情。',
    parameters: {
      novel_chapter: { type: 'string', required: true, description: '网络小说一整章原文(章节名+正文)' },
      preserve_dialog: { type: 'boolean', description: '默认false; true=原台词逐字保留不改' },
      target_seconds: { type: 'number', description: '可选每Segment目标秒数(8-14, 默认按剧情节奏; 不得超过14)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { novel_chapter: string; preserve_dialog?: boolean; target_seconds?: number }) {
      const chapter = (args.novel_chapter || '').trim()
      if (!chapter) return '❌ 缺少 novel_chapter 参数'
      const secsRaw = args.target_seconds && args.target_seconds > 0 ? args.target_seconds : 0
      const secs = secsRaw ? Math.min(14, Math.max(8, secsRaw)) : 0
      const secsLine = secs > 0
        ? `每个 Segment 目标时长约 ${secs} 秒（不得超过 14 秒；内容不足可用表演停顿/视线/动作过程自然延展, 禁止无意义凑时长）。`
        : `每个 Segment 时长由剧情节奏决定：单个 Segment 最长不超过 14 秒，推荐 8—14 秒（剧情决定长度，14 秒只是上限；重要瞬间 5 秒也可单独成段）。`
      const preserveLine = args.preserve_dialog
        ? '- 原台词逐字保留（用户要求"原台词绝对不改"），不得修改任何原对白核心意思。\n'
        : '- 原台词核心意思不可改；可做极轻微口语化整理（不改意思/人物关系/态度/信息）。\n'
      return (
        `# 任务：将以下网络小说章节影视化改编为专业分镜与视频生成提示词。\n\n` +
        `# 一、生成要求（必须严格遵守，优先级最高）\n` +
        `- ${preserveLine}` +
        `- ${secsLine}\n` +
        `- 忠于原著：禁止改变事件结果/人物关系/性格/谁说了什么/关键道具/生死/顺序/新增关键角色或剧情；可补充合理影视化动作。\n` +
        `- 心理活动优先视觉化（表情/眼神/停顿/呼吸/动作/POV/反应镜头），仅在无法自然表达且必要时才用【OS】；作者叙述不得机械变旁白。\n` +
        `- 运镜必须情绪驱动（参照规范§23-29）：先判断当前情绪走势与导演目的，再决定摄影机动/不动、运镜速度与方式；禁止"每句话切一次镜头"、禁止为电影感无意义推/绕/摇/跟。\n` +
        `- 角色之间的镜头转移（§26）优先判断"切镜 vs 运镜"哪种更合适；重要节点（§28）可加强视听强调但不得炫技；重要镜头允许延长（§29/§38）。\n` +
        `- 跨 Segment 连续性（§14/§35/§36）：上一 Segment 最后状态的摄影机/人物/道具/光线 = 下一 Segment 起始状态；跨 Segment 运镜必须连续（延续/停住/明确切换三选一）。\n` +
        `- 镜头数量由剧情节奏决定（§38/§39），不设固定数字；每段每镜头都要给【景别/机位/镜头运动/运镜速度/预计时长/构图/画面/动作/表演/对白OS/镜头目的/与下一镜连接】。\n` +
        `- 输出结构按规范末段【更新后的Segment输出格式】：Segment 需标注预估时长(≤14秒)、含剧情节拍/情绪判断/导演意图/分镜/【连续生成结束状态】/【AI视频生成剧情提示词】。\n` +
        `- 每段都要输出【AI视频剧情提示词】（连续真实时间线描述: 初始状态/动作顺序/情绪变化/摄影机何时移动/移动到哪/焦点转移/对白/最终状态，且能在本段时长内自然完成），禁止关键词堆砌。\n` +
        `- 【语言策略（硬性）】对白与 OS（内心独白）用中文并放在 <d>[中文]……</d> / 【OS】内；**其余描述必须全部英文**——场景信息/空间锚点/剧情目标/剧情节拍/情绪判断/导演意图/镜头(景别/机位/镜头运动/运镜速度/预计时长/构图/画面/动作/表演/镜头目的/与下一镜连接)/连续生成结束状态/AI视频剧情提示词的全部叙事一律英文；位置坐标用罗盘词与英文字符，镜头/景别/机位/运镜/构图等一律英文术语；禁止任何中文叙事（<d>/【OS】内中文除外），禁止模糊方位词。\n` +
        `- 版本裁决：本任务包末尾《影视分镜  4.0》中与上述"8-14秒/镜头数不定/新Segment格式/英文描述"冲突的旧表述，一律以规范内【版本裁决（新规则优先）】与本节为准；其他规则（忠于原著/原对白/场景Beat/轴线/完整性检查）继续有效。\n\n` +
        `# 二、小说章节原文（用户提供）\n\n${chapter}\n\n` +
        `# 三、影视分镜生成系统提示词 4.0（完整规范，必须严格遵照）\n\n${NOVEL_PROMPT}`
      )
    },
  })), '@dsh-external/yzh-h3-director: novel storyboard tool')
}
