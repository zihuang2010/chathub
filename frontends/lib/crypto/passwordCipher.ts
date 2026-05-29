import CryptoJS from "crypto-js";

// 对接业务后台 /account-app/oauth2/token 的 password 字段加密口径:
// AES-128 / CFB / NoPadding,key=iv=Latin1("thanks,pig4cloud") (恰好 16 字节),输出 Base64。
// 与 Web 端 @jdd/crypto 的 encrypt() 等价。固定向量:encryptPassword("123456") === "YehdBPev"。
const KEY = CryptoJS.enc.Latin1.parse("thanks,pig4cloud");
const IV = CryptoJS.enc.Latin1.parse("thanks,pig4cloud");

export function encryptPassword(plain: string): string {
  return CryptoJS.AES.encrypt(plain, KEY, {
    iv: IV,
    mode: CryptoJS.mode.CFB,
    padding: CryptoJS.pad.NoPadding,
  }).toString();
}
