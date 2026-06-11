// notificationSound — 新消息提示音。复用单个 <audio> 元素(避免每次新建解码),
// 播放失败(资源缺失 / 自动播放策略 / 非浏览器环境)一律静默忽略,绝不影响消息链路。

let audio: HTMLAudioElement | null = null;

export function playNotificationSound(): void {
  try {
    if (typeof Audio === "undefined") return;
    if (!audio) {
      audio = new Audio("/sounds/notify.wav");
      audio.volume = 0.55;
    }
    audio.currentTime = 0;
    void audio.play().catch(() => {});
  } catch {
    // ignore — 提示音是锦上添花,任何异常都不应外溢
  }
}
