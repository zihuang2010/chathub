// Centralized user-visible strings for the messages page. Wrap calls in a
// future i18n library by replacing the consumer call sites with `t(key)`.

export const STRINGS = {
  header: {
    voiceCall: "语音通话",
    videoCall: "视频通话",
    addToGroup: "加入群聊",
    library: "资料库",
    more: "更多",
    fromWeChat: "@微信",
    fromAccountLabel: "归属于：",
  },
  rangePill: {
    currentRange: "当前范围",
    allAccountsBare: "全部账号",
    allAccounts: (n: number) => `全部账号 (${n})`,
    selectAccount: "选择账号范围",
    clearFilter: "清除筛选",
  },
  conversationList: {
    searchPlaceholder: "搜索客户/账号",
    /** 客户搜索框占位(只按名字搜客户)。 */
    contactSearchPlaceholder: "搜索客户",
    /** 搜索下拉的分组标题。 */
    contactGroup: "联系人",
    /** 搜索下拉:正在请求 list_friends。 */
    contactSearching: "搜索中…",
    /** 搜索下拉:无匹配客户。 */
    contactEmpty: "未找到客户",
    /** 清空搜索框的无障碍标签。 */
    clearSearch: "清空搜索",
    /** 点击搜索结果打开会话失败(网络/服务端异常)时的提示。 */
    openConversationFailed: "打开会话失败,请重试",
    filter: "筛选",
    accountFallback: "全部账号",
    statusAll: "全部",
    statusUnread: "未读",
    statusMentioned: "@我",
    fromShort: "来自: ",
    noConversation: "暂无匹配会话",
    accountFilterTitle: "按账号筛选",
    statusTabsLabel: "会话状态筛选",
    accountListLabel: "账号列表",
    unreadCount: (n: number) => `${n > 99 ? "99+" : n} 条未读`,
    /** 接待列表行 preview 区的"未读"语义前缀,与 draftPrefix 同 rose-500 样式。
     *  仅在 unread > 0 且无草稿时显示;与右下角红色数字徽标互补:文字表状态,数字表量级。 */
    unreadPrefix: "[未读]",
    /** 接待列表行的"草稿"前缀。当 conversation.draftText 非空时,preview 区显示。 */
    draftPrefix: "[草稿]",
    /** 接待列表行右键菜单的"置顶"操作文案。 */
    contextPin: "置顶会话",
    /** 接待列表行右键菜单的"取消置顶"操作文案。 */
    contextUnpin: "取消置顶",
    /** 接待列表行右键菜单的"移除会话"操作文案。V11 后端持久化软删除,新消息严格晚于 removed_at_ms 时自动恢复。 */
    contextRemove: "移除会话",
    /** 接待列表行右键菜单的"消息免打扰"操作文案。V12 后端持久化本地列。 */
    contextMute: "消息免打扰",
    /** 接待列表行右键菜单的"取消免打扰"操作文案。 */
    contextUnmute: "取消免打扰",
    /** 免打扰会话有未读时,preview 前缀显示条数(替代 [未读])。 */
    mutedCountPrefix: (n: number) => `[${n > 99 ? "99+" : n}条]`,
  },
  status: {
    unreadDivider: (n: number) => `以下为未读消息 (${n})`,
    sending: "发送中",
    failed: "发送失败",
    selfSenderName: "我",
    recalledPlaceholder: "(已撤回)",
    scrollToBottom: "回到底部",
    newMessagesBelow: (n: number) => `${n > 99 ? "99+" : n} 条新消息`,
    /** 顶部浮动 pill,提示视口上方还有未读;点击跳到 UnreadDivider。 */
    unreadAbove: (n: number) => `↑ ${n > 99 ? "99+" : n} 条未读`,
    /** 顶部浮动 pill,向上翻历史时加载更早消息的状态文案(带 spinner)。 */
    loadingHistory: "加载更早的消息",
    recalledByMe: "你撤回了一条消息",
    recalledByPeer: "对方撤回了一条消息",
  },
  contextMenu: {
    copy: "复制",
    reply: "引用回复",
    recall: "撤回",
    delete: "删除",
    /** 删除前的二次确认(删除当前仅本地隐藏,重读历史可能补回,故用中性措辞)。 */
    deleteConfirm: "确定删除这条消息?",
  },
  toast: {
    copySuccess: "已复制到剪贴板",
    copyFailed: "复制失败",
    /** 撤回当前仅改本地视图、未接后端,故用中性「本地」措辞,不承诺服务端已生效。
     *  接后端后改回成功/失败二态(recallFailed)。 */
    recallLocalOnly: "已在本地撤回",
    recallFailed: "撤回失败,请稍后再试",
    actionDismiss: "关闭",
    screenshotFailed: "截图失败",
    screenshotEmpty: "截图结果为空",
    screenshotPermissionHint: "如在 macOS 中首次使用，请在系统设置中允许 ChatHub 录制屏幕后重试",
    screenshotPasteHint:
      "请使用系统截图（Win+Shift+S / Cmd+Shift+Ctrl+4），然后在输入框按 Ctrl/Cmd+V 粘贴",
    // 企微语音仅支持 AMR-NB 且时长 ≤60s / 体积 ≤2MB,超限或转码失败时提示。
    voiceTooLong: "语音超过 60 秒或体积过大，无法作为语音发送",
    voiceTranscodeFailed: "语音转码失败，请换一段或改用文件发送",
  },
  errors: {
    pageUnavailable: "消息页暂时不可用",
    loadFailed: "消息加载失败",
    retry: "重试",
    sendFailed: "发送失败",
    resend: "重发",
    unknownError: "出错了",
  },
  empty: {
    noMessages: "暂无消息",
    startChat: "向客户发送一条消息开始沟通",
    loading: "正在加载消息…",
  },
  attachment: {
    download: "下载",
    play: "播放",
    pause: "暂停",
    image: "图片",
    file: "文件",
    voice: "语音",
    video: "视频",
    voiceDuration: (sec: number) => `${sec}″`,
    imageAlt: (name?: string) => name ?? "图片附件",
    openImage: "查看大图",
    imageLoadFailed: "图片加载失败",
  },
  composer: {
    placeholder: "请输入消息",
    quickReplies: "快捷回复",
    polishTitle: "AI 润色",
    polishTones: {
      formal: "正式",
      warm: "亲切",
      humor: "幽默",
      concise: "简洁",
    },
    aiPolishEmptyHint: "请先输入需要润色的内容",
    polishOriginal: "原文",
    polishPreview: "润色预览",
    polishCancel: "取消",
    polishApply: "替换草稿",
    send: "发送",
    sendOptions: "发送选项",
    sendImmediately: "立即发送",
    sendSchedule: "定时发送…",
    sendSilent: "静默发送",
    sendJumpToNext: "发送后跳到下一条",
    sendSilentMain: "静默发送",
    charCount: (n: number) => `${n} 字`,
    charLimitNear: "接近字数上限",
    charLimitOver: "已超过字数上限，无法发送",
    enterToSend: "Enter 发送 · Shift+Enter 换行",
    expandRight: "展开右栏",
    collapseRight: "收起右栏",
    emoji: "表情",
    screenshot: "截图",
    image: "图片",
    file: "文件",
    moreTools: "更多",
    removeAttachment: "移除附件",
    resizeHandle: "调整消息编辑区高度",
    emojiPickerLabel: "选择表情",
    mentionListLabel: "选择联系人",
    cancelReply: "取消引用",
  },
  customerDetails: {
    tabsLabel: "客户详情视图",
    tabProfile: "客户资料",
    tabReplies: "快捷回复",
    tabTrace: "客户轨迹",
    addTag: "添加标签",
    expandMore: "展开更多",
    fromAccountBadge: "来自账号",
    refresh: "刷新客户资料",
    fields: {
      remark: "备注",
      phone: "手机",
      weChat: "微信号",
      company: "所属企业",
      source: "客户来源",
      addedAt: "添加时间",
      follower: "跟进人",
    },
    quickReplies: {
      title: "快捷回复",
      add: "新增",
      addAriaLabel: "新增快捷回复",
      searchPlaceholder: "搜索快捷回复",
      editAriaLabel: (title: string) => `编辑 ${title}`,
      deleteAriaLabel: (title: string) => `删除 ${title}`,
      titlePlaceholder: "标题(如:欢迎语)",
      contentPlaceholder: "回复内容",
      save: "保存",
      cancel: "取消",
      delete: "删除",
      empty: "暂无快捷回复",
    },
    emptyReplies: "暂无快捷回复",
    emptyTrace: "暂无客户轨迹",
  },
  resize: {
    listHandle: "调整会话列表宽度",
  },
} as const;
