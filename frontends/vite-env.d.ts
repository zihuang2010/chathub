/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 聊天附件预览域名前缀;CI 构建期注入,缺省回落 filet.jdd51.com。见 messageHistory.ts。 */
  readonly VITE_CHATHUB_ATTACHMENT_BASE_URL?: string;
}
