#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gen_quiz.py — 用 OpenAI 兼容 API 批量把章节问答衍生为四选一选择题，写回 data/questions/*.json。

用法:
  python tools/gen_quiz.py --base-url http://127.0.0.1:16869/v1 --model qwen38-9b --api-key none \
      [--chapters 多个章节id] [--limit 20] [--only-missing] [--concurrency 4] [--dry-run]

说明:
  - 生成的 quiz 写入每题的 "quiz" 字段: {stem, options[4], answer(0-3), explain}
  - --only-missing 跳过已有 quiz 的题目（默认 True，--force 才重生成）
  - 断点续跑：逐题落盘，中断后重跑自动跳过已生成的
"""
import argparse
import concurrent.futures
import json
import os
import re
import sys
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
QDIR = os.path.join(ROOT, "data", "questions")

PROMPT = """根据下面的面试题与参考答案，生成一道四选一选择题，考察对核心概念的辨析。要求：干扰项要有迷惑性（常见误解），正确项唯一。严格输出 JSON（不要 markdown 代码块，不要多余文字）：
{{"stem": "题干（可基于原题改写）", "options": ["A内容","B内容","C内容","D内容"], "answer": 0, "explain": "一句话解析（60字内）"}}

面试题：{title}
参考答案：{answer}"""

print_lock = threading.Lock()


def log(msg):
    with print_lock:
        print(msg, flush=True)


def llm_chat(cfg, user_prompt, retries=3):
    body = json.dumps({
        "model": cfg.model,
        "messages": [
            {"role": "system", "content": "你是一位资深 AI 面试题库编纂专家，只输出严格 JSON。"},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.4,
        "max_tokens": 700,
    }).encode()
    req = urllib.request.Request(
        cfg.base_url.rstrip("/") + "/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg.api_key},
    )
    last = None
    for i in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                data = json.loads(r.read().decode())
            return data["choices"][0]["message"]["content"]
        except Exception as e:
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"LLM 请求失败: {last}")


def parse_quiz(text):
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        raise ValueError("未找到 JSON")
    quiz = json.loads(m.group(0))
    opts = quiz.get("options")
    if not isinstance(opts, list) or len(opts) < 2:
        raise ValueError("options 非法")
    quiz["answer"] = max(0, min(len(opts) - 1, int(quiz.get("answer", 0) or 0)))
    quiz["stem"] = str(quiz.get("stem", "")).strip()
    quiz["explain"] = str(quiz.get("explain", "")).strip()
    # 去掉模型自带的 A)/A./A、 选项前缀（UI 已渲染字母标）
    import re as _re
    quiz["options"] = [_re.sub(r"^\s*[A-Da-d]\s*[\)\.．、:：]\s*", "", str(o).strip()).strip() for o in opts]
    return quiz


def load_chapters(ids=None):
    meta = json.load(open(os.path.join(QDIR, "_chapters.json"), encoding="utf-8"))
    chapters = meta["chapters"]
    if ids:
        chapters = [c for c in chapters if c["id"] in ids]
    return chapters


def gen_for_file(cfg, chapter, limit, force):
    path = os.path.join(QDIR, chapter["file"])
    data = json.load(open(path, encoding="utf-8"))
    qs = data.get("questions", [])
    targets = [(i, q) for i, q in enumerate(qs) if force or not q.get("quiz")]
    if limit:
        targets = targets[:limit]
    if not targets:
        log(f"[skip] {chapter['id']}: 无待生成题目")
        return 0, 0
    ok = fail = 0
    for i, q in targets:
        try:
            prompt = PROMPT.format(title=q["title"], answer=q["answer_md"][:3000])
            out = llm_chat(cfg, prompt)
            quiz = parse_quiz(out)
            qs[i]["quiz"] = quiz
            ok += 1
            # 逐题落盘（断点续跑）
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            log(f"  [ok] {q['id']}  {quiz['stem'][:36]}…")
        except Exception as e:
            fail += 1
            log(f"  [fail] {q['id']}: {e}")
    return ok, fail


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--api-key", default="none")
    ap.add_argument("--chapters", nargs="*", help="章节 id 列表（默认全部）")
    ap.add_argument("--limit", type=int, default=0, help="每章最多生成数（0=不限）")
    ap.add_argument("--force", action="store_true", help="重生成已有 quiz")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    chapters = load_chapters(args.chapters)
    print(f"目标章节 {len(chapters)} 个，dry_run={args.dry_run}")
    t_ok = t_fail = 0
    for ch in chapters:
        log(f"[gen] {ch['icon']} {ch['title']} ({ch['count']} 题)")
        if args.dry_run:
            continue
        ok, fail = gen_for_file(args, ch, args.limit, args.force)
        t_ok += ok
        t_fail += fail
    print(f"\n完成：成功 {t_ok}，失败 {t_fail}")


if __name__ == "__main__":
    main()
