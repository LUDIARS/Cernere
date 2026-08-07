/**
 * OAuth account-link grants.
 *
 * A link target is never encoded in OAuth `state`. The opaque state maps to a
 * short-lived Redis grant so callbacks cannot choose which Cernere user is
 * modified. Bearer-initiated grants are bound to the initiating browser by the
 * HttpOnly CSRF cookie. The provider is part of the grant so a proof issued
 * for one provider cannot be replayed at another provider's callback.
 */

import { config } from "../config.js";
import { redis } from "../redis.js";
import { createLinkStateToken } from "./oauth-state.js";

export type OAuthLinkProvider = "github" | "google" | "discord";

export interface OAuthLinkGrant {
  userId: string;
  provider: OAuthLinkProvider;
}

export interface OAuthLinkStart {
  authorizationUrl: string;
  state: string;
}

export const OAUTH_LINK_TTL_SEC = 600;

function requireProviderConfig(provider: OAuthLinkProvider): void {
  const configured = provider === "github"
    ? config.githubClientId && config.githubClientSecret
    : provider === "google"
      ? config.googleClientId && config.googleClientSecret
      : config.discordClientId && config.discordClientSecret;
  if (!configured) throw new Error(`${provider} OAuth is not configured`);
}

function authorizationUrl(provider: OAuthLinkProvider, state: string): string {
  if (provider === "github") {
    const params = new URLSearchParams({
      client_id: config.githubClientId,
      redirect_uri: config.githubRedirectUri,
      // Linking needs identity only; repository access is unrelated and must
      // not be requested merely to attach a login method.
      scope: "read:user user:email",
      state,
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  }
  if (provider === "google") {
    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: config.googleRedirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }
  const params = new URLSearchParams({
    client_id: config.discordClientId,
    redirect_uri: config.discordRedirectUri,
    response_type: "code",
    scope: "identify",
    state,
  });
  return `https://discord.com/api/oauth2/authorize?${params}`;
}

export async function createOAuthLinkGrant(
  provider: OAuthLinkProvider,
  userId: string,
): Promise<OAuthLinkStart> {
  requireProviderConfig(provider);
  const state = createLinkStateToken(crypto.randomUUID());
  const grant: OAuthLinkGrant = { userId, provider };
  await redis.set(`oauthlink:${state}`, JSON.stringify(grant), "EX", OAUTH_LINK_TTL_SEC);
  return { authorizationUrl: authorizationUrl(provider, state), state };
}

export async function loadOAuthLinkGrant(
  state: string,
  expectedProvider: OAuthLinkProvider,
): Promise<OAuthLinkGrant | null> {
  const raw = await redis.get(`oauthlink:${state}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value.userId !== "string" || value.userId.length === 0
      || value.provider !== expectedProvider) {
      return null;
    }
    return {
      userId: value.userId,
      provider: expectedProvider,
    };
  } catch {
    // An old user-id-only grant is not bound to a provider and must not bypass
    // the provider-specific action proof introduced with this flow.
    return null;
  }
}

export async function deleteOAuthLinkGrant(state: string): Promise<void> {
  await redis.del(`oauthlink:${state}`);
}
