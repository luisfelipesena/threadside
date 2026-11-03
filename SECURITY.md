# Security

Threadside is a client of your own T3 Code server. It never talks to any other service.

## What it stores

- One scoped bearer session per T3 Code environment, in the editor's **SecretStorage** (the OS keychain). Nothing is written to settings, workspace files or logs.
- Sessions are issued with the scopes a chat client needs (`orchestration`, `terminal`, `filesystem`, `source-control`, `settings`, `providers`, `preview`, `diagnostics`, and `environment:maintain` for server updates). Access management (`access:*`) and relay control (`relay:*`) are never requested.
- Each session is listed in T3 Code under **Settings → Sharing & access** as `Threadside in <editor> (<host>)` and can be revoked there at any time. **T3: Disconnect and Forget Credentials** deletes it from the editor and revokes it when the `t3` CLI is available.

## How the chat is served

- The chat tab shows the T3 Code server's own web app, served through a proxy that the extension runs on `127.0.0.1` only.
- The proxy adds the bearer token on the way to the server. The token never reaches the webview or the page.
- Each editor window has a random key. The first request carries it once and gets it back as an `HttpOnly` cookie; requests without it are refused, so other local processes cannot use the forwarded port.
- Only the path and query of a request are forwarded, always to the configured server origin.
- Cookies set by the server are dropped; the page's cookies are never forwarded.

## Messages between the chat and the editor

- The webview accepts messages only from its own frame and origin; the bridge accepts messages only from its parent.
- File links open files in the editor, read-only actions only. Web links open in the system browser and only for `http` and `https`.
- `vscode://`/`cursor://` pairing links always ask for confirmation and show the server's host.

## Reporting a vulnerability

Open a private security advisory on GitHub: <https://github.com/luisfelipesena/threadside/security/advisories/new>.
