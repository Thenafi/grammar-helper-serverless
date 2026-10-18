import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import worker from "../app.js";

const env = { agentrouter_key: "private-agentrouter-key", GEMINI_API_KEY: "private-gemini-key" };
const primaryEndpoint = "https://co.agentrouter.org/v1/chat/completions";

function captureLogs(t) {
  const errors = [];
  const info = [];
  t.mock.method(console, "error", entry => {
    if (entry.startsWith('{"event":')) errors.push(JSON.parse(entry));
  });
  t.mock.method(console, "info", entry => {
    if (entry.startsWith('{"event":')) info.push(JSON.parse(entry));
  });
  return { errors, info };
}

function proofread(bindings = env, text = "This are a sentence.") {
  return worker.fetch(new Request("https://grammar.example/api/proofread", {
    method: "POST", body: JSON.stringify({ text }),
  }), bindings);
}

function geminiResponse() {
  return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "This is a sentence." }] } }] });
}

test("tail logs show the upstream model error even when Gemini recovers", async t => {
  const logs = captureLogs(t);
  t.mock.method(globalThis, "fetch", async url => url === primaryEndpoint
    ? Response.json({ error: { message: "Requested model is not available", code: "model_not_found", type: "invalid_request_error" } }, {
      status: 404, headers: { "x-request-id": "upstream-123", "retry-after": "5" },
    })
    : geminiResponse());

  const response = await proofread();
  assert.equal(response.status, 200);
  assert.equal(logs.errors.length, 1);
  const error = logs.errors[0];
  assert.equal(error.event, "ai_provider_error");
  assert.equal(error.provider, "agentrouter");
  assert.equal(error.model, "deepseek-v4-flash");
  assert.equal(error.operation, "proofread");
  assert.equal(error.upstreamStatus, 404);
  assert.equal(error.diagnostics.upstreamError.message, "Requested model is not available");
  assert.equal(error.diagnostics.upstreamError.code, "model_not_found");
  assert.equal(error.diagnostics.upstreamRequestId, "upstream-123");
  assert.equal(error.diagnostics.retryAfter, "5");
  assert.ok(error.latencyMs >= 0);
  assert.equal(error.requestId, response.headers.get("X-Request-ID"));
  assert.equal(logs.info[0].event, "ai_fallback_succeeded");
  assert.equal(logs.info[0].requestId, error.requestId);
  assert.equal(response.headers.get("Access-Control-Expose-Headers"), "X-Request-ID");
  assert.ok(!(await response.text()).includes("model_not_found"), "upstream diagnostics stay in server logs");
});

test("logs redact secrets and input from upstream messages, network errors, causes, and stacks", async t => {
  const logs = captureLogs(t);
  const bindings = { agentrouter_key: "agent-secret+/=", GEMINI_API_KEY: "gemini-secret+/=" };
  const text = "Private sentence\nwith \"quotes\".";
  t.mock.method(globalThis, "fetch", async url => {
    if (url === primaryEndpoint) {
      return Response.json({
        code: 403,
        msg: `Denied ${bindings.agentrouter_key} ${encodeURIComponent(bindings.agentrouter_key)} ${text} ${JSON.stringify(text).slice(1, -1)}`,
        request: "This full response body must never be logged",
      }, { status: 403 });
    }
    throw new TypeError(`Failed ${bindings.GEMINI_API_KEY} ${text}`, {
      cause: new Error(`key=${encodeURIComponent(bindings.GEMINI_API_KEY)}`),
    });
  });
  const response = await proofread(bindings, text);
  assert.equal(response.status, 503);
  assert.deepEqual(logs.errors.map(entry => entry.event), ["ai_provider_error", "ai_provider_error", "ai_all_providers_failed"]);
  const serialized = JSON.stringify(logs);
  for (const key of Object.values(bindings)) {
    assert.ok(!serialized.includes(key));
    assert.ok(!serialized.includes(encodeURIComponent(key)));
  }
  assert.ok(!serialized.includes("Private sentence"));
  assert.ok(!serialized.includes("This full response body"));
  assert.ok(serialized.includes("[REDACTED]"));
  assert.ok(logs.errors[1].diagnostics.stack);
  assert.equal(logs.errors[1].diagnostics.name, "TypeError");
  assert.equal(logs.errors[0].diagnostics.upstreamError.code, 403);
  assert.equal(logs.errors[2].requestId, response.headers.get("X-Request-ID"));
});

test("health logs identify the missing secret and the Gemini safety finish reason", async t => {
  const logs = captureLogs(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({
    candidates: [{ finishReason: "SAFETY" }], promptFeedback: { blockReason: "SAFETY" },
  }));
  const response = await worker.fetch(new Request("https://grammar.example/health"), { GEMINI_API_KEY: env.GEMINI_API_KEY });
  assert.equal(response.status, 503);
  assert.equal(logs.errors.length, 2);
  assert.equal(logs.errors[0].code, "missing_api_key");
  assert.equal(logs.errors[0].secretName, "agentrouter_key");
  assert.equal(logs.errors[0].configured, false);
  assert.equal(logs.errors[1].diagnostics.finishReason, "SAFETY");
  assert.equal(logs.errors[1].diagnostics.blockReason, "SAFETY");
  for (const entry of logs.errors) {
    assert.equal(entry.operation, "health");
    assert.equal(entry.requestId, response.headers.get("X-Request-ID"));
  }
});

test("HTML responses log their status and content type without logging the page", async t => {
  const logs = captureLogs(t);
  t.mock.method(globalThis, "fetch", async url => url === primaryEndpoint
    ? new Response("<html>Private verification page</html>", { headers: { "Content-Type": "text/html" } })
    : geminiResponse());
  assert.equal((await proofread()).status, 200);
  assert.equal(logs.errors[0].code, "invalid_response");
  assert.equal(logs.errors[0].diagnostics.upstreamStatus, 200);
  assert.equal(logs.errors[0].diagnostics.contentType, "text/html");
  assert.ok(!JSON.stringify(logs).includes("Private verification page"));
});

test("timeouts are logged before fallback with the timeout duration", async t => {
  const logs = captureLogs(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url !== primaryEndpoint) return geminiResponse();
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  });
  const pending = proofread();
  await setImmediate();
  t.mock.timers.tick(20_000);
  assert.equal((await pending).status, 200);
  assert.equal(logs.errors[0].code, "timeout");
  assert.equal(logs.errors[0].timeoutMs, 20_000);
  assert.equal(logs.info[0].event, "ai_fallback_succeeded");
});

test("a malformed endpoint can be logged without stopping fallback", async t => {
  const logs = captureLogs(t);
  t.mock.method(globalThis, "fetch", async url => {
    if (url.startsWith("invalid endpoint")) throw new TypeError("Invalid URL");
    return geminiResponse();
  });
  assert.equal((await proofread({ ...env, AGENTROUTER_BASE_URL: "invalid endpoint" })).status, 200);
  assert.equal(logs.errors[0].endpoint, "[invalid endpoint]");
});

for (const path of ["/health", "/api/proofread"]) {
  test(`unexpected ${path} errors are logged with a stack and request ID`, async t => {
    const logs = captureLogs(t);
    const bindings = { ...env, AGENTROUTER_BASE_URL: 42 };
    const response = path === "/health"
      ? await worker.fetch(new Request("https://grammar.example/health"), bindings)
      : await proofread(bindings);
    assert.equal(response.status, path === "/health" ? 503 : 500);
    assert.equal(logs.errors[0].event, "request_error");
    assert.equal(logs.errors[0].error.name, "TypeError");
    assert.ok(logs.errors[0].error.stack.includes("getProviders"));
    assert.equal(logs.errors[0].requestId, response.headers.get("X-Request-ID"));
  });
}
