# Cernere Native Composite

Desktop host package for Cernere passkey login and a direct session with one configured
service. Node.js 22.15+; no renderer dependencies.

`localIdentity()` creates an opaque UUID in the OS user's local application data
folder (`%LOCALAPPDATA%/Cernere/native-composite/identity.json` on Windows).
Creation is atomic across competing processes. Existing invalid files fail closed.
The ID survives application updates and logout; it is neither a Cernere user ID
nor proof of attendance/authentication. It is not automatically transmitted.

Construct `NativeComposite({ cernereUrl, serviceUrl, clientId, signal })` in the
host process. Open `loginUrl(applicationOrigin)` in the user's browser. The
application origin must already be authorized by Cernere's composite registry.
Validate both `postMessage.origin` and `postMessage.source`, then pass the one-time
code and state to the host's CSRF-protected exchange route. Call `exchange(code, state)` there.
The host owns the PKCE verifier in memory and sends it only to the configured
service's `/api/auth/native/exchange` backend. No project secret belongs in the native app.
No password login or embedded WebAuthn implementation is provided.

`authorized(url, method, body)` sends the opaque service session to that service
only. The backend applies the common live Cernere guard and its own resource
authorization. Bearer requests reject other origins and redirects. `logout()`
clears local credentials and calls the service's `/api/auth/native/logout`;
`dispose()` clears credentials. No Cernere access/refresh/project token is received.
Expiry requires a new PKCE login; requests and mutations are never automatically
retried. Login after a process restart uses the browser's
Cernere session. Plugins receive scoped operations, never tokens.

Acceptance: persistent identity across restarts; concurrent first creation;
malformed identity rejection; PKCE/state exchange; session expiry; no bearer
leak on redirect/unconfigured origin; logout and disposal during pending I/O.
Runtime tests are delegated to the authorized review workflow.
