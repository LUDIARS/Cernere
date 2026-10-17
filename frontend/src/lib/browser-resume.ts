import { installBrowserResumeReload, isWebAuthnActive } from "@ludiars/cernere-composite/ui";
import { wsClient } from "./ws-client";

// Auth redirects, enrollment and recovery keep one-time state in document memory.
const AUTH_PATH = /^\/(?:login|start|composite|recover|continue|passkeys|device-register|checkin|consent|oidc\/consent|onboarding|federate)(?:\/|$)/;

export function installAuthenticatedPageRecovery(): () => void {
  return installBrowserResumeReload({
    window,
    document,
    canReload: () => !AUTH_PATH.test(window.location.pathname) && !isWebAuthnActive(),
    isConnectionStale: () => !wsClient.connected,
    reload: () => window.location.reload(),
  });
}
