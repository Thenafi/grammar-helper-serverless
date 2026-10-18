const REQUEST_TIMEOUT_MS = 20_000;
const HEALTH_TIMEOUT_MS = 10_000;

class ProviderError extends Error {
  constructor(code, message, upstreamStatus) {
    super(message);
    this.code = code;
    this.upstreamStatus = upstreamStatus;
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
      model: env.AGENTROUTER_MODEL || "deepseek-flash",
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

  try {
    const response = await fetch(provider.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });

    if (!response.ok) {
      throw new ProviderError("http_error", `The AI provider returned HTTP ${response.status}.`, response.status);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new ProviderError("invalid_response", "The AI provider did not return valid JSON.");
    }

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
      throw new ProviderError("incomplete_response", "The AI provider did not return a complete text response.");
    }
    if (typeof result !== "string" || !result.trim()) {
      throw new ProviderError("empty_response", "The AI provider did not return any text.");
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ProviderError("timeout", "The AI provider request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function proofreadWithFallback(env, text, system) {
  const failures = [];
  for (const provider of getProviders(env)) {
    try {
      const correctedText = await generate(provider, text, system);
      return {
        text: correctedText,
        provider: provider.provider,
        model: provider.model,
        fallbackUsed: provider.role === "backup",
      };
    } catch (error) {
      failures.push({ provider: provider.provider, model: provider.model, error: publicError(error) });
    }
  }
  throw new AIUnavailableError(failures);
}

export async function checkAIHealth(env) {
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
