import { STRINGS } from "./strings";

export function WeChatBadge() {
  return (
    <span
      aria-label={STRINGS.status.weChatBadge}
      className="grid size-4 shrink-0 place-items-center rounded bg-workbench-wechat-bg text-workbench-wechat"
    >
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="size-[13px]"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M6.7 3.2C3.9 3.2 1.8 4.8 1.8 6.9c0 1.2.7 2.2 1.8 2.9l-.4 1.3 1.5-.8c.6.2 1.2.3 2 .3 2.8 0 4.9-1.6 4.9-3.7S9.5 3.2 6.7 3.2Z"
          fill="currentColor"
          opacity="0.95"
        />
        <path
          d="M9.8 6.6c2.4 0 4.4 1.4 4.4 3.3 0 1-.6 1.9-1.5 2.5l.3 1.1-1.3-.7c-.5.2-1.1.3-1.8.3-2.4 0-4.4-1.4-4.4-3.2 0-1.9 1.9-3.3 4.3-3.3Z"
          fill="currentColor"
          opacity="0.55"
        />
        <circle cx="5.1" cy="6.5" r="0.45" fill="white" />
        <circle cx="8" cy="6.5" r="0.45" fill="white" />
      </svg>
    </span>
  );
}
