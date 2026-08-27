# -*- coding: utf-8 -*-
"""Scrapling 搜索桥 — 供 yzh-h3-director 插件调用 (优先通道)
用法: python scrapling_search.py "<query>" [max_results]
输出: JSON [{"title":..., "url":..., "snippet":...}, ...]
引擎(由主到次): 百度(中文专名优) → 搜狗 → 必应 → DDG; 全部用 Scrapling 抓取
"""
import sys, json, re, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

def clean(s):
    if not s: return ""
    s = re.sub(r'<[^>]+>', ' ', s)
    for e, r in [('&nbsp;',' '),('&amp;','&'),('&lt;','<'),('&gt;','>'),('&quot;','"'),('&#x27;',"'"),('&#39;',"'"),('&mdash;','—')]:
        s = s.replace(e, r)
    return re.sub(r'\s+', ' ', s).strip()

def body_str(page):
    b = page.body if hasattr(page, 'body') else page
    if isinstance(b, bytes):
        try: return b.decode('utf-8', errors='replace')
        except Exception:
            try: return b.decode('gbk', errors='replace')
            except Exception: return str(b)
    return str(b)

def parse_baidu(html):
    out = []
    # <h3 ...><a href="URL" ...>TITLE</a></h3>  + 摘要 span class="content-right_8Zs40" 或 div class="c-abstract"
    for blk in re.findall(r'<h3[\s\S]*?</h3>', html):
        m = re.search(r'<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>', blk)
        if not m: continue
        title = clean(m.group(2))
        if not title: continue
        out.append({"title": title, "url": m.group(1), "snippet": ""})
        if len(out) >= 12: break
    # 摘要补全: c-abstract / content-right
    if out:
        abs_ = re.findall(r'class="[^"]*(?:c-abstract|content-right)[^"]*"[^>]*>([\s\S]*?)</(?:div|span)>', html)
        for i, a in enumerate(abs_[:len(out)]):
            s = clean(a)
            if s: out[i]["snippet"] = s[:260]
    return out

def parse_sogou(html):
    out = []
    for blk in re.findall(r'<div class="vrwrap"[\s\S]*?</div>', html):
        m = re.search(r'<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>', blk)
        if not m: continue
        title = clean(m.group(2))
        if not title: continue
        sm = re.search(r'<p class="str_info"[^>]*>([\s\S]*?)</p>', blk) or re.search(r'<div class="str_info"[^>]*>([\s\S]*?)</div>', blk)
        out.append({"title": title, "url": m.group(1), "snippet": clean(sm.group(1))[:260] if sm else ""})
        if len(out) >= 12: break
    return out

def parse_bing(html):
    out = []
    for blk in re.findall(r'<li class="b_algo"[\s\S]*?</li>', html):
        m = re.search(r'<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>', blk)
        if not m: continue
        title = clean(m.group(2))
        if not title: continue
        sm = re.search(r'<div class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)</p>', blk)
        out.append({"title": title, "url": m.group(1), "snippet": clean(sm.group(1))[:260] if sm else ""})
        if len(out) >= 12: break
    return out

def parse_ddg(html):
    out = []
    blocks = re.findall(r'<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>', html)
    snips = re.findall(r'class="result__snippet"[^>]*>([\s\S]*?)</a>', html)
    for i, (href, title) in enumerate(blocks):
        t = clean(title)
        if not t: continue
        u = href
        m = re.search(r'uddg=([^&]+)', href)
        if m:
            from urllib.parse import unquote
            try: u = unquote(m.group(1))
            except Exception: u = href
        out.append({"title": t, "url": u, "snippet": (clean(snips[i]) if i < len(snips) else "")[:260]})
        if len(out) >= 12: break
    return out

def _fetch(url):
    from scrapling.fetchers import Fetcher
    page = Fetcher.get(url, impersonate='chrome', timeout=20, stealthy_headers=True)
    return body_str(page)

def search(q, maxn):
    from urllib.parse import quote
    engines = [
        ("baidu", lambda: _fetch('https://www.baidu.com/s?wd=' + quote(q) + '&rn=10'), parse_baidu),
        ("sogou", lambda: _fetch('https://www.sogou.com/web?query=' + quote(q)), parse_sogou),
        ("bing", lambda: _fetch('https://www.bing.com/search?q=' + quote(q) + '&mkt=zh-CN&cc=cn&count=10'), parse_bing),
        ("ddg", lambda: _fetch('https://html.duckduckgo.com/html/?q=' + quote(q) + '&kl=cn-zh&kp=-1'), parse_ddg),
    ]
    errors = []
    for name, get, parse in engines:
        try:
            html = get()
            res = parse(html)
            if res:
                return res, name
            errors.append(name + ':空')
        except Exception as e:
            errors.append(name + ':' + str(e)[:60])
    return [], "|".join(errors)

def main():
    if len(sys.argv) < 2:
        print(json.dumps([], ensure_ascii=False)); return
    q = sys.argv[1].strip()
    maxn = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    results, info = search(q, maxn)
    print(json.dumps(results[:maxn], ensure_ascii=False))

if __name__ == '__main__':
    main()
