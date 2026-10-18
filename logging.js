export function errorDetails(error) {
  return {
    name: error?.name,
    message: error?.message || "Unknown error",
    stack: error?.stack,
    ...(error?.cause ? {
      cause: { name: error.cause.name, message: error.cause.message, code: error.cause.code },
    } : {}),
  };
}

export function logEvent(level, event, details, sensitiveValues = []) {
  const protectedValues = new Set();
  for (const value of sensitiveValues) {
    if (typeof value !== "string" || !value) continue;
    protectedValues.add(value);
    if (value.trim()) protectedValues.add(value.trim());
    protectedValues.add(JSON.stringify(value).slice(1, -1));
    try {
      protectedValues.add(encodeURIComponent(value));
    } catch {
      // Unpaired Unicode surrogates can occur in submitted text.
    }
  }
  const valuesToRedact = [...protectedValues].sort((a, b) => b.length - a.length);

  function sanitize(value) {
    if (typeof value === "string") {
      for (const protectedValue of valuesToRedact) {
        value = value.replaceAll(protectedValue, "[REDACTED]");
      }
      value = value
        .replace(/\bBearer\s+[^\s"',}]+/gi, "Bearer [REDACTED]")
        .replace(/\b((?:api[_-]?key|access[_-]?token|key|token|authorization)\s*[:=]\s*)["']?[^\s"'&,}]+/gi, "$1[REDACTED]");
      return value.length > 2000 ? `${value.slice(0, 2000)} [truncated]` : value;
    }
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
    }
    return value;
  }

  console[level](JSON.stringify({ event, ...sanitize(details) }));
}
