# @dsh-external/yzh-h3-director · 妖猪猪H3导演插件

> 仓库已从 dsh-vision-bridge 更名为 **yzh-h3-director**（原项目删除，用户确认）。

妖猪猪H3连续剧情导演插件（工具包形态）。**零 LLM 调用**——插件不做模型推理，只负责「联网检索资料 + 提供影视化/六字段规范」，生成由对话推理模型完成。

## 工具（两个工作流）

### ① `yzh_novel_storyboard` — 前端工作流（网络小说章节影视化）

粘贴一整章网络小说 → 按【影视分镜生成系统提示词 4.0】改编为：
**章节分析 → 【场景01】(场景信息/空间锚点/剧情目标) → 【Segment 01-01】(剧情内容/初始状态/专业分镜 镜头逐个:景别机位运动/时长/画面/动作/表演/对白OS/镜头目的/Segment结束状态/【AI视频剧情提示词】) → 依次到整章结束**（含22节完整性自查）。

| 参数 | 说明 |
|---|---|
| `novel_chapter` | 必填，网络小说一整章原文 |
| `preserve_dialog` | 可选，true=原台词逐字保留 |
| `target_seconds` | 可选，每 Segment 目标秒数（10–15，默认13） |

产出【AI视频剧情提示词】后，直接作为 `story` 投喂 `yzh_h3_director_generate`。

### ② `yzh_h3_director_generate` — 主工作流（连续剧情导演版）

1. **自动识别需检索的角色/设定**：从剧情提取关键词（补充词/地名专名/引号内容/高频专名字串/风格词，如"躲避球弹平"类用户认识但模型不认识的专名会被自动抓出）
2. **联网搜索资料（Scrapling 优先）**：spawn Python 桥 `lib/scrapling_search.py`（[Scrapling](https://github.com/D4Vinci/Scrapling) 反爬抓取：百度→搜狗→必应→DuckDuckGo 多引擎轮询），失败自动回退 Node fetch 多引擎
3. **打包任务包**返回：检索资料 + 剧情输入 + 生成要求（分段/额外要求）+ **官方六字段规范全文**（含第六十一节「稳定复现硬规则」）

之后由对话推理模型：分析打磨剧情 → **第一轮**输出六字段 → **对照规范第59节自查**（人物资产/时长/接口帧/状态/空间/场景/声音 37 项）+ **第61节稳定复现硬规则**（世界坐标系/开局占位/肢体纪律/禁镜面/微动作禁位移/相机接力）→ **二修** → 输出最终版。

| 参数 | 说明 |
|---|---|
| `story` | 必填，剧情文本（角色/场景/梗概；可直接用 novel 工作流的【AI视频剧情提示词】） |
| `search_topics` | 可选，补充搜索主题（分号分隔）；不填则插件自动提取 |
| `segments` | 可选，指定 Segment 段数；不填则由 AI 根据剧情自动决定 |

## 完整使用链路

```
用户发送一章网络小说
  → yzh_novel_storyboard(章节) → 对话模型按4.0规范输出专业分镜(每个Segment带【AI视频剧情提示词】)
  → 取分镜的【AI视频剧情提示词】作为 story
  → yzh_h3_director_generate(story) → 联网检索资料 → 两轮打磨 → 官方六字段最终版
```

## 构建与注入

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh   # src/prompt.ts + src/novel_prompt.ts 由TXT原封不动生成
# 注入器环境内：dev_inject_plugin / dev_reload_package <本目录>
# 运行时依赖 Scrapling: pip install "scrapling[fetchers]" + scrapling install
```

## 来源

- 六字段提示词：第 17 技能「连续剧情导演版」（官方 Context-IR 六字段修正版），`src/prompt.ts` 由 `连续剧情导演版_最终版.txt` 原封不动生成（MD5 校验一致）；v0.0.2 追加第六十一节《稳定复现硬规则》
- 前端工作流提示词：【影视分镜生成系统提示词 4.0】网络小说章节影视化版，`src/novel_prompt.ts` 由 `影视分镜生成系统提示词4.0.txt` 原封不动生成（MD5 校验一致）
- 检索：Scrapling（反爬优先）+ Node fetch 兜底
