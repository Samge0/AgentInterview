#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
apply_gen_quizzes.py — 把前端导出的 gen-quizzes.json 合并回 data/questions/*.json。

用法:
  python tools/apply_gen_quizzes.py [gen-quizzes.json 路径]   # 默认当前目录 gen-quizzes.json
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
QDIR = os.path.join(ROOT, "data", "questions")


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.getcwd(), "gen-quizzes.json")
    bundle = json.load(open(src, encoding="utf-8"))
    meta = json.load(open(os.path.join(QDIR, "_chapters.json"), encoding="utf-8"))
    file_of = {c["id"]: c["file"] for c in meta["chapters"]}
    total = merged = 0
    for cid, items in bundle.get("chapters", {}).items():
        if cid not in file_of:
            print(f"[skip] 未知章节 {cid}")
            continue
        path = os.path.join(QDIR, file_of[cid])
        data = json.load(open(path, encoding="utf-8"))
        idx = {q["id"]: i for i, q in enumerate(data["questions"])}
        for it in items:
            total += 1
            qid, quiz = it.get("id"), it.get("quiz")
            if qid in idx and quiz:
                data["questions"][idx[qid]]["quiz"] = quiz
                merged += 1
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"[ok] {cid}: 合并 {len(items)} 项 -> {file_of[cid]}")
    print(f"\n完成：共 {total} 项，合并 {merged} 项")


if __name__ == "__main__":
    main()
