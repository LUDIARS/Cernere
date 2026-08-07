/**
 * 連携解除が「最後のログイン手段」を奪わないかの判定。
 *
 * ログイン手段の集合は password / passkey / GitHub OAuth / Google OAuth。
 * Discord はログイン手段ではない (link 専用) ため、数にも入らず、常に解除できる。
 */
export type UnlinkableProvider = "github" | "google" | "discord";

export interface LoginMethodState {
  hasPassword: boolean;
  passkeyCount: number;
  hasGitHubAuth: boolean;
  hasGoogleAuth: boolean;
}

/** 解除後にログイン手段が1つ以上残るか。 */
export function canUnlinkProvider(
  provider: UnlinkableProvider,
  state: LoginMethodState,
): boolean {
  if (provider === "discord") return true;
  if (state.hasPassword) return true;
  if (state.passkeyCount > 0) return true;
  const keepsGitHub = provider !== "github" && state.hasGitHubAuth;
  const keepsGoogle = provider !== "google" && state.hasGoogleAuth;
  return keepsGitHub || keepsGoogle;
}
