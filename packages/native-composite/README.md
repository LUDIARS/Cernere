# Cernere Native Composite

Desktop host package for Cernere passkey login, an authenticated WebSocket lease,
and requests to explicitly configured service origins. Node.js 22.15+; no renderer dependencies.

`localIdentity()` creates an opaque UUID in the OS user's local application data
folder (`%LOCALAPPDATA%/Cernere/native-composite/identity.json` on Windows).
Creation is atomic across competing processes. Existing invalid files fail closed.
The ID survives application updates and logout; it is neither a Cernere user ID
nor proof of attendance/authentication. It is not automatically transmitted.

Construct `NativeComposite({ cernereUrl, allowedServiceOrigins, signal })` in the
host process. Open `loginUrl(applicationOrigin)` in the user's browser. The
application origin must already be authorized by Cernere's composite registry.
Validate both `postMessage.origin` and `postMessage.source`, then pass the one-time
code to the host's CSRF-protected exchange route. Call `exchange(code)` there.
No password login or embedded WebAuthn implementation is provided.

`authorized(url, method, body)` maintains the authenticated `/auth` WebSocket,
answers server pings and rotates the session on expiry. Bearer requests reject
unconfigured origins and redirects. `logout()` clears local credentials and
revokes the refresh token; `dispose()` ends the connection. Access and refresh
tokens remain in memory only. Login after a process restart uses the browser's
Cernere session. Plugins receive scoped operations, never tokens.

Acceptance: persistent identity across restarts; concurrent first creation;
malformed identity rejection; passkey exchange; disconnect/reconnect; no bearer
leak on redirect/unconfigured origin; logout and disposal during pending I/O.
Runtime tests are delegated to the authorized review workflow.
