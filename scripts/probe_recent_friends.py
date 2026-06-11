#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
probe_recent_friends.py — recentFriends 接口契约探针

用本机已登录客户端的 token(state.sqlite hub_secrets)直连业务后端,拉一页
session/recentFriends,打印字段清单与 clientSilent 分布 —— 用于:
  · 验证 clientSilent / clientSilentReason / clientSilentSource 是否生效、取值分布
  · 排查契约漂移(服务端加减字段客户端 serde 静默忽略,平时不可见)
  · 真机回归静默合并门时,核对服务端打标与客户端门控行为是否一致

前提:本机客户端已登录(token 才有效);token 属当前登录 employee,只能看到该账号的数据。

用法:
  python3 scripts/probe_recent_friends.py                     # 默认拉 200 条看分布
  python3 scripts/probe_recent_friends.py --size 5 --dump     # 拉 5 条并打印首条全字段
  python3 scripts/probe_recent_friends.py --account probina   # 按企微号过滤
  python3 scripts/probe_recent_friends.py --silent-only       # 只打印静默记录明细
"""

import argparse
import json
import os
import sqlite3
import ssl
import sys
import urllib.error
import urllib.request
from collections import Counter

DEFAULT_URL = (
    "https://proxy-dev.jdd51.com"
    "/wechat-business-app/wecom-cs/v1/wecomAggregate/session/recentFriends"
)
DEFAULT_DB = os.path.expanduser(
    "~/Library/Application Support/com.pis0sion.chathub/state.sqlite"
)


def read_token(db_path: str) -> str:
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute("SELECT value FROM hub_secrets WHERE key='token'").fetchone()
    finally:
        conn.close()
    if not row or not row[0]:
        sys.exit(f"[probe] {db_path} 里没有 token —— 请先在客户端登录")
    return row[0]


def main() -> None:
    ap = argparse.ArgumentParser(description="recentFriends 契约探针")
    ap.add_argument("--url", default=DEFAULT_URL, help="接口完整 URL")
    ap.add_argument("--db", default=DEFAULT_DB, help="客户端 state.sqlite 路径")
    ap.add_argument("--size", type=int, default=200, help="拉取条数(默认 200)")
    ap.add_argument("--account", default="", help="wecomAccountId 过滤(默认全部)")
    ap.add_argument("--dump", action="store_true", help="打印首条记录全字段")
    ap.add_argument("--silent-only", action="store_true", help="只打印静默记录明细")
    args = ap.parse_args()

    body = json.dumps(
        {
            "size": args.size,
            "cursor": "",
            "externalName": "",
            "externalMobile": "",
            "wecomAccountId": args.account,
            "onlyUnread": False,
        }
    ).encode()
    req = urllib.request.Request(
        args.url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {read_token(args.db)}",
        },
    )
    # 直连不走系统代理(ALL_PROXY 之类会让 socks5 直连失败)。
    # dev 环境证书链含自签 CA(python.org 版 Python 不读系统钥匙串,curl 能通它不通)→
    # 校验失败时降级跳过校验重试一次,并明确告警(诊断工具,容忍 dev 自签;token 仍只发往指定域名)。
    def fetch(ctx: "ssl.SSLContext | None"):
        handlers = [urllib.request.ProxyHandler({})]
        if ctx is not None:
            handlers.append(urllib.request.HTTPSHandler(context=ctx))
        with urllib.request.build_opener(*handlers).open(req, timeout=30) as resp:
            return json.load(resp)

    try:
        payload = fetch(None)
    except urllib.error.URLError as e:
        if "CERTIFICATE_VERIFY_FAILED" not in str(e):
            raise
        print("⚠️  证书校验失败(dev 自签链),已降级跳过校验重试", file=sys.stderr)
        insecure = ssl.create_default_context()
        insecure.check_hostname = False
        insecure.verify_mode = ssl.CERT_NONE
        payload = fetch(insecure)

    recs = payload.get("data", {}).get("records") or []
    print(f"记录数: {len(recs)}")
    if not recs:
        return

    keys = list(recs[0].keys())
    print(f"字段清单({len(keys)}): {', '.join(keys)}")
    missing = [k for k in ("clientSilent", "clientSilentReason", "clientSilentSource") if k not in keys]
    if missing:
        print(f"⚠️  缺少静默字段: {missing}(契约漂移?)")

    dist = Counter(bool(r.get("clientSilent")) for r in recs)
    print(f"clientSilent 分布: silent={dist.get(True, 0)}  normal={dist.get(False, 0)}")
    reasons = Counter(r.get("clientSilentReason") or "-" for r in recs if r.get("clientSilent"))
    if reasons:
        print(f"reason 分布: {dict(reasons)}")
    sources = Counter(r.get("clientSilentSource") or "-" for r in recs if r.get("clientSilent"))
    if sources:
        print(f"source 分布: {dict(sources)}")

    if args.dump:
        print("\n首条记录:")
        for k, v in recs[0].items():
            print(f"  {k} = {v!r}")
    if args.silent_only:
        for r in recs:
            if r.get("clientSilent"):
                print(
                    f"  静默: conv={r.get('conversationId')} ext={r.get('externalName')!r} "
                    f"reason={r.get('clientSilentReason')} source={r.get('clientSilentSource')} "
                    f"summary={str(r.get('lastMessageSummary', ''))[:30]!r}"
                )


if __name__ == "__main__":
    main()
