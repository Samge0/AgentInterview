#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
extract_questions.py — 从《AI应用开发面试题 / Agent / RAG》markdown 抽取面试题为章节化 JSON。

源文档三种结构混排：
  A. Agent 主体（L1~5214）：  ## 章节 / ### 问题，答案 = 正文
  B. 网络八股（L5215~5886）：# 问题 / ## 答案小节（顶部有编号清单，忽略）
  C. Python 八股（L5887~末尾）：## 问题 / ### 答案小节

输出：
  data/questions/_chapters.json     章节清单
  data/questions/<chapter_id>.json  每章题目（title + answer 原始 markdown）
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_SRC = r"F:\Space\PRO\other\AgentDoc\AI应用开发面试题 _ Agent _ RAG\AI应用开发面试题 _ Agent _ RAG.md"
OUT_DIR = os.path.join(ROOT, "data", "questions")

CHAPTER_META = {
    # Agent 主体章节按出现顺序的图标/描述（可自行增改）
}

def fix_md(text: str) -> str:
    """去掉飞书导出的转义反斜杠（代码块内保持原样）。"""
    out, inf = [], False
    for line in text.split("\n"):
        if line.strip().startswith("```"):
            inf = not inf
            out.append(line)
            continue
        if not inf:
            line = re.sub(r"\\([+\-_*|#~>$`.\[\]{}()&<>!])", r"\1", line)
        out.append(line)
    return "\n".join(out).strip()


def compute_in_fence(lines):
    state, inf = [], False
    for l in lines:
        if l.strip().startswith("```"):
            state.append(inf)
            inf = not inf
        else:
            state.append(inf)
    return state


def clean_title(t: str) -> str:
    return fix_md(t).strip()


def slugify(title: str, used: set) -> str:
    base = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "-", title).strip("-").lower()
    sid = base[:40] or "chapter"
    n = 2
    while sid in used:
        sid = f"{base[:38]}-{n}"
        n += 1
    used.add(sid)
    return sid


def parse(src_path):
    lines = open(src_path, encoding="utf-8").read().splitlines()
    in_fence = compute_in_fence(lines)

    # ---- 区段边界 ----
    b_start = -1
    for i, l in enumerate(lines):
        if re.match(r"^#\s*\**\s*网络基础八股文", l):
            b_start = i
            break
    c_start = -1
    for i, l in enumerate(lines):
        if re.match(r"^##\s+二、\s*Python", l) or re.match(r"^##\s+Python 相关基础八股文", l):
            c_start = i
            break
    a_end = b_start if b_start >= 0 else (c_start if c_start >= 0 else len(lines))
    b_end = c_start if c_start >= 0 else len(lines)
    c_end = len(lines)

    # ---- 区段 A：## = 章 / ### = 题 ----
    a_chapters = []
    cur_ch = None
    cur_q = None
    for i in range(0, a_end):
        l = lines[i]
        if in_fence[i]:
            if cur_q is not None:
                cur_q["body"].append(l)
            continue
        if re.match(r"^##\s+(?!#)", l):
            if cur_q is not None:
                if cur_ch is None:
                    cur_ch = {"title": "__orphan__", "questions": []}
                    a_chapters.append(cur_ch)
                cur_ch["questions"].append(cur_q)
                cur_q = None
            cur_ch = {"title": clean_title(re.sub(r"^##\s+", "", l)), "questions": []}
            a_chapters.append(cur_ch)
        elif re.match(r"^###\s+(?!#)", l):
            if cur_q is not None:
                if cur_ch is None:
                    cur_ch = {"title": "__orphan__", "questions": []}
                    a_chapters.append(cur_ch)
                cur_ch["questions"].append(cur_q)
            cur_q = {"title": clean_title(re.sub(r"^###\s+", "", l)), "body": []}
        else:
            if cur_q is not None:
                cur_q["body"].append(l)
    if cur_q is not None:
        if cur_ch is None:
            cur_ch = {"title": "__orphan__", "questions": []}
            a_chapters.append(cur_ch)
        cur_ch["questions"].append(cur_q)

    # __orphan__ 章与后续 Agent 基础概念合并去重（孤儿在 main 中单独补采）
    final_a = []
    for ch in a_chapters:
        if ch["title"] == "__orphan__":
            continue
        if not ch["questions"]:
            continue
        final_a.append(ch)

    # ---- 区段 B：# = 题 / ## = 小节 ----
    b_questions = []
    cur_q = None
    for i in range(b_start if b_start >= 0 else 0, b_end):
        l = lines[i]
        if b_start < 0:
            break
        if in_fence[i]:
            if cur_q is not None:
                cur_q["body"].append(l)
            continue
        if re.match(r"^#\s+(?!#)", l):
            title = clean_title(re.sub(r"^#\s+", "", l))
            if "网络基础八股文" in title and len(title) < 15:
                continue  # 区段大标题
            if cur_q is not None:
                b_questions.append(cur_q)
            cur_q = {"title": title, "body": []}
        elif re.match(r"^##\s+(?!#)", l):
            if cur_q is not None:
                cur_q["body"].append("### " + clean_title(re.sub(r"^##\s+", "", l)))
        else:
            if cur_q is not None:
                cur_q["body"].append(l)
    if cur_q is not None:
        b_questions.append(cur_q)

    # ---- 区段 C：## = 题 / ### = 小节 ----
    c_questions = []
    cur_q = None
    for i in range(c_start if c_start >= 0 else len(lines), c_end):
        l = lines[i]
        if c_start < 0:
            break
        if in_fence[i]:
            if cur_q is not None:
                cur_q["body"].append(l)
            continue
        if re.match(r"^##\s+(?!#)", l):
            title = clean_title(re.sub(r"^##\s+", "", l))
            if re.match(r"^[一二三四五六七八九十]、", title) or "八股文" in title:
                continue
            if "全方位深度解析" in title:
                continue
            if cur_q is not None:
                c_questions.append(cur_q)
            cur_q = {"title": title, "body": []}
        elif re.match(r"^###\s+(?!#)", l):
            if cur_q is not None:
                cur_q["body"].append("### " + clean_title(re.sub(r"^###\s+", "", l)))
        else:
            if cur_q is not None:
                cur_q["body"].append(l)
    if cur_q is not None:
        c_questions.append(cur_q)

    return final_a, b_questions, c_questions


ICON_POOL = ["🤖", "🔀", "🧠", "🛠️", "👥", "♻️", "🛡️", "📊", "✍️", "🗄️", "🚀", "🏗️", "🌐", "🐍"]
COLOR_POOL = ["#58cc02", "#1cb0f6", "#ce82ff", "#ff9600", "#ff4b4b", "#2b70c9",
              "#ff86d0", "#00cd9c", "#a5601c", "#9aa0a6"]


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    a, b, c = parse(src)
    os.makedirs(OUT_DIR, exist_ok=True)

    # 清理上一轮生成的章节文件（依据旧 _chapters.json，不动用户自建文件）
    meta_path = os.path.join(OUT_DIR, "_chapters.json")
    if os.path.exists(meta_path):
        try:
            old = json.load(open(meta_path, encoding="utf-8"))
            for m in old.get("chapters", []):
                fp = os.path.join(OUT_DIR, m.get("file", ""))
                if fp and os.path.exists(fp):
                    os.remove(fp)
        except Exception as e:
            print("旧清单读取失败，跳过清理:", e)


    used_ids = set()
    chapters_meta = []
    all_groups = []

    # Agent 主体：开头孤儿题（在第一个 ## 前的 ### 题）已随解析进入首个含题章节？
    # 实际上孤儿题在 cur_ch=None 时被丢弃，这里单独补采：
    # —— 重新快速扫描第一个 ## 前的 ###
    lines = open(src, encoding="utf-8").read().splitlines()
    in_fence = compute_in_fence(lines)
    orphans = []
    first_h2 = next((i for i, l in enumerate(lines) if not in_fence[i] and re.match(r"^##\s+(?!#)", l)), None)
    if first_h2:
        cur = None
        for i in range(0, first_h2):
            l = lines[i]
            if in_fence[i]:
                if cur is not None:
                    cur["body"].append(l)
                continue
            if re.match(r"^###\s+(?!#)", l):
                if cur is not None:
                    orphans.append(cur)
                cur = {"title": clean_title(re.sub(r"^###\s+", "", l)), "body": []}
            else:
                if cur is not None:
                    cur["body"].append(l)
        if cur is not None:
            orphans.append(cur)

    def push_chapter(title, questions, desc=""):
        if not questions:
            return
        sid = slugify(title, used_ids)
        icon = ICON_POOL[len(chapters_meta) % len(ICON_POOL)]
        color = COLOR_POOL[len(chapters_meta) % len(COLOR_POOL)]
        chapters_meta.append({
            "id": sid, "file": f"{sid}.json", "title": title,
            "icon": icon, "color": color, "desc": desc,
            "count": len(questions),
        })
        all_groups.append((sid, questions))

    push_chapter("Agent 基础概念", orphans, "Agent 是什么、与 LLM 的区别、架构与工作模式")
    for ch in a:
        title = re.sub(r"^[\d\.\-]+\s*", "", ch["title"]).strip()
        push_chapter(title, ch["questions"])
    push_chapter("网络基础", b, "HTTP/HTTPS/WebSocket/SSE 等网络八股")
    push_chapter("Python 基础", c, "GIL/协程/装饰器等 Python 八股")

    for sid, questions in all_groups:
        items = []
        for q in questions:
            items.append({
                "id": f"{sid}-{len(items)+1}",
                "title": q["title"],
                "answer_md": fix_md("\n".join(q["body"]).strip()),
                "quiz": None,  # 预生成的四选一选择题（tools/gen_quiz.py 填充）
            })
        data = {"chapter": sid, "updated": "auto", "questions": items}
        with open(os.path.join(OUT_DIR, f"{sid}.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    with open(os.path.join(OUT_DIR, "_chapters.json"), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "chapters": chapters_meta}, f, ensure_ascii=False, indent=2)

    total = sum(m["count"] for m in chapters_meta)
    print(f"章节: {len(chapters_meta)}  总题数: {total}")
    for m in chapters_meta:
        print(f"  {m['icon']} {m['title']:　<14s} {m['count']:3d} 题  -> {m['file']}")


if __name__ == "__main__":
    main()
