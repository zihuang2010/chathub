#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
push_test.py — relay 推送场景测试工具

向本地 relay 的 `/rpc/v1/wecomAggregate/notify/push` 推送各类事件，覆盖
MESSAGE_UPSERT / SESSION_SUMMARY_UPSERT 的常见场景。`notifySeq` 跨运行自增
(持久化在脚本旁的 .push_test_state.json，按 employeeId 分别计数)。

铁律(踩过的坑，务必对齐)：
  · 路由只认顶层 employeeId —— 必须等于「客户端当前登录账号」的 employee_id，否则
    relay 扇出 0 路、push 仍返回 code=1 成功，但客户端收不到。
  · conversationId / wecomAccountId 必须属于该登录账号；拿别的账号的会话来推，
    气泡会被「冷会话门控」静默跳过，列表也不会动。
  · sortKey / lastSortKey 前导毫秒必须比该会话本地当前 newest 更大，气泡才落底、
    recents 才不被版本门判 stale。本脚本用单调递增的 epoch-ms 自动保证。
  · 新会话(INSERT)的 external_name / external_avatar 取自 SESSION_SUMMARY 的
    externalName / externalAvatar，缺则显示「(未命名)」/ 空头像(空头像前端只显示名字首字)。
    本脚本 DEFAULTS 已带非空默认；换 --ext 推「另一个人」时，务必同时给 --ext-name/--ext-avatar，
    否则会造出空名空头像的幻影会话。

用法：
  python3 scripts/push_test.py list                 # 列出全部场景
  python3 scripts/push_test.py pair                 # 成对(消息气泡 + 列表摘要)
  python3 scripts/push_test.py msg                  # 仅消息气泡
  python3 scripts/push_test.py summary              # 仅列表摘要(带未读)
  python3 scripts/push_test.py unread --unread 5    # 把未读改成 5
  python3 scripts/push_test.py markread             # 清未读(MARK_READ)
  python3 scripts/push_test.py image                # 图片消息
  python3 scripts/push_test.py video                # 视频消息
  python3 scripts/push_test.py revoke               # 撤回
  python3 scripts/push_test.py outgoing             # 我方发出的消息(direction=1)
  python3 scripts/push_test.py failed               # 发送失败(send_status=4)
  python3 scripts/push_test.py all                  # 顺序跑一遍主要场景

常用选项：
  --employee <id>   顶层 employeeId(路由键，须=登录账号)   默认 2046043266615037952
  --conv <id>       conversationId                          默认 2060616036012523520
  --account <id>    wecomAccountId(须为该账号已绑定企微号)  默认 probina
  --ext <id>        externalUserId
  --ext-name <str>  客户显示名(externalName，非空才写入摘要)   默认非空(过河卒子)
  --ext-avatar <u>  客户头像 URL(externalAvatar，非空才写入摘要) 默认非空(真实 qlogo)
  --text <str>      文本内容
  --unread <n>      未读数(unread/summary/pair 场景用)
  --seq <n>         本次 notifySeq(默认自增，不建议手填)
  --url <url>       push 端点
  --secret <s>      Bearer secret
  --dry             只打印 payload，不发送
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

# 默认对准当前登录账号 lianglei(2046…) 的热会话 probina —— 你换账号/会话时用选项覆盖。
DEFAULTS = {
    "url": "http://127.0.0.1:50052/rpc/v1/wecomAggregate/notify/push",
    "secret": "a8d4f9c7e2b16a3d5f8c9e1b7a4d2c6f9e3a5b7c1d8e2f4a",
    "client_id": "rh_wxchat",
    "employee_id": 2046043266615037952,
    "conversation_id": 2060616036012523520,
    "wecom_account_id": "probina",
    "external_user_id": "wmITqmBgAAiGWefMMXpA2rlA8JgJQJcQ",
    # 默认 ext 是真实「过河卒子」,名字/头像与之自洽 —— 跑默认即产出带名带头像的会话,
    # 不再因缺省制造「(未命名)」+ 空头像(后端语义:summary 的这俩字段非空才覆盖,空则留空)。
    "external_name": "过河卒子",
    "external_avatar": "http://wx.qlogo.cn/mmhead/Q3auHgzwzM5vfzoFQZV0whMcCBXl8gw0zACN1W2aszeqcD6nAuiaTng/0",
}

STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".push_test_state.json")
SEQ_BASE = 1000  # notifySeq 起始(客户端水位早期测试已到 200，留足余量)


# ─── 状态(notifySeq / 单调 ms 自增) ──────────────────────────────────────────
def _load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def _save_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def next_seq(employee_id, override=None):
    """按 employeeId 取下一个 notifySeq；override 时直接用并回写。"""
    state = _load_state()
    key = f"seq:{employee_id}"
    if override is not None:
        seq = int(override)
    else:
        seq = max(state.get(key, SEQ_BASE - 1) + 1, SEQ_BASE)
    state[key] = seq
    _save_state(state)
    return seq


def next_ms():
    """严格单调递增的 epoch-ms，作为 sortKey 前导段(保证比历史更新)。"""
    state = _load_state()
    ms = max(int(time.time() * 1000), int(state.get("last_ms", 0)) + 1)
    state["last_ms"] = ms
    _save_state(state)
    return ms


# ─── 字段助手 ────────────────────────────────────────────────────────────────
def iso(ms):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ms / 1000))


def sort_key(ms, uid):
    # 形如 1780600000000_00000000000005336074_2062129920863109120
    return f"{ms}_{uid % 10**20:020d}_{uid % 10**19:019d}"


def msg_id_from(ms, seq):
    # 唯一且递增的消息 id(19 位以内)
    return ms * 1000 + (seq % 1000)


# ─── 事件构造 ────────────────────────────────────────────────────────────────
def make_message(a, ms, mid, *, direction=2, mtype=1, text="",
                 attachments=None, reason="CUSTOMER_MESSAGE_RECEIVED",
                 send_status=0, fail_reason=None):
    msg = {
        "conversationId": a.conv,
        "wecomAccountId": a.account,
        "externalUserId": a.ext,
        "localMessageId": str(mid),
        "messageDirection": direction,
        "chatMessageType": mtype,
        "contentText": text,
        "sendStatus": send_status,
        "sortKey": sort_key(ms, mid),
        "messageTime": iso(ms),
        "messageTimeMillis": ms,
        "gmtModifiedTime": iso(ms),
    }
    if attachments is not None:
        msg["attachments"] = attachments
    if fail_reason is not None:
        msg["failReason"] = fail_reason
    return {"eventType": "MESSAGE_UPSERT", "eventReason": reason, "message": msg}


def make_summary(a, ms, mid, *, text="", mtype=1, direction=2, unread=0,
                 has_unread=False, reason="CUSTOMER_MESSAGE_RECEIVED"):
    ss = {
        "conversationId": a.conv,
        "wecomAccountId": a.account,
        "externalUserId": a.ext,
        "lastSortKey": sort_key(ms, mid),
        "lastMessageSummary": text,
        "lastMessageType": mtype,
        "lastMessageDirection": direction,
        "lastMessageTime": iso(ms),
        "lastLocalMessageId": str(mid),
        "unreadCount": unread,
        "hasUnread": has_unread,
        "gmtModifiedTime": iso(ms),
    }
    # externalName / externalAvatar 仅「资料变化时」由服务端返回;非空才写,空则保持瘦 payload
    # —— 既对齐线上,也避免把已有行的名字/头像抹空(applier 对空值不覆盖)。新会话 INSERT 时,
    # recents 的 external_name / external_avatar 正取自这里,缺它就只能显示「未命名」/ 空头像
    # (本工具此前的 bug)。脚本 DEFAULTS 已给这俩非空默认,换 --ext 时务必同时给 --ext-name/--ext-avatar。
    ext_name = getattr(a, "ext_name", "")
    if ext_name:
        ss["externalName"] = ext_name
    ext_avatar = getattr(a, "ext_avatar", "")
    if ext_avatar:
        ss["externalAvatar"] = ext_avatar
    return {"eventType": "SESSION_SUMMARY_UPSERT", "eventReason": reason, "sessionSummary": ss}


def image_attachment(a, ms, mid):
    return [{
        "attachmentType": 1,
        "conversationId": a.conv,
        "fileName": f"img-{mid}.jpg",
        "fileSize": 102400,
        "localMessageId": str(mid),
        "ossPreviewFilePath": "https://www.w3school.com.cn/i/eg_tulip.jpg",
        "platformFileUrl": "https://www.w3school.com.cn/i/eg_tulip.jpg",
        "transferStatus": 2,
    }]


def video_attachment(a, ms, mid):
    return [{
        "attachmentType": 4,
        "conversationId": a.conv,
        "durationSeconds": 5,
        "fileName": f"video-{mid}.mp4",
        "fileSize": 319044,
        "localMessageId": str(mid),
        "ossPreviewFilePath": "https://www.w3school.com.cn/example/html5/mov_bbb.mp4",
        "platformFileUrl": "https://www.w3school.com.cn/example/html5/mov_bbb.mp4",
        "transferStatus": 2,
    }]


# ─── 场景:返回 events 列表 ───────────────────────────────────────────────────
def sc_msg(a, ms, mid):
    return [make_message(a, ms, mid, text=a.text or "纯消息气泡(无摘要)")]


def sc_summary(a, ms, mid):
    return [make_summary(a, ms, mid, text=a.text or "仅摘要(列表更新)",
                         unread=a.unread if a.unread is not None else 1,
                         has_unread=(a.unread or 1) > 0)]


def sc_pair(a, ms, mid):
    text = a.text or "成对:消息+摘要"
    unread = a.unread if a.unread is not None else 1
    return [
        make_message(a, ms, mid, text=text),
        make_summary(a, ms, mid, text=text, unread=unread, has_unread=unread > 0),
    ]


def sc_unread(a, ms, mid):
    n = a.unread if a.unread is not None else 5
    return [make_summary(a, ms, mid, text=a.text or f"未读改为 {n}", unread=n, has_unread=n > 0)]


def sc_markread(a, ms, mid):
    # MARK_READ:relay 透传，客户端 recents applier 走 clear_unread 特判清零。
    return [make_summary(a, ms, mid, text=a.text or "已读上报", unread=0,
                         has_unread=False, reason="MARK_READ")]


def sc_image(a, ms, mid):
    text = a.text or "[图片]"
    return [
        make_message(a, ms, mid, mtype=3, text=text, attachments=image_attachment(a, ms, mid)),
        make_summary(a, ms, mid, text=text, mtype=3, unread=1, has_unread=True),
    ]


def sc_video(a, ms, mid):
    text = a.text or "[视频]"
    return [
        make_message(a, ms, mid, mtype=6, text=text, attachments=video_attachment(a, ms, mid)),
        make_summary(a, ms, mid, text=text, mtype=6, unread=1, has_unread=True),
    ]


def sc_revoke(a, ms, mid):
    return [make_message(a, ms, mid, text=a.text or "(已撤回)", reason="MESSAGE_REVOKED")]


def sc_outgoing(a, ms, mid):
    text = a.text or "我方发出的消息"
    return [
        make_message(a, ms, mid, direction=1, text=text, send_status=3),
        make_summary(a, ms, mid, text=text, direction=1),
    ]


def sc_failed(a, ms, mid):
    return [make_message(a, ms, mid, direction=1, text=a.text or "发送失败的消息",
                         send_status=4, reason="SEND_FAILED",
                         fail_reason="MAPPING_NOT_FOUND:test")]


SCENARIOS = {
    "msg": ("仅 MESSAGE_UPSERT(消息气泡，无列表摘要)", sc_msg),
    "summary": ("仅 SESSION_SUMMARY_UPSERT(列表摘要 + 未读)", sc_summary),
    "pair": ("成对:消息气泡 + 列表摘要(最贴近线上)", sc_pair),
    "unread": ("改未读数(--unread N)", sc_unread),
    "markread": ("MARK_READ 清未读", sc_markread),
    "image": ("图片消息(成对)", sc_image),
    "video": ("视频消息(成对)", sc_video),
    "revoke": ("撤回消息(MESSAGE_REVOKED)", sc_revoke),
    "outgoing": ("我方发出的消息(direction=1，成对)", sc_outgoing),
    "failed": ("发送失败(send_status=4)", sc_failed),
}

# all 顺序跑的子集
ALL_SEQUENCE = ["pair", "image", "video", "unread", "markread", "revoke", "outgoing"]


# ─── 发送 ────────────────────────────────────────────────────────────────────
def build_batch(a, seq, events):
    return {
        "protocolVersion": "1.0",
        "notifySeq": seq,
        "clientId": a.client_id,
        "employeeId": a.employee,
        "batchId": f"{a.client_id}:{a.employee}:{seq}",
        "batchTime": time.strftime("%Y-%m-%d %H:%M:%S"),
        "sourceApp": "push_test.py",
        "traceId": f"pushtest:{a.employee}:{seq}",
        "events": events,
    }


def post(a, batch):
    data = json.dumps(batch, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        a.url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {a.secret}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, body
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except urllib.error.URLError as e:
        return None, f"连接失败: {e}"


def run_one(a, name):
    builder = SCENARIOS[name][1]
    seq = next_seq(a.employee, a.seq)
    ms = next_ms()
    mid = msg_id_from(ms, seq)
    events = builder(a, ms, mid)
    batch = build_batch(a, seq, events)

    types = "+".join(e["eventType"].replace("_UPSERT", "") for e in events)
    print(f"\n▶ [{name}] notifySeq={seq} events={types} conv={a.conv} acct={a.account}")
    if a.dry:
        print(json.dumps(batch, ensure_ascii=False, indent=2))
        return
    status, body = post(a, batch)
    # 抽 onlineConnectionCount 给个醒目提示(0 = 客户端没收到，多半 employeeId/在线态对不上)
    occ = None
    try:
        occ = json.loads(body).get("data", {}).get("onlineConnectionCount")
    except Exception:
        pass
    flag = "" if occ in (None, 0) else "  ✅ 已投递"
    if occ == 0:
        flag = "  ⚠️ onlineConnectionCount=0 — 客户端没收到(查 employeeId/在线态)"
    print(f"  HTTP {status}  onlineConnectionCount={occ}{flag}")
    print(f"  {body}")


def main():
    p = argparse.ArgumentParser(description="relay 推送场景测试工具", add_help=True)
    p.add_argument("scenario", nargs="?", default="list",
                   help="场景名(见 list)，或 all / list")
    p.add_argument("--employee", type=int, default=DEFAULTS["employee_id"])
    p.add_argument("--conv", type=int, default=DEFAULTS["conversation_id"])
    p.add_argument("--account", default=DEFAULTS["wecom_account_id"])
    p.add_argument("--ext", default=DEFAULTS["external_user_id"])
    p.add_argument("--ext-name", default=DEFAULTS["external_name"],
                   help="客户显示名(externalName);非空才写入 summary。默认非空，避免新会话显示「未命名」")
    p.add_argument("--ext-avatar", default=DEFAULTS["external_avatar"],
                   help="客户头像 URL(externalAvatar);非空才写入 summary。默认非空，避免新会话空头像")
    p.add_argument("--text", default=None)
    p.add_argument("--unread", type=int, default=None)
    p.add_argument("--seq", type=int, default=None)
    p.add_argument("--url", default=DEFAULTS["url"])
    p.add_argument("--secret", default=DEFAULTS["secret"])
    p.add_argument("--client-id", default=DEFAULTS["client_id"])
    p.add_argument("--dry", action="store_true")
    a = p.parse_args()

    if a.scenario in ("list", "help"):
        print("可用场景：")
        for k, (desc, _) in SCENARIOS.items():
            print(f"  {k:10s} {desc}")
        print(f"\n  {'all':10s} 顺序跑: {', '.join(ALL_SEQUENCE)}")
        print(f"\n当前默认目标: employee={a.employee} conv={a.conv} account={a.account}")
        print("注意: employee 必须=客户端登录账号; conv/account 必须属于该账号。")
        return

    if a.scenario == "all":
        for name in ALL_SEQUENCE:
            run_one(a, name)
            time.sleep(0.3)
        return

    if a.scenario not in SCENARIOS:
        print(f"未知场景: {a.scenario}\n用 `python3 {os.path.basename(__file__)} list` 看全部。")
        sys.exit(1)

    run_one(a, a.scenario)


if __name__ == "__main__":
    main()
