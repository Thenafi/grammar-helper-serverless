import { errorDetails, logEvent } from "./logging.js";

const REQUEST_TIMEOUT_MS = 20_000;
const HEALTH_TIMEOUT_MS = 10_000;

class ProviderError extends Error {
  constructor(code, message, upstreamStatus, diagnostics = {}) {
    super(message);
    this.code = code;
    this.upstreamStatus = upstreamStatus;
    this.diagnostics = diagnostics;
  }
}

export class AIUnavailableError extends Error {
  constructor(providers) {
    super("All AI providers are unavailable. Please try again later.");
    this.providers = providers;
  }
}

function getProviders(env) {
  const agentRouterBase = (env.AGENTROUTER_BASE_URL || "https://co.agentrouter.org/v1").replace(/\/+$/, "");
  const geminiModel = env.GEMINI_MODEL || "gemini-3.5-flash-lite";

  return [
    {
      provider: "agentrouter",
      role: "primary",
      model: env.AGENTROUTER_MODEL || "deepseek-v4-flash",
      endpoint: `${agentRouterBase}/chat/completions`,
      apiKey: env.agentrouter_key,
    },
    {
      provider: "gemini",
      role: "backup",
      model: geminiModel,
      endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
      apiKey: env.GEMINI_API_KEY,
    },
  ];
}

function publicError(error) {
  // Never return upstream bodies or exception messages, which may contain credentials.
  if (error instanceof ProviderError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.upstreamStatus === undefined ? {} : { upstreamStatus: error.upstreamStatus }),
    };
  }
  return { code: "request_failed", message: "Could not reach the AI provider." };
}

function upstreamError(data) {
  const error = data?.error;
  const fields = {
    message: typeof error === "string" ? error : error?.message ?? data?.msg ?? data?.message,
    code: error?.code ?? data?.code,
    type: error?.type,
    status: error?.status,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) =>
    typeof value === "string" || typeof value === "number"));
}

function logProviderFailure(provider, error, env, text, operation, requestId, started, timeoutMs) {
  let endpoint = "[invalid endpoint]";
  try {
    const url = new URL(provider.endpoint);
    endpoint = `${url.origin}${url.pathname}`;
  } catch {
    // A malformed endpoint must not prevent logging or the backup attempt.
  }
  logEvent("error", "ai_provider_error", {
    requestId,
    operation,
    provider: provider.provider,
    role: provider.role,
    model: provider.model,
    endpoint,
    configured: Boolean(provider.apiKey),
    secretName: provider.provider === "agentrouter" ? "agentrouter_key" : "GEMINI_API_KEY",
    latencyMs: Date.now() - started,
    timeoutMs,
    ...publicError(error),
    diagnostics: error instanceof ProviderError ? error.diagnostics : errorDetails(error),
  }, [env.agentrouter_key, env.GEMINI_API_KEY, text]);
}

async function generate(provider, text, system, { timeoutMs = REQUEST_TIMEOUT_MS, maxOutputTokens } = {}) {
  if (!provider.apiKey) {
    throw new ProviderError("missing_api_key", "The provider API key is not configured.");
  }

  const isAgentRouter = provider.provider === "agentrouter";
  const headers = { "Content-Type": "application/json" };
  let body;

  if (isAgentRouter) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
    body = {
      model: provider.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
      stream: false,
      thinking: { type: "disabled" },
      ...(maxOutputTokens === undefined ? {} : { max_tokens: maxOutputTokens }),
    };
  } else {
    headers["x-goog-api-key"] = provider.apiKey;
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        thinkingConfig: { thinkingLevel: "minimal" },
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let diagnostics = {};

  try {
    const response = await fetch(provider.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });

    diagnostics = {
      upstreamStatus: response.status,
      contentType: response.headers.get("content-type"),
      upstreamRequestId: response.headers.get("x-request-id") || response.headers.get("request-id") || response.headers.get("cf-ray"),
      retryAfter: response.headers.get("retry-after"),
    };

    if (!response.ok) {
      let data;
      try {
        data = await response.json();
      } catch {
        // Non-JSON error pages are identified by their status and content type.
      }
      throw new ProviderError("http_error", `The AI provider returned HTTP ${response.status}.`, response.status, {
        ...diagnostics, upstreamError: upstreamError(data),
      });
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new ProviderError("invalid_response", "The AI provider did not return valid JSON.", undefined, diagnostics);
    }
    diagnostics.upstreamError = upstreamError(data);
    diagnostics.blockReason = data?.promptFeedback?.blockReason;

    let result;
    let finishReason;
    if (isAgentRouter) {
      const choice = data?.choices?.[0];
      result = choice?.message?.content;
      finishReason = choice?.finish_reason;
    } else {
      const candidate = data?.candidates?.[0];
      const parts = candidate?.content?.parts;
      result = Array.isArray(parts)
        ? parts.filter(part => !part.thought && typeof part.text === "string").map(part => part.text).join("")
        : undefined;
      finishReason = candidate?.finishReason;
    }

    if (finishReason && finishReason !== (isAgentRouter ? "stop" : "STOP")) {
      throw new ProviderError("incomplete_response", "The AI provider did not return a complete text response.", undefined, {
        ...diagnostics, finishReason,
      });
    }
    if (typeof result !== "string" || !result.trim()) {
      throw new ProviderError("empty_response", "The AI provider did not return any text.", undefined, diagnostics);
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ProviderError("timeout", "The AI provider request timed out.", undefined, diagnostics);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function proofreadWithFallback(env, text, system, { requestId } = {}) {
  const failures = [];
  for (const provider of getProviders(env)) {
    const started = Date.now();
    try {
      const correctedText = await generate(provider, text, system);
      if (provider.role === "backup") {
        logEvent("info", "ai_fallback_succeeded", {
          requestId, operation: "proofread", provider: provider.provider, model: provider.model,
          latencyMs: Date.now() - started,
        }, [env.agentrouter_key, env.GEMINI_API_KEY, text]);
      }
      return {
        text: correctedText,
        provider: provider.provider,
        model: provider.model,
        fallbackUsed: provider.role === "backup",
      };
    } catch (error) {
      logProviderFailure(provider, error, env, text, "proofread", requestId, started, REQUEST_TIMEOUT_MS);
      failures.push({ provider: provider.provider, model: provider.model, error: publicError(error) });
    }
  }
  logEvent("error", "ai_all_providers_failed", { requestId, operation: "proofread", providers: failures },
    [env.agentrouter_key, env.GEMINI_API_KEY, text]);
  throw new AIUnavailableError(failures);
}

export async function checkAIHealth(env, { requestId } = {}) {
  const providers = await Promise.all(getProviders(env).map(async provider => {
    const started = Date.now();
    const result = {
      provider: provider.provider,
      role: provider.role,
      model: provider.model,
      endpoint: provider.endpoint,
      configured: Boolean(provider.apiKey),
    };
    try {
      await generate(provider, "Reply with exactly OK.", "Return only the requested text.", {
        timeoutMs: HEALTH_TIMEOUT_MS,
        maxOutputTokens: 32,
      });
      return { ...result, working: true, latencyMs: Date.now() - started };
    } catch (error) {
      logProviderFailure(provider, error, env, undefined, "health", requestId, started, HEALTH_TIMEOUT_MS);
      return { ...result, working: false, latencyMs: Date.now() - started, error: publicError(error) };
    }
  }));

  const workingCount = providers.filter(provider => provider.working).length;
  return {
    status: workingCount === providers.length ? "healthy" : workingCount > 0 ? "degraded" : "unhealthy",
    checkedAt: new Date().toISOString(),
    providers,
  };
}
