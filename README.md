# Grammar Helper Serverless

A serverless grammar checker running on Cloudflare Workers. Uses **DeepSeek Flash through AgentRouter** (`deepseek-v4-flash`) first, with **Gemini 3.5 Flash-Lite** as an automatic backup.

## Prerequisites

- Node.js 22+
- npm or yarn
- Cloudflare account
- AgentRouter API key with access to DeepSeek Flash
- Gemini API key

## Setup

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Set up local API keys:**

   Copy `.dev.vars.example` to `.dev.vars` and fill in `agentrouter_key` and `GEMINI_API_KEY`. These names are case-sensitive. `.dev.vars` is ignored by Git.

3. **For production deployment, use these Cloudflare Worker secrets:**
   ```bash
   npx wrangler secret put agentrouter_key
   npx wrangler secret put GEMINI_API_KEY
   ```

   If these secrets are already set on the Worker, keep them; deployment uses the existing values. Do not put API keys in `wrangler.toml`.

The non-secret settings in `wrangler.toml` control the providers:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTROUTER_BASE_URL` | `https://agentrouter.org/v1` | AgentRouter API base, including `/v1` |
| `AGENTROUTER_MODEL` | `deepseek-v4-flash` | Requested DeepSeek model ID sent to AgentRouter |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Direct Google Gemini backup model |

See the [AgentRouter integration guide](https://agentrouter.org/docs/index.html), [DeepSeek model IDs](https://api-docs.deepseek.com/quick_start/pricing/), and [Gemini model details](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite). AgentRouter model availability depends on your account; `/health` verifies the configured model with your key. The primary endpoint is `https://agentrouter.org/v1/chat/completions`; a key for this host is not assumed to work on other AgentRouter gateways. An HTML verification page is a failed API response and triggers the Gemini backup.

## Development

Run the local development server:

```bash
npm start
```

The app will be available at `http://localhost:8787`

Run the automated tests with `npm test`. These include outbound requests in the local Cloudflare Worker runtime, with provider responses simulated so no API keys or quota are required.

## Deployment

### Deploy to Cloudflare Workers:

```bash
npm run deploy
```

## AI endpoints and health

`POST /api/proofread` accepts `{ "text": "Your text here" }` and returns the corrected `text`, the `provider` and `model` used, and `fallbackUsed`. AgentRouter is tried first. Missing keys, HTTP errors, timeouts, invalid/empty responses, and incomplete generations trigger the Gemini backup. Each provider request has a 20-second timeout. If both fail, the endpoint returns HTTP 503 with sanitized provider errors.

Provider requests use Cloudflare's supported `manual` redirect mode. Redirect responses are treated as provider failures, and credentials are never forwarded to the redirect destination.

`GET /health` (also available at `/api/health`) makes a real, small generation request to **each** configured provider in parallel. It reports their endpoints, models, key configuration, working status, latency, and sanitized errors. Checks have a 10-second timeout per provider and a 32-token output limit. Responses are not cached, and each check uses provider quota.

```bash
curl http://localhost:8787/health
```

- `healthy`: both models work, HTTP 200.
- `degraded`: one model works, HTTP 200; inspect `providers` to see which one failed.
- `unhealthy`: neither model works, HTTP 503.

No API keys, upstream response bodies, or user text are included in health results.

## Troubleshooting with Cloudflare tail

After deploying, start the [live log stream](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/) and reproduce the error in the app or call `/health`:

```bash
npm run tail
```

Every provider failure emits a JSON `console.error` entry named `ai_provider_error`, including failures that trigger fallback. Entries include the operation (`proofread` or `health`), provider, model, endpoint, whether its secret is configured, latency, timeout, and error code. HTTP errors also include the upstream status, request ID, content type, and the provider's error message/code when available. Incomplete generations include their finish or safety-block reason. Network errors include diagnostic messages and stack traces.

All entries for one request share a `requestId`, also returned in the response's `X-Request-ID` header. `ai_fallback_succeeded` confirms Gemini recovered a failed primary request; `ai_all_providers_failed` means both attempts failed. Unexpected handler errors emit `request_error`.

API keys and submitted text are redacted from diagnostic messages, strings are bounded, and full provider response bodies are never logged. Start tail without `--status error`: handled provider failures can appear in invocations marked `ok`, including successful fallbacks and responses with HTTP 503.

## Features

- Real-time grammar and spelling correction
- Powered by **DeepSeek Flash** (`deepseek-v4-flash`) via AgentRouter, with **Gemini 3.5 Flash-Lite** failover
- Live AI health checks at `/health` and `/api/health`
- Clean, user-friendly interface
- One-click copy to clipboard
- **Diff View**: Visually compare original and corrected text (with toggle)
- Keyboard shortcuts

## Keyboard Shortcuts

- **Enter**: Proofread the text
- **Shift+Enter**: Add new line
- **Ctrl+Shift+C**: Copy corrected text

