# @dsh-external/yzh-h3-director · 妖猪猪H3导演插件

> 仓库已从 dsh-vision-bridge 更名为 **yzh-h3-director**（原项目删除，用户确认）。

妖猪猪H3连续剧情导演插件（工具包形态）。**零 LLM 调用**——插件不做模型推理，只负责「联网检索资料 + 提供六字段规范」，生成由对话推理模型完成。

## 工具（单一流程）

`yzh_h3_director_generate` — 一条流程完成全部准备：

1. **自动识别需检索的角色/设定**：从剧情提取关键词（补充词/地名专名/引号内容/高频专名字串/风格词，如"躲避球弹平"类用户认识但模型不认识的专名会被自动抓出）
2. **联网搜索资料（Scrapling 优先）**：spawn Python 桥 `lib/scrapling_search.py`（[Scrapling](https://github.com/D4Vinci/Scrapling) 反爬抓取：百度→搜狗→必应→DuckDuckGo 多引擎轮询），失败自动回退 Node fetch 多引擎
3. **打包任务包**返回：检索资料 + 剧情输入 + 生成要求（分段/额外要求）+ **官方六字段规范全文**（12893 字）

之后由对话推理模型：分析打磨剧情 → **第一轮**输出六字段 → **对照规范第59节自查**（人物资产/时长/接口帧/状态/空间/场景/声音 37 项）→ **二修** → 输出最终版。

## 参数

| 参数 | 说明 |
|---|---|
| `story` | 必填，你的剧情/故事（角色/场景/梗概，越详细越好） |
| `search_topics` | 可选，补充搜索主题（分号分隔）；不填则插件自动提取 |
| `segments` | 可选，指定 Segment 段数；不填则由 AI 根据剧情自动决定 |

## 使用

提供剧情文本 → 插件自动检索资料 → 对话模型按六字段两次打磨输出。

## 构建与注入

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh   # src/prompt.ts 由技能TXT原封不动生成
# 注入器环境内：dev_inject_plugin / dev_reload_package <本目录>
# 运行时依赖 Scrapling: pip install "scrapling[fetchers]" + scrapling install
```

## 来源

- 提示词：第 17 技能「连续剧情导演版」（官方 Context-IR 六字段修正版），`src/prompt.ts` 由 `连续剧情导演版_最终版.txt` 原封不动生成（MD5 校验一致）
- 检索：Scrapling（反爬优先）+ Node fetch 兜底
