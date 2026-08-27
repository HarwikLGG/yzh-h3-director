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
        `- 每个 Segment 最长不得超过 12 秒（duration ≤ 00:12.000），每段时间从 00:00.000 独立开始。\n` +
        `- 公共人物绑定只出现一次：完整人物资产（脸型/五官/皮肤/发型/身材/服装/配饰）只在最上方「公共人物绑定:」区定义；后续 Segment 的 subject_definitions 禁止重抄人物完整外貌，只能引用 <Subject N>。\n` +
        `- 人物绑定格式统一 <Subject N> 是<Picture N>同一位/同一头……；同一人物严禁拆成多个 Subject。\n` +
        `- 【Picture 放置规则】公共人物绑定区：每个<Picture N>随对应人物绑定出现（<Subject N> 是<Picture N>……）。每个 Segment 的 subject_definitions 必须放置本段用到的场景/道具/参考图 <Picture N>（如 <Picture 3> 是本段场景参考……）；本段没用到的人物/场景 Picture 不要引用。Picture 编号整个项目全局连续，不因 Segment 重排。\n` +
        `- 每个 Segment 的 subject_definitions 必须包含本段真正需要的：公共人物 <Subject N>、本段场景/道具 Picture、当前 <Audio N>（如实际提供）。\n` +
        `- 导演台连续生成：不使用 <Video N>、不使用 [video continuation]；每个 Segment 一律 [reference generation]；从上一段最后一帧直接继续，禁止动作倒带、禁止恢复默认状态、禁止黑场/淡出（非最终段）、禁止无理由瞬移。\n` +
        `- 字段标题严格用官方英文：subject_definitions: / summary: / retention_analysis: / detailed_description: / overall_soundscape: / non_diegetic_music:；正文用简体中文；技术标签保持英文（<Subject N>、<Picture N>、fully_preserved、[Shot N] At 00:00.000、[reference generation]、<d>[Chinese] ……</d>）。\n` +
        `- 字段名不得翻译/改写，字段顺序不得改变；不得伪造 <Picture N>（场景无参考图时自然语言描述）。\n` +
        `- 非最终 Segment 必须留下清晰动作接口帧（运动矢量+朝向+道具位置），最终段才允许完整收束。\n\n` +
        `# 二、剧情输入（用户提供）\n\n${story}\n\n` +
        searchBlock +
        `\n\n# 三、工作流（必须两轮完成）\n` +
        `第一轮：结合上述要求与检索资料，设计完整连续剧情并输出全部 Segment 的官方六字段（含公共人物绑定区）。\n` +
        `审核轮（重点检查设计合理性，逐项核对）：\n` +
        `① 人物动作：动作是否有物理过程（起始状态→动作发生→动作结果）、是否完成全程、有无"没拿起突然已在嘴边"式跳跃、有无动作倒带/重复执行上一段已完成动作。\n` +
        `② 位置：人物真实世界位置（靠 A/B/C 空间锚点描述）、进出前后是否一致、有无瞬移、人物与道具/场景距离关系是否合理。\n` +
        `③ 镜头：机位是否从上一段机位接力（开头约 0.5–2 秒延续原机位再切换）、Camera Vector 是否与 Character Movement Vector 分离、镜头有没有改变人物真实路径、切点是否在动作进行中。\n` +
        `④ 物理：重心、蹬地方向、朝向角、转身支点（如以左脚为支点旋转约180°）、水渍/破损/妆发等状态是否符合前一帧、重力与时间的物理连续性。\n` +
        `⑤ 其余：再对照「四、六字段格式规范」第五十九节《输出前内部连续性检查》37 项逐项自查（人物资产/时长/首尾接口/状态/空间/场景/声音），并核对格式是否全部符合上述生成要求。\n` +
        `发现任何冲突（如 12 秒超时、Picture 遗漏、字段名松动、动作倒带、位置瞬移、镜头跳切、物理不合理、恢复默认状态），必须先自行重新设计对应 Segment，再输出。\n` +
        `二修轮：修正全部问题后，输出最终版本——只呈现一次完整设计（公共人物绑定: + 各 [Segment N | duration 00:XX.XXX] 六字段），不再保留初审痕迹或检查过程。\n\n` +
        `# 四、六字段格式规范（完整提示词，必须严格遵照）\n\n${H3_PROMPT}`
      )
    },
  })), '@dsh-external/yzh-h3-director: generate tool')
}
