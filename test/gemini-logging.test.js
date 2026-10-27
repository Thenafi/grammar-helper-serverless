import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../app.js";

function captureLogs(t) {
  const errors = [];
  const info = [];
  t.mock.method(console, "error", entry => {
    if (typeof entry === "string" && entry.startsWith('{"event":')) errors.push(JSON.parse(entry));
  });
  t.mock.method(console, "info", entry => {
    if (typeof entry === "string" && entry.startsWith('{"event":')) info.push(JSON.parse(entry));
  });
  return { errors, info };
}

function proofread(text, key = "private-gemini-key") {
  return worker.fetch(new Request("https://grammar.example/api/proofread", {
    method: "POST", body: JSON.stringify({ text }),
  }), { GEMINI_API_KEY: key });
}

test("successful requests log prompt sizes and a request ID without logging their content", async t => {
  const logs = captureLogs(t);
  const text = "Private sentence to correct.";
  t.mock.method(globalThis, "fetch", async () => Response.json({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }],
  }));
  const response = await proofread(text);
  assert.equal(response.status, 200);
  assert.equal(logs.errors.length, 1);
  assert.equal(logs.info.length, 1);
  const entry = logs.info[0];
  assert.equal(entry.event, "ai_request_succeeded");
  assert.equal(entry.provider, "gemini");
  assert.equal(entry.inputCharacters, text.length);
  assert.ok(entry.systemInstructionCharacters > 100);
  assert.equal(entry.requestId, response.headers.get("X-Request-ID"));
  assert.ok(!JSON.stringify(logs).includes(text));
});

test("Google error details are visible in tail and remain out of the client response", async t => {
  const logs = captureLogs(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({
    error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" },
  }, { status: 429, headers: { "x-request-id": "google-request-123", "retry-after": "5" } }));
  const response = await proofread("Private sentence.");
  assert.equal(response.status, 503);
  assert.equal(logs.errors.length, 2);
  const entry = logs.errors[1];
  assert.equal(entry.event, "ai_provider_error");
  assert.equal(entry.provider, "gemini");
  assert.equal(entry.role, "fallback");
  assert.equal(entry.secretName, "GEMINI_API_KEY");
  assert.equal(entry.upstreamStatus, 429);
  assert.equal(entry.diagnostics.upstreamError.message, "Quota exceeded");
  assert.equal(entry.diagnostics.upstreamError.status, "RESOURCE_EXHAUSTED");
  assert.equal(entry.diagnostics.upstreamRequestId, "google-request-123");
  assert.equal(entry.diagnostics.retryAfter, "5");
  assert.equal(entry.requestId, response.headers.get("X-Request-ID"));
  assert.ok(!(await response.text()).includes("Quota exceeded"));
});

for (const failure of ["HTTP", "network"]) {
  test(`${failure} diagnostics redact the Gemini key and original text`, async t => {
    const logs = captureLogs(t);
    const key = "gemini-secret+/=";
    const text = "Private sentence\nwith \"quotes\".";
    t.mock.method(globalThis, "fetch", async () => {
      const message = `Denied ${key} ${encodeURIComponent(key)} ${text} ${JSON.stringify(text).slice(1, -1)}`;
      if (failure === "HTTP") {
        return Response.json({ error: { message }, request: "Full response body must stay private" }, { status: 403 });
      }
      throw new TypeError(message, { cause: new Error(`key=${encodeURIComponent(key)}`) });
    });
    const response = await proofread(text, key);
    assert.equal(response.status, 503);
    const serialized = JSON.stringify(logs);
    assert.ok(!serialized.includes(key));
    assert.ok(!serialized.includes(encodeURIComponent(key)));
    assert.ok(!serialized.includes("Private sentence"));
    assert.ok(!serialized.includes("Full response body"));
    assert.ok(serialized.includes("[REDACTED]"));
    if (failure === "network") assert.ok(logs.errors[1].diagnostics.stack);
  });
}

test("health failures log the Gemini operation and safety reason", async t => {
  const logs = captureLogs(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({
    candidates: [{ finishReason: "SAFETY" }], promptFeedback: { blockReason: "SAFETY" },
  }));
  const response = await worker.fetch(new Request("https://grammar.example/health"), { GEMINI_API_KEY: "private-key" });
  assert.equal(response.status, 503);
  assert.equal(logs.errors.length, 2);
  assert.equal(logs.errors[1].operation, "health");
  assert.equal(logs.errors[1].diagnostics.finishReason, "SAFETY");
  assert.equal(logs.errors[1].diagnostics.blockReason, "SAFETY");
});
