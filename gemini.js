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
    super("AI providers are unavailable. Please try again later.");
    this.providers = Array.isArray(providers) ? providers : [providers];
  }
}

function getProviders(env) {
  const model = env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  return [{
    provider: "groq",
    role: "primary",
    model: env.GROQ_MODEL || "qwen/qwen3.8-27b",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    apiKey: env.GROQ_KEY,
    secretName: "GROQ_KEY",
  }, {
    provider: "gemini",
    role: "fallback",
    secretName: "GEMINI_API_KEY",
    model,
    endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    apiKey: env.GEMINI_API_KEY,
  }];
}

function publicError(error) {
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
    message: typeof error === "string" ? error : error?.message,
    code: error?.code,
    status: error?.status,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) =>
    typeof value === "string" || typeof value === "number"));
}

function logFailure(provider, error, text, operation, requestId, started, timeoutMs) {
  logEvent("error", "ai_provider_error", {
    requestId, operation,
    provider: provider.provider,
    role: provider.role,
    model: provider.model,
    endpoint: provider.endpoint,
    configured: Boolean(provider.apiKey),
    secretName: provider.secretName,
    latencyMs: Date.now() - started,
    timeoutMs,
    ...publicError(error),
    diagnostics: error instanceof ProviderError ? error.diagnostics : errorDetails(error),
  }, [provider.apiKey, text]);
}

async function generate(provider, text, system, { timeoutMs = REQUEST_TIMEOUT_MS, maxOutputTokens } = {}) {
  if (!provider.apiKey) {
    throw new ProviderError("missing_api_key", `${provider.secretName} is not configured.`);
  }

  const body = provider.provider === "groq" ? {
    model: provider.model,
    messages: [{ role: "system", content: system }, { role: "user", content: text }],
    reasoning_effort: "low",
    reasoning_format: "hidden",
    ...(maxOutputTokens === undefined ? {} : { max_completion_tokens: maxOutputTokens }),
  } : {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: "low" },
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let diagnostics = {};

  try {
    const response = await fetch(provider.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(provider.provider === "groq"
        ? { Authorization: `Bearer ${provider.apiKey}` } : { "x-goog-api-key": provider.apiKey }) },
      body: JSON.stringify(body),
      signal: controller.signal,
      // Workers supports manual/follow only; do not forward the key to redirects.
      redirect: "manual",
    });
    diagnostics = {
      upstreamStatus: response.status,
      contentType: response.headers.get("content-type"),
      upstreamRequestId: response.headers.get("x-request-id") || response.headers.get("request-id"),
      retryAfter: response.headers.get("retry-after"),
    };

    if (!response.ok) {
      let data;
      try {
        data = await response.json();
      } catch {
        // Record status and content type without logging a raw response body.
      }
      throw new ProviderError("http_error", `${provider.provider} returned HTTP ${response.status}.`, response.status, {
        ...diagnostics, upstreamError: upstreamError(data),
      });
    }

    let data;
    try {
      data = await response.json();
    } catch {
      const message = diagnostics.contentType?.toLowerCase().includes("text/html")
        ? "AI provider returned an HTML page instead of JSON."
        : "AI provider did not return valid JSON.";
      throw new ProviderError("invalid_response", message, undefined, diagnostics);
    }
    diagnostics.upstreamError = upstreamError(data);
    diagnostics.blockReason = data?.promptFeedback?.blockReason;

    const candidate = data?.candidates?.[0];
    const finishReason = provider.provider === "groq" ? data?.choices?.[0]?.finish_reason : candidate?.finishReason;
    if (provider.provider === "groq" ? finishReason !== "stop" : finishReason && finishReason !== "STOP") {
      throw new ProviderError("incomplete_response", "AI provider did not return a complete text response.", undefined, {
        ...diagnostics, finishReason,
      });
    }
    const parts = candidate?.content?.parts;
    const result = provider.provider === "groq" ? data?.choices?.[0]?.message?.content : Array.isArray(parts)
      ? parts.filter(part => !part?.thought && typeof part?.text === "string").map(part => part.text).join("")
      : undefined;
    if (typeof result !== "string" || !result.trim()) {
      throw new ProviderError("empty_response", "AI provider did not return any text.", undefined, diagnostics);
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ProviderError("timeout", "The AI request timed out.", undefined, diagnostics);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function proofread(env, text, system, { requestId } = {}) {
  const failures = [];
  for (const provider of getProviders(env)) {
    const started = Date.now();
    try {
      const correctedText = await generate(provider, text, system);
      logEvent("info", "ai_request_succeeded", {
        requestId, operation: "proofread", provider: provider.provider, model: provider.model,
        latencyMs: Date.now() - started,
        inputCharacters: text.length,
        systemInstructionCharacters: system.length,
      }, [provider.apiKey, text]);
      return { text: correctedText, provider: provider.provider, model: provider.model, fallbackUsed: provider.role === "fallback" };
    } catch (error) {
      logFailure(provider, error, text, "proofread", requestId, started, REQUEST_TIMEOUT_MS);
      failures.push({ provider: provider.provider, model: provider.model, error: publicError(error) });
    }
  }
  throw new AIUnavailableError(failures);
}

export async function checkAIHealth(env, { requestId } = {}) {
  const providers = await Promise.all(getProviders(env).map(async provider => {
    const started = Date.now();
    const result = {
      provider: provider.provider, role: provider.role, model: provider.model,
      endpoint: provider.endpoint, configured: Boolean(provider.apiKey),
    };
    try {
      await generate(provider, "Reply with exactly OK.", "Return only the requested text.", {
        timeoutMs: HEALTH_TIMEOUT_MS, maxOutputTokens: 1024,
      });
      result.working = true;
    } catch (error) {
      logFailure(provider, error, undefined, "health", requestId, started, HEALTH_TIMEOUT_MS);
      result.working = false;
      result.error = publicError(error);
    }
    return { ...result, latencyMs: Date.now() - started };
  }));
  return {
    status: providers[0].working ? "healthy" : providers.some(provider => provider.working) ? "degraded" : "unhealthy",
    checkedAt: new Date().toISOString(),
    providers,
  };
}
