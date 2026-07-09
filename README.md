# pi-grok

xAI Grok OAuth provider for [pi](https://pi.dev). Use your SuperGrok subscription with OAuth.

Log in once through your browser. Tokens refresh on their own. No API keys to manage, no billing setup. Switch models, reason through problems, build things.

Brings Grok models into pi using the official xAI OAuth 2.0 flow with PKCE. Your credentials stay on your machine.

## Requirements

- pi v0.74.0 or later
- xAI SuperGrok subscription

## Install

```bash
pi install git:github.com/stnly/pi-grok@v0.6.0
```

```
/reload
```

Or clone manually:

```bash
git clone https://github.com/stnly/pi-grok ~/.pi/agent/extensions/pi-grok
```

```
/reload
```

## Uninstall

```bash
pi remove git:github.com/stnly/pi-grok
```

## Quick start

**1. Log in**

```
/login
```

Choose **Use a subscription**, select **xAI (SuperGrok Subscription)**. Approve in your browser.

**2. Pick a model**

```
/model xai-oauth/grok-4.5
```

`Ctrl+P` cycles models.

## Models

- **grok-4.5**
- **grok-4.3**
- **grok-composer-2.5-fast**
- **grok-build**
- **grok-4.20-0309-reasoning**
- **grok-4.20-0309-non-reasoning**
- **grok-4.20-multi-agent-0309**

This is the built-in fallback list. On login, pi-grok also fetches
`api.x.ai/v1/models` and merges the live catalog in, so new Grok releases
appear without an extension update. The first model load after login uses the
fallback list; the catalog populates in the background and the next `/reload`
surfaces discovered models. If the fetch fails, the fallback list is used.

Both xAI endpoints stay in play: public-API models (and newly discovered ids
from `/models`) use `api.x.ai`; subscription-only models like Composer keep
the CLI chat proxy.

Filter or reorder with `PI_XAI_OAUTH_MODELS`. The filter is re-applied after
live discovery, so it still holds when new catalog ids arrive:

```bash
export PI_XAI_OAUTH_MODELS="grok-build,grok-4.5"
```

## How it works

pi starts a local HTTP server on `127.0.0.1:56121` and generates a PKCE challenge. Your browser opens to xAI's authorization page. You approve access. xAI redirects back with an auth code, which pi exchanges for access and refresh tokens.

Tokens refresh 5 minutes before they expire. You stay logged in until you revoke access. Credentials are stored locally and never leave your machine.

Requests go through xAI's Responses API. Tool calling, streaming, and reasoning all work.

## Check status

```
/xai-status
```

Shows your login state and available models.

## Env vars

| Variable | Default |
|---|---|
| `PI_XAI_BASE_URL` or `XAI_BASE_URL` | `https://api.x.ai/v1` |
| `PI_XAI_OAUTH_MODELS` | all models |
| `PI_XAI_OAUTH_CALLBACK_PORT` | `56121` |
| `PI_XAI_OAUTH_CLIENT_ID` | built-in |
| `XAI_OAUTH_TOKEN` | skip OAuth, use raw token (no refresh, no discovery) |
| `PI_XAI_X_SEARCH` | `true` |
| `PI_XAI_X_SEARCH_MODEL` | `grok-4.5` |

## Remote / SSH

Forward port 56121:

```bash
ssh -N -L 56121:127.0.0.1:56121 user@remote-host
```

Run `/login` in your remote pi session, complete the browser flow locally. If 56121 is taken, the extension picks a random port and prints it.

If the callback port can't be forwarded (e.g. the random fallback above, or the browser is on a machine you can't tunnel to), pi-grok also shows a paste prompt — complete the login in the browser, then paste the final `http://127.0.0.1:.../callback?code=...` redirect URL back into pi.

## X Search

The `x_search` tool lets any model (not just Grok) search X (formerly Twitter). When the model calls `x_search`, pi-grok makes a separate request to xAI's API using your OAuth credentials. The search results come back as a visible tool call in pi's UI.

Enabled by default. Disable with:

```bash
export PI_XAI_X_SEARCH=false
```

The model used for the internal search call defaults to `grok-4.5`. Change it with:

```bash
export PI_XAI_X_SEARCH_MODEL=grok-4.20-0309-reasoning
```

## Architecture

```
pi-grok/
├── index.ts           # provider registration + event hooks
├── x-search-tool.ts   # x_search tool (separate xAI request)
├── oauth.ts           # PKCE flow, OIDC discovery, token refresh
├── models.ts          # model definitions + live catalog from xAI
├── sanitize.ts        # strips unsupported fields before each request
├── errors.ts          # typed error classes
├── package.json
└── tsconfig.json
```

- **Payload sanitization via `before_provider_request`** - decoupled from streaming, visible to other extensions, chainable.
- **X Search tool** - proxy via `pi.registerTool`. Any model can search X. Per-query parameters supported.
- **Live model catalog** - fetches `api.x.ai/v1/models` on login, merges with built-in list so new Grok releases appear without an extension update.
- **Typed errors** - `XaiOAuthError` with machine-readable codes for distinguishing retryable vs fatal failures.
- **Web Crypto** - `crypto.subtle` for PKCE.

## Credits

- [pi](https://pi.dev)
- [xAI](https://x.ai)
- [Hermes Agent](https://github.com/NousResearch/hermes-agent)

## License

MIT
