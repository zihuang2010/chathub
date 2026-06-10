// 「另存为」建议文件名清理:服务端下发的附件名可能含 Windows 禁字符(< > : " / \ | ? *)、
// 控制字符或结尾点/空格,直接作 save() 的 defaultPath 会导致对话框异常或落盘失败。
// 统一清理(macOS 也禁 : 与 /),只动"建议名";用户在对话框里自己改名由系统校验。

const ILLEGAL_CHARS = /[<>:"/\\|?*]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

export function sanitizeFileName(name: string | undefined | null): string | undefined {
  if (!name) return undefined;
  const cleaned = name
    .replace(CONTROL_CHARS, "")
    .replace(ILLEGAL_CHARS, "_")
    .replace(/[. ]+$/, "");
  return cleaned.length > 0 ? cleaned : undefined;
}
