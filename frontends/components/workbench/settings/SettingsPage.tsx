// SettingsPage — 设置页(spec: docs/superpowers/specs/2026-06-11-settings-page-design.md)。
//
// 四个分组:通知 / 消息行为 / 应用与存储 / 高级(默认折叠)。
// 开关与下拉改动即存(乐观更新,失败 toast + store 自动回滚);AI 文本三项用「保存」按钮
// 批量提交,避免逐键打 IPC。设置跟随登录账号,数据源是 useSettingsStore(后端 SQLite 镜像)。

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Bell, ChevronDown, FolderOpen, MessageSquareText, Settings, Trash2 } from "lucide-react";

import { WorkbenchPanel } from "@/components/workbench/WorkbenchPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { showToast } from "@/components/ui/toast";
import {
  useSettingsStore,
  type CloseAction,
  type LogLevel,
  type SettingsPatch,
} from "@/lib/data/settingsStore";
import { isWindows } from "@/lib/platform";
import { cn } from "@/lib/utils";

// ─── 小部件 ──────────────────────────────────────────────────────────────────

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5BAEFF]/40",
        checked ? "bg-[#2563EB]" : "bg-[#D9E1EA]",
      )}
    >
      {/* 滑珠:必须显式锚定 left(absolute 不给锚点时落在按钮内容的「静态位置」,
          各浏览器对 button 的内容排布不一致 → 圆点漂移/被推出轨道,开启态看着像纯色胶囊)。 */}
      <span
        className={cn(
          "absolute left-0.5 top-0.5 size-4 rounded-full bg-white",
          "shadow-[0_1px_2px_rgba(15,40,80,0.25)] ring-1 ring-black/5",
          "transition-transform duration-200",
          checked && "translate-x-4",
        )}
      />
    </button>
  );
}

/** 一行设置项:左侧标题+说明,右侧控件。 */
function SettingRow({
  title,
  desc,
  control,
}: {
  title: string;
  desc?: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-5 py-3.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13.5px] font-medium text-[#1F2937]">{title}</span>
        {desc && <span className="text-[12px] text-[#9CA3AF]">{desc}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}

/** 分组卡片:标题 + 行列表(行间细分隔线)。 */
function SettingGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-[12.5px] font-semibold text-[#6B7280]">{title}</h3>
      <div className="divide-y divide-[#F1F5F9] rounded-xl border border-[#EEF2F7] bg-white">
        {children}
      </div>
    </section>
  );
}

const SELECT_CLS =
  "h-8 rounded-md border border-[#E5EBF2] bg-white px-2 text-[12.5px] text-[#1F2937] " +
  "focus-visible:outline-none focus-visible:border-[#2196FA]";

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 编译期内置 AI 配置(get_ai_defaults):内置 Key 只有"有没有",不含任何片段。 */
interface AiDefaults {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

const EMPTY_AI_DEFAULTS: AiDefaults = { baseUrl: "", model: "", hasApiKey: false };

// ─── 页面 ────────────────────────────────────────────────────────────────────

export function SettingsPage() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  // 改动即存:失败 toast(store 已自动回滚)。
  const apply = useCallback(
    (patch: SettingsPatch) => {
      void update(patch).then((ok) => {
        if (!ok) showToast("设置保存失败,请重试", { type: "error" });
      });
    },
    [update],
  );

  // 高级区折叠
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // 图片缓存占用:进页拉一次,清理后刷新。
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const refreshCacheUsage = useCallback(() => {
    invoke<number>("get_image_cache_usage")
      .then(setCacheBytes)
      .catch(() => setCacheBytes(null));
  }, []);
  useEffect(() => {
    refreshCacheUsage();
  }, [refreshCacheUsage]);

  const clearCache = useCallback(() => {
    setClearing(true);
    invoke<number>("clear_image_cache")
      .then((freed) => {
        showToast(`已清理图片缓存,释放 ${formatMb(freed)}`, { type: "success" });
        refreshCacheUsage();
      })
      .catch(() => showToast("清理缓存失败", { type: "error" }))
      .finally(() => setClearing(false));
  }, [refreshCacheUsage]);

  // 编译期内置 AI 配置:进页拉一次,用于预填与"跟随默认"判定。
  const [aiDefaults, setAiDefaults] = useState<AiDefaults>(EMPTY_AI_DEFAULTS);
  useEffect(() => {
    invoke<AiDefaults>("get_ai_defaults")
      .then((d) => setAiDefaults(d ?? EMPTY_AI_DEFAULTS))
      .catch(() => {});
  }, []);

  // AI 模型/端点输入框预填「生效值」(设置值优先,内置默认兜底);Key 输入框恒空——
  // 后端只回脱敏串,明文不可读,placeholder 提示当前状态,只有真的输入了才进保存 patch。
  // 生效值变化(登录回填/默认值到达/多窗口同步)时在渲染期对齐草稿
  // (React「adjusting state when props change」模式,不走 effect)。
  const effModel = settings.ai.model || aiDefaults.model;
  const effBaseUrl = settings.ai.baseUrl || aiDefaults.baseUrl;
  const [aiBase, setAiBase] = useState({ model: effModel, baseUrl: effBaseUrl });
  const [aiDraft, setAiDraft] = useState({ apiKey: "", model: effModel, baseUrl: effBaseUrl });
  if (aiBase.model !== effModel || aiBase.baseUrl !== effBaseUrl) {
    setAiBase({ model: effModel, baseUrl: effBaseUrl });
    setAiDraft({ apiKey: "", model: effModel, baseUrl: effBaseUrl });
  }
  const aiDirty =
    aiDraft.apiKey.trim() !== "" || aiDraft.model !== effModel || aiDraft.baseUrl !== effBaseUrl;

  // 保存:等于内置默认的值回写空串(保持"跟随默认"语义,内置默认升级时自动跟随);
  // Key 只在用户输入时携带,提交后清空输入框。
  const saveAi = useCallback(() => {
    const followDefault = (value: string, def: string) => {
      const trimmed = value.trim();
      return trimmed === def ? "" : trimmed;
    };
    const ai: NonNullable<SettingsPatch["ai"]> = {
      model: followDefault(aiDraft.model, aiDefaults.model),
      baseUrl: followDefault(aiDraft.baseUrl, aiDefaults.baseUrl),
    };
    if (aiDraft.apiKey.trim()) ai.apiKey = aiDraft.apiKey.trim();
    apply({ ai });
    setAiDraft((d) => ({ ...d, apiKey: "" }));
  }, [aiDraft, aiDefaults, apply]);

  // Key 输入框的状态提示:已设自定义(脱敏串)/ 使用内置 / 未配置。
  const apiKeyPlaceholder = settings.ai.apiKey
    ? `已设自定义 Key(${settings.ai.apiKey}),输入以更换`
    : aiDefaults.hasApiKey
      ? "使用内置 Key,输入以覆盖"
      : "未配置 Key,输入以启用";

  return (
    <WorkbenchPanel>
      <div className="flex h-full min-w-0 flex-1 flex-col bg-[#F8FAFC]">
        <header className="flex min-h-[56px] items-center justify-between border-b border-[#EEF2F7] bg-white px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded bg-[#EFF4FF] text-[#2563EB]">
              <Settings size={16} strokeWidth={1.8} />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[15px] font-semibold text-[#1F2937]">设置</span>
              <span className="text-[12px] text-[#9CA3AF]">偏好跟随当前登录账号</span>
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[640px] flex-col gap-5 px-6 py-5">
            {/* ── 通知 ── */}
            <SettingGroup title="通知">
              <SettingRow
                title="托盘红点提醒"
                desc="有未读消息且窗口未聚焦时,托盘图标闪烁提示"
                control={
                  <Toggle
                    checked={settings.notify.trayFlash}
                    label="托盘红点提醒"
                    onChange={(next) => apply({ notify: { trayFlash: next } })}
                  />
                }
              />
              {isWindows && (
                <SettingRow
                  title="任务栏闪烁"
                  desc="收到新消息且窗口未聚焦时,任务栏按钮持续闪烁"
                  control={
                    <Toggle
                      checked={settings.notify.taskbarFlash}
                      label="任务栏闪烁"
                      onChange={(next) => apply({ notify: { taskbarFlash: next } })}
                    />
                  }
                />
              )}
              <SettingRow
                title="新消息声音提醒"
                desc="窗口未聚焦时收到新消息播放提示音"
                control={
                  <Toggle
                    checked={settings.notify.sound}
                    label="新消息声音提醒"
                    onChange={(next) => apply({ notify: { sound: next } })}
                  />
                }
              />
            </SettingGroup>

            {/* ── 消息行为 ── */}
            <SettingGroup title="消息行为">
              <SettingRow
                title="发送后跳到下一个会话"
                desc="与输入框里的开关一致,两处同步"
                control={
                  <Toggle
                    checked={settings.composer.jumpToNext}
                    label="发送后跳到下一个会话"
                    onChange={(next) => apply({ composer: { jumpToNext: next } })}
                  />
                }
              />
              <SettingRow
                title="静音发送"
                desc="发送消息时不打扰客户(企微静默消息)"
                control={
                  <Toggle
                    checked={settings.composer.silent}
                    label="静音发送"
                    onChange={(next) => apply({ composer: { silent: next } })}
                  />
                }
              />
              <SettingRow
                title="拖拽文件发送"
                desc="拖文件到聊天区即可发送：图片插入输入框，文档作为附件"
                control={
                  <Toggle
                    checked={settings.composer.dragDrop}
                    label="拖拽文件发送"
                    onChange={(next) => apply({ composer: { dragDrop: next } })}
                  />
                }
              />
            </SettingGroup>

            {/* ── 应用与存储 ── */}
            <SettingGroup title="应用与存储">
              <SettingRow
                title="点击关闭按钮时"
                control={
                  <div
                    role="radiogroup"
                    aria-label="点击关闭按钮时"
                    className="flex overflow-hidden rounded-md border border-[#E5EBF2]"
                  >
                    {(
                      [
                        { value: "tray", label: "最小化到托盘" },
                        { value: "quit", label: "直接退出" },
                      ] as { value: CloseAction; label: string }[]
                    ).map(({ value, label }) => {
                      const active = settings.app.closeAction === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          aria-label={label}
                          onClick={() => apply({ app: { closeAction: value } })}
                          className={cn(
                            "px-3 py-1.5 text-[12.5px] transition-colors",
                            active
                              ? "bg-[#EFF4FF] font-medium text-[#2563EB]"
                              : "bg-white text-[#6B7280] hover:bg-[#F8FAFC]",
                          )}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                }
              />
              <SettingRow
                title="图片缓存"
                desc={
                  cacheBytes === null
                    ? "聊天图片与头像的本地缩略图缓存"
                    : `当前占用 ${formatMb(cacheBytes)}`
                }
                control={
                  <>
                    <select
                      aria-label="图片缓存上限"
                      className={SELECT_CLS}
                      value={String(settings.storage.imageCacheMaxMb)}
                      onChange={(e) =>
                        apply({ storage: { imageCacheMaxMb: Number(e.target.value) } })
                      }
                    >
                      <option value="200">上限 200 MB</option>
                      <option value="500">上限 500 MB</option>
                      <option value="1024">上限 1 GB</option>
                      <option value="2048">上限 2 GB</option>
                    </select>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 px-2.5 text-[12.5px]"
                      disabled={clearing}
                      onClick={clearCache}
                    >
                      <Trash2 size={13} />
                      清理缓存
                    </Button>
                  </>
                }
              />
            </SettingGroup>

            {/* ── 高级(默认折叠)── */}
            <section className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setAdvancedOpen((open) => !open)}
                className="flex items-center gap-1 px-1 text-left text-[12.5px] font-semibold text-[#6B7280]"
              >
                高级
                <ChevronDown
                  size={14}
                  className={cn("transition-transform duration-200", advancedOpen && "rotate-180")}
                />
              </button>
              {advancedOpen && (
                <div className="divide-y divide-[#F1F5F9] rounded-xl border border-[#EEF2F7] bg-white">
                  <SettingRow
                    title="AI 润色"
                    desc="模型/端点已预填当前生效值;Key 不可读,仅在输入时更新"
                    control={
                      <Toggle
                        checked={settings.ai.enabled}
                        label="AI 润色"
                        onChange={(next) => apply({ ai: { enabled: next } })}
                      />
                    }
                  />
                  <div className="flex flex-col gap-2.5 px-5 py-3.5">
                    <Input
                      type="password"
                      autoComplete="new-password"
                      aria-label="AI API Key"
                      className="h-9 text-[12.5px]"
                      placeholder={apiKeyPlaceholder}
                      value={aiDraft.apiKey}
                      onChange={(e) => setAiDraft((d) => ({ ...d, apiKey: e.target.value }))}
                    />
                    <div className="flex gap-2.5">
                      <Input
                        aria-label="AI 模型"
                        className="h-9 text-[12.5px]"
                        placeholder="模型"
                        value={aiDraft.model}
                        onChange={(e) => setAiDraft((d) => ({ ...d, model: e.target.value }))}
                      />
                      <Input
                        aria-label="AI 端点"
                        className="h-9 text-[12.5px]"
                        placeholder="端点 URL"
                        value={aiDraft.baseUrl}
                        onChange={(e) => setAiDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                      />
                    </div>
                    {(aiDirty || settings.ai.apiKey) && (
                      <div className="flex justify-end gap-2">
                        {settings.ai.apiKey && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 px-3 text-[12.5px]"
                            onClick={() => apply({ ai: { apiKey: "" } })}
                          >
                            清除自定义 Key
                          </Button>
                        )}
                        {aiDirty && (
                          <Button size="sm" className="h-8 px-3 text-[12.5px]" onClick={saveAi}>
                            保存 AI 配置
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  <SettingRow
                    title="连接静默超时"
                    desc="超过该时长收不到任何数据则自动重连;改动下次重连生效"
                    control={
                      <select
                        aria-label="连接静默超时"
                        className={SELECT_CLS}
                        value={String(settings.net.silenceTimeoutSecs)}
                        onChange={(e) =>
                          apply({ net: { silenceTimeoutSecs: Number(e.target.value) } })
                        }
                      >
                        <option value="30">30 秒</option>
                        <option value="45">45 秒(默认)</option>
                        <option value="60">60 秒</option>
                        <option value="90">90 秒</option>
                        <option value="120">120 秒</option>
                      </select>
                    }
                  />
                  <SettingRow
                    title="日志级别"
                    desc="排障时切「详细」;CHATHUB_LOG 环境变量优先"
                    control={
                      <>
                        <select
                          aria-label="日志级别"
                          className={SELECT_CLS}
                          value={settings.log.level}
                          onChange={(e) => apply({ log: { level: e.target.value as LogLevel } })}
                        >
                          <option value="quiet">精简</option>
                          <option value="default">默认</option>
                          <option value="verbose">详细</option>
                        </select>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1.5 px-2.5 text-[12.5px]"
                          onClick={() => void invoke("open_log_dir").catch(() => {})}
                        >
                          <FolderOpen size={13} />
                          打开日志目录
                        </Button>
                      </>
                    }
                  />
                </div>
              )}
            </section>

            {/* 页脚提示 */}
            <p className="flex items-center gap-1.5 px-1 pb-2 text-[11.5px] text-[#B6C0CC]">
              <Bell size={11} />
              通知与消息行为即时生效
              <MessageSquareText size={11} className="ml-2" />
              切换登录账号后各用各的设置
            </p>
          </div>
        </div>
      </div>
    </WorkbenchPanel>
  );
}
