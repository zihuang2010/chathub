// Account strings look like "杭州企微-小美"; UIs that show the operator initials
// only want the trailing segment.
export function extractAccountOperator(account: string): string {
  const parts = account.split("-");
  return parts[parts.length - 1] || account;
}

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatMessageDate(sentAt: string): string {
  return dateFormatter.format(new Date(sentAt));
}

export function formatMessageTime(sentAt: string): string {
  return timeFormatter.format(new Date(sentAt));
}

export function formatMessageDateTime(sentAt: string): string {
  return `${formatMessageDate(sentAt)} ${formatMessageTime(sentAt)}`;
}
