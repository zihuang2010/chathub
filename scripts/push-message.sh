#!/usr/bin/env bash
# 本地联调:向 relay push 口模拟「业务后台 → 客户端」的 MESSAGE_UPSERT 通知。
# 自动递增 notifySeq、自动生成 localMessageId/sortKey/时间,只需填会话三元组。
#
# 前置:
#   scripts/run-mock-downstream.sh   # 终端 1(employeeId 默认 1234)
#   scripts/run-relay-local.sh       # 终端 2(push=127.0.0.1:50052, secret=push-secret)
#   客户端登录并【打开】目标会话(气泡只进热会话;冷会话只动左侧列表摘要)
#
# 用法:
#   scripts/push-message.sh -c <conversationId> -a <wecomAccountId> -x <externalUserId>
#   scripts/push-message.sh -c c1 -a wa-1 -x ext-1 -t "在吗?在吗?"
#   scripts/push-message.sh -c c1 -a wa-1 -x ext-1 -d 1 -t "我方回复"   # 1=我方发送(out)
#   scripts/push-message.sh -c c1 -a wa-1 -x ext-1 --summary           # 同 batch 带列表摘要
#   CONV=c1 ACCT=wa-1 EXT=ext-1 scripts/push-message.sh                # 三元组也可走 env
#
# 参数:
#   -c  conversationId(必填,或 env CONV)
#   -a  wecomAccountId(必填,或 env ACCT)
#   -x  externalUserId(必填,或 env EXT)
#   -t  正文文本(默认 "你好,在吗?")
#   -d  messageDirection:1=我方发送 2=客户消息(默认) 3=多端同步
#   -E  employeeId(默认 ${MOCK_USER_ID:-1234})
#   --summary    同 batch 追加 SESSION_SUMMARY_UPSERT(左侧接待列表也刷新)
#   --seq N      指定 notifySeq(默认按 epoch 秒自增,保证单调)
#   -u N         unreadCount 覆盖(仅 --summary 生效)。默认按会话自动累计:
#                dir=2 每推 +1、dir=1/3 归 0;客户端按规范只能覆盖未读(§9.3),由 mock 模拟累计。
#
# 依赖:jq、curl。secret/地址从环境或 scripts/.env.local 读,缺省 push-secret / 127.0.0.1:50052。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.local"
if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  set -a; source "${ENV_FILE}"; set +a
fi

command -v jq   >/dev/null || { echo "需要 jq:brew install jq" >&2; exit 1; }
command -v curl >/dev/null || { echo "需要 curl" >&2; exit 1; }

# ── 默认值(对齐 run-relay-local.sh / run-mock-downstream.sh)──
CONV="${CONV:-}"
ACCT="${ACCT:-}"
EXT="${EXT:-}"
TEXT="你好,在吗?"
DIR=2
EMP="${MOCK_USER_ID:-1234}"
WITH_SUMMARY=0
SEQ_OVERRIDE=""
UNREAD_OVERRIDE=""
PUSH_ADDR="${RELAY_PUSH_ADDR:-127.0.0.1:50052}"
SECRET="${RELAY_PUSH_SECRET:-push-secret}"
CLIENT_ID="${RELAY_PUSH_CLIENT_ID:-rh_wxchat}"

# ── 解析参数 ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    -c) CONV="$2"; shift 2 ;;
    -a) ACCT="$2"; shift 2 ;;
    -x) EXT="$2";  shift 2 ;;
    -t) TEXT="$2"; shift 2 ;;
    -d) DIR="$2";  shift 2 ;;
    -E) EMP="$2";  shift 2 ;;
    --summary) WITH_SUMMARY=1; shift ;;
    --seq) SEQ_OVERRIDE="$2"; shift 2 ;;
    -u|--unread) UNREAD_OVERRIDE="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数:$1(-h 看用法)" >&2; exit 1 ;;
  esac
done

[[ -n "$CONV" && -n "$ACCT" && -n "$EXT" ]] || {
  echo "缺会话三元组。示例:scripts/push-message.sh -c c1 -a wa-1 -x ext-1" >&2
  echo "(也可 export CONV/ACCT/EXT)" >&2
  exit 1
}

# ── notifySeq 单调自增:以 epoch 秒为底(天然 > 客户端早期小水位),per-employee 持久化 ──
SEQ_FILE="${SCRIPT_DIR}/.push-seq-${EMP}"
if [[ -n "$SEQ_OVERRIDE" ]]; then
  SEQ="$SEQ_OVERRIDE"
else
  NOW_S="$(date +%s)"
  LAST="$(cat "$SEQ_FILE" 2>/dev/null || echo 0)"
  if [[ "$NOW_S" -gt "$LAST" ]]; then SEQ="$NOW_S"; else SEQ="$((LAST + 1))"; fi
fi
echo "$SEQ" > "$SEQ_FILE"

# ── 生成消息字段 ──
LM="LM_${SEQ}"
NOW_MS="$(( $(date +%s) * 1000 ))"
PADDED="$(printf '%020d' "$SEQ")"
SORT_KEY="${NOW_MS}:${DIR}:${PADDED}:${LM}"
MSG_TIME="$(date +"%Y-%m-%d %H:%M:%S")"
BATCH_ID="${CLIENT_ID}:${EMP}:${SEQ}"
# 客户消息(2)无需发送状态;我方发送/同步(1/3)记成功(3)。
if [[ "$DIR" == "2" ]]; then SEND_STATUS=0; else SEND_STATUS=3; fi

# ── 未读累计:客户端按规范只能覆盖未读(§9.3「不在客户端自增自减未读数」),故由 mock 端
# 模拟服务端的累计口径。仅 --summary 时有意义(未读随 SESSION_SUMMARY_UPSERT 下发)。
# 按 (employee, conversation) 持久化:dir=2(客户消息)自增,dir=1/3(我方/多端同步)归 0;
# -u N 覆盖并作为新基线(下一条 dir=2 从 N+1 续)。
if [[ "$WITH_SUMMARY" == "1" ]]; then
  CONV_SAFE="$(printf '%s' "$CONV" | tr -c 'A-Za-z0-9._-' '_')"
  UNREAD_FILE="${SCRIPT_DIR}/.push-unread-${EMP}-${CONV_SAFE}"
  if [[ -n "$UNREAD_OVERRIDE" ]]; then
    UNREAD="$UNREAD_OVERRIDE"
  elif [[ "$DIR" == "2" ]]; then
    UNREAD="$(( $(cat "$UNREAD_FILE" 2>/dev/null || echo 0) + 1 ))"
  else
    UNREAD=0
  fi
  echo "$UNREAD" > "$UNREAD_FILE"
else
  UNREAD=0
fi

# ── 用 jq 安全拼 events[](自动转义文本)──
MESSAGE_EVENT="$(jq -n \
  --arg conv "$CONV" --arg acct "$ACCT" --arg ext "$EXT" \
  --arg lm "$LM" --argjson dir "$DIR" --argjson st "$SEND_STATUS" \
  --arg sk "$SORT_KEY" --arg mt "$MSG_TIME" --arg text "$TEXT" \
  '{
    eventType: "MESSAGE_UPSERT",
    eventReason: (if $dir == 2 then "CUSTOMER_MESSAGE_RECEIVED"
                  elif $dir == 3 then "MULTI_DEVICE_SYNCED"
                  else "SEND_CONFIRMED" end),
    conversationId: $conv, wecomAccountId: $acct, externalUserId: $ext,
    eventTime: $mt,
    message: {
      localMessageId: $lm, messageDirection: $dir, messageType: 1,
      messageStatus: 0, sendStatus: $st, sequenceSource: "PLATFORM_SEQ",
      sortKey: $sk, messageTime: $mt,
      contentText: $text, contentSummary: $text, attachments: []
    }
  }')"

EVENTS="$(jq -n --argjson m "$MESSAGE_EVENT" '[$m]')"

if [[ "$WITH_SUMMARY" == "1" ]]; then
  SUMMARY_EVENT="$(jq -n \
    --arg conv "$CONV" --arg acct "$ACCT" --arg ext "$EXT" \
    --arg lm "$LM" --argjson dir "$DIR" --argjson st "$SEND_STATUS" \
    --arg sk "$SORT_KEY" --arg mt "$MSG_TIME" --arg text "$TEXT" \
    --argjson unread "$UNREAD" \
    '{
      eventType: "SESSION_SUMMARY_UPSERT",
      eventReason: "LAST_MESSAGE_CHANGED",
      conversationId: $conv, wecomAccountId: $acct, externalUserId: $ext,
      eventTime: $mt,
      sessionSummary: {
        lastLocalMessageId: $lm, lastMessageType: 1, lastMessageDirection: $dir,
        lastSendStatus: $st, lastMessageSummary: $text, lastMessageTime: $mt,
        lastSortKey: $sk,
        unreadCount: $unread,
        hasUnread: ($unread > 0)
      }
    }')"
  EVENTS="$(jq -n --argjson m "$MESSAGE_EVENT" --argjson s "$SUMMARY_EVENT" '[$m, $s]')"
fi

BODY="$(jq -n \
  --argjson seq "$SEQ" --arg cid "$CLIENT_ID" --argjson emp "$EMP" \
  --arg bid "$BATCH_ID" --arg bt "$MSG_TIME" --argjson events "$EVENTS" \
  '{ notifySeq: $seq, clientId: $cid, employeeId: $emp,
     batchId: $bid, batchTime: $bt, events: $events }')"

URL="http://${PUSH_ADDR}/rpc/v1/wecomAggregate/notify/push"
echo "[push] → ${URL}"
echo "[push] notifySeq=${SEQ} employeeId=${EMP} dir=${DIR} conv=${CONV} text=\"${TEXT}\"$([[ $WITH_SUMMARY == 1 ]] && echo " (+summary unread=${UNREAD})")"

if ! RESP="$(curl -sS --noproxy '*' -X POST "$URL" \
  -H "Authorization: Bearer ${SECRET}" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  -w $'\n__HTTP__%{http_code}')"; then
  echo "[push] curl 失败:relay 没起?先跑 scripts/run-relay-local.sh(push=${PUSH_ADDR})" >&2
  exit 1
fi

CODE="${RESP##*__HTTP__}"
echo "[push] HTTP ${CODE}  ${RESP%$'\n'__HTTP__*}"
[[ "$CODE" == "200" ]] || { echo "[push] 非 200:检查 secret(${SECRET})/clientId(${CLIENT_ID})白名单/employeeId" >&2; exit 1; }
