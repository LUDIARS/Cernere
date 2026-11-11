/**
 * V.O.B の Discord 発行リンク (`/start?vob=<token>`) からトークンを読む。
 * 形式に合わないものは無かったことにする (server 側でも検証する)。
 * @implements SPEC-VOB-DISCORD-REGISTRATION
 */
export const VOB_PARAM = "vob";

export function readVobToken(search: string): string | null {
  const value = new URLSearchParams(search).get(VOB_PARAM);
  if (!value || value.length < 20 || value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  return value;
}
