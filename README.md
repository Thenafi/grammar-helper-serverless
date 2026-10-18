# Grammar Helper Serverless

A serverless grammar checker running on Cloudflare Workers. Uses **DeepSeek V4.1 Flash through AgentRouter** first, with **Gemini 3.5 Flash-Lite** as an automatic backup.

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
| `AGENTROUTER_BASE_URL` | `https://co.agentrouter.org/v1` | AgentRouter's documented API base, including `/v1` |
| `AGENTROUTER_MODEL` | `deepseek-flash` | DeepSeek's model ID for V4.1 Flash; change this if your AgentRouter account requires a different alias |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Direct Google Gemini backup model |

See the [AgentRouter integration guide](https://co.agentrouter.org/portal/guide), [DeepSeek model IDs](https://api-docs.deepseek.com/quick_start/pricing/), and [Gemini model details](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite). AgentRouter model availability depends on your account; `/health` verifies the configured model with your key.

## Development

Run the local development server:

```bash
npm start
```

The app will be available at `http://localhost:8787`

Run the automated tests with `npm test`.

## Deployment

### Deploy to Cloudflare Workers:

```bash
npm run deploy
```

## AI endpoints and health

`POST /api/proofread` accepts `{ "text": "Your text here" }` and returns the corrected `text`, the `provider` and `model` used, and `fallbackUsed`. AgentRouter is tried first. Missing keys, HTTP errors, timeouts, invalid/empty responses, and incomplete generations trigger the Gemini backup. Each provider request has a 20-second timeout. If both fail, the endpoint returns HTTP 503 with sanitized provider errors.

`GET /health` (also available at `/api/health`) makes a real, small generation request to **each** configured provider in parallel. It reports their endpoints, models, key configuration, working status, latency, and sanitized errors. Checks have a 10-second timeout per provider and a 32-token output limit. Responses are not cached, and each check uses provider quota.

```bash
curl http://localhost:8787/health
```

- `healthy`: both models work, HTTP 200.
- `degraded`: one model works, HTTP 200; inspect `providers` to see which one failed.
- `unhealthy`: neither model works, HTTP 503.

No API keys, upstream response bodies, or user text are included in health results.

## Features

- Real-time grammar and spelling correction
- Powered by **DeepSeek V4.1 Flash** via AgentRouter, with **Gemini 3.5 Flash-Lite** failover
- Live AI health checks at `/health` and `/api/health`
- Clean, user-friendly interface
- One-click copy to clipboard
- **Diff View**: Visually compare original and corrected text (with toggle)
- Keyboard shortcuts

## Keyboard Shortcuts

- **Enter**: Proofread the text
- **Shift+Enter**: Add new line
- **Ctrl+Shift+C**: Copy corrected text

