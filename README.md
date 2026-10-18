# Grammar Helper Serverless

A serverless grammar checker running on Cloudflare Workers, powered by **Gemini 3.5 Flash-Lite** directly through Google's API.

## Prerequisites

- Node.js 22+
- npm or yarn
- Cloudflare account
- Gemini API key

## Setup

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Set up the local API key:**

   Copy `.dev.vars.example` to `.dev.vars` and fill in `GEMINI_API_KEY`. The name is case-sensitive. `.dev.vars` is ignored by Git.

3. **For production deployment, use this Cloudflare Worker secret:**
   ```bash
   npx wrangler secret put GEMINI_API_KEY
   ```

   If `GEMINI_API_KEY` is already set on the Worker, keep it; deployment uses the existing value. Do not put API keys in `wrangler.toml`.

The non-secret setting in `wrangler.toml` selects the model:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Direct Google Gemini model |

See the [Gemini model details](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) and [GenerateContent API reference](https://ai.google.dev/api/generate-content). Requests use `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent`, with the secret in the `x-goog-api-key` header. Proofreading instructions go in `systemInstruction.parts[].text`; the user's original text goes separately in `contents[].parts[].text` with role `user`.

The prompt requests only necessary spelling, punctuation, grammar, and syntax corrections, preserving meaning, style, language, dialect, and formatting. Text without errors is returned unchanged. Submitted content is treated as text to proofread, including any instructions it contains. The page preserves the pasted text's whitespace when sending it. Only final response text is returned; thought parts are excluded. The model uses minimal thinking, and deprecated sampling parameters are omitted.

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

`POST /api/proofread` accepts `{ "text": "Your text here" }` and sends one request directly to Gemini. It returns corrected `text`, `provider: "gemini"`, `model`, and `fallbackUsed: false` for compatibility with existing clients. Requests have a 20-second timeout. Missing keys, HTTP errors, timeouts, invalid/empty responses, and incomplete generations return HTTP 503 with sanitized provider errors.

Provider requests use Cloudflare's supported `manual` redirect mode. Redirect responses are treated as provider failures, and credentials are never forwarded to the redirect destination.

`GET /health` (also available at `/api/health`) makes one real, small generation request to Gemini. It reports the endpoint, model, key configuration, working status, latency, and sanitized errors in the `providers` array. Checks have a 10-second timeout and a 32-token output limit. Responses are not cached, and each check uses provider quota.

```bash
curl http://localhost:8787/health
```

- `healthy`: Gemini works, HTTP 200.
- `unhealthy`: Gemini failed or its key is missing, HTTP 503.

No API keys, upstream response bodies, or user text are included in health results.

## Troubleshooting with Cloudflare tail

After deploying, start the [live log stream](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/) and reproduce the error in the app or call `/health`:

```bash
npm run tail
```

Every Gemini failure emits a JSON `console.error` entry named `ai_provider_error`. Entries include the operation (`proofread` or `health`), provider, model, endpoint, whether its secret is configured, latency, timeout, and error code. HTTP errors also include the upstream status, request ID, content type, and Google's error message/code when available. Incomplete generations include their finish or safety-block reason. Network errors include diagnostic messages and stack traces.

All entries for one request share a `requestId`, also returned in the response's `X-Request-ID` header. Successful proofreading emits `ai_request_succeeded`, including input and system-instruction character counts so you can confirm both were sent without logging their content. Unexpected handler errors emit `request_error`.

API keys and submitted text are redacted from diagnostic messages, strings are bounded, and full provider response bodies are never logged. Start tail without `--status error`: handled provider failures can appear in invocations marked `ok`, including responses with HTTP 503.

## Features

- Real-time grammar and spelling correction
- Powered by **Gemini 3.5 Flash-Lite**
- Live AI health checks at `/health` and `/api/health`
- Clean, user-friendly interface
- One-click copy to clipboard
- **Diff View**: Visually compare original and corrected text (with toggle)
- Keyboard shortcuts

## Keyboard Shortcuts

- **Enter**: Proofread the text
- **Shift+Enter**: Add new line
- **Ctrl+Shift+C**: Copy corrected text

