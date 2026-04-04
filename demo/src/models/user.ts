/**
 * User モデル — ユーザー基本情報
 *
 * Cernere の CoreUser に対応するデモ用の型定義。
 */

export interface User {
  id: string;
  login: string;
  displayName: string;
  email: string;
  avatarUrl: string;
  role: "admin" | "member" | "guest";
  createdAt: string;
  updatedAt: string;
}

export interface UserResponse {
  id: string;
  login: string;
  displayName: string;
  email: string;
  avatarUrl: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

export function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    login: user.login,
    displayName: user.displayName,
    email: user.email,
    avatarUrl: user.avatarUrl,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
