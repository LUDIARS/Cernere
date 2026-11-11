/**
 * 「データを登録しているサービス」の表示規則 (純粋関数)。
 *
 * 判定は既存の managed_project overview の inUse (Cernere に登録された列に値が入っているか)
 * をそのまま使う。各サービスが自分の中だけに持つデータは数えられない。
 */
export interface UserProjectOverview {
  key: string;
  name: string;
  description: string;
  isActive: boolean;
  totalColumns: number;
  filledColumns: number;
  inUse: boolean;
  connectionCount: number;
  lastConnectedAt: string | null;
}

/** データありのサービスだけを名前順で返す。 */
export function registeredServices(overviews: UserProjectOverview[]): UserProjectOverview[] {
  return overviews
    .filter((o) => o.inUse)
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

/** 登録データの 1 項目を表示用の文字列にする。空は「(未登録)」。 */
export function formatDataValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(未登録)";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
