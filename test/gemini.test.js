import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { beforeEach, test } from "node:test";
import worker from "../app.js";

const env = { GEMINI_API_KEY: "test-gemini-secret" };
const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";

beforeEach(t => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
});

function geminiResponse(text = "This is correct.", finishReason = "STOP") {
  return Response.json({ candidates: [{ content: { parts: [{ text }] }, finishReason }] });
}

function proofread(body = { text: "This are correct." }, bindings = env) {
  return worker.fetch(new Request("https://grammar.example/api/proofread", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), bindings);
}

test("proofreading sends separate system instructions and exact user text directly to Gemini", async t => {
  const original = "  This are correct.\n\nবাংলা লেখা 😊\n";
  const corrected = "  This is correct.\n\nবাংলা লেখা 😊\n";
  const mockedFetch = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, endpoint);
    assert.equal(init.method, "POST");
    assert.equal(init.headers["x-goog-api-key"], env.GEMINI_API_KEY);
    assert.equal(init.headers.Authorization, undefined);
    const body = JSON.parse(init.body);
    assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: original }] }]);
    assert.match(body.systemInstruction.parts[0].text, /Correct only spelling, punctuation, grammar, and syntax errors/);
    assert.match(body.systemInstruction.parts[0].text, /language, dialect, and formatting/);
    assert.match(body.systemInstruction.parts[0].text, /return it exactly as provided/);
    assert.ok(!body.systemInstruction.parts[0].text.includes(original));
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "minimal");
    for (const key of ["temperature", "topP", "topK"]) assert.equal(body.generationConfig[key], undefined);
    return geminiResponse(corrected);
  });
  const response = await proofread({ text: original });
  assert.equal(response.status, 200);
  assert.equal(mockedFetch.mock.callCount(), 1);
  assert.deepEqual(await response.json(), {
    text: corrected, provider: "gemini", model: "gemini-3.5-flash-lite", fallbackUsed: false,
  });
});

test("only final response text is returned, with its original formatting", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ candidates: [{
    finishReason: "STOP",
    content: { parts: [{ thought: true, text: "Internal thought" }, null, { text: "  He " }, { text: "is here.\n" }] },
  }] }));
  const response = await proofread();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, "  He is here.\n");
});

test("the Gemini model can be configured without changing the API key", async t => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-custom:generateContent");
    assert.equal(init.headers["x-goog-api-key"], env.GEMINI_API_KEY);
    return geminiResponse();
  });
  const response = await proofread(undefined, { ...env, GEMINI_MODEL: "gemini-custom" });
  assert.equal((await response.json()).model, "gemini-custom");
});

const failures = [
  ...[400, 401, 403, 429, 500, 503].map(status => [
    `HTTP ${status}`, () => Response.json({ error: { message: "Upstream rejected request" } }, { status }), "http_error",
  ]),
  ["network errors", () => { throw new TypeError("Network failure"); }, "request_failed"],
  ["HTML responses", () => new Response("<html>Failure</html>"), "invalid_response"],
  ["null JSON", () => Response.json(null), "empty_response"],
  ["empty output", () => geminiResponse("  "), "empty_response"],
  ["truncated output", () => geminiResponse("Partial", "MAX_TOKENS"), "incomplete_response"],
  ["blocked output", () => geminiResponse("", "SAFETY"), "incomplete_response"],
];

for (const [name, failure, code] of failures) {
  test(`Gemini ${name} returns a safe failure without another provider request`, async t => {
    const mockedFetch = t.mock.method(globalThis, "fetch", async () => failure());
    const response = await proofread();
    assert.equal(response.status, 503);
    assert.equal(mockedFetch.mock.callCount(), 1);
    const data = await response.json();
    assert.equal(data.providers.length, 1);
    assert.equal(data.providers[0].provider, "gemini");
    assert.equal(data.providers[0].error.code, code);
  });
}

test("missing Gemini credentials fail without making a network request", async t => {
  const mockedFetch = t.mock.method(globalThis, "fetch", () => assert.fail("No key: do not send a request"));
  const response = await proofread(undefined, {});
  assert.equal(response.status, 503);
  assert.equal(mockedFetch.mock.callCount(), 0);
  assert.equal((await response.json()).providers[0].error.code, "missing_api_key");
});

for (const phase of ["connection", "response body"]) {
  test(`a stalled Gemini ${phase} times out after 20 seconds`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const mockedFetch = t.mock.method(globalThis, "fetch", async (url, init) => {
      if (phase === "connection") {
        return new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      }
      return new Response(new ReadableStream({
        start(controller) {
          init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
        },
      }));
    });
    const pending = proofread();
    await setImmediate();
    t.mock.timers.tick(20_000);
    const response = await pending;
    assert.equal(response.status, 503);
    assert.equal(mockedFetch.mock.callCount(), 1);
    assert.equal((await response.json()).providers[0].error.code, "timeout");
  });
}

for (const path of ["/health", "/api/health"]) {
  test(`${path} checks only Gemini using a small generation request`, async t => {
    const mockedFetch = t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(url, endpoint);
      const body = JSON.parse(init.body);
      assert.equal(body.contents[0].parts[0].text, "Reply with exactly OK.");
      assert.equal(body.generationConfig.maxOutputTokens, 32);
      return geminiResponse("OK");
    });
    const response = await worker.fetch(new Request(`https://grammar.example${path}`), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(mockedFetch.mock.callCount(), 1);
    const data = await response.json();
    assert.equal(data.status, "healthy");
    assert.equal(data.providers.length, 1);
    assert.equal(data.providers[0].provider, "gemini");
    assert.equal(data.providers[0].role, "primary");
    assert.equal(data.providers[0].working, true);
  });
}

test("health reports missing credentials without making requests", async t => {
  const mockedFetch = t.mock.method(globalThis, "fetch", () => assert.fail("No key: do not send a request"));
  const response = await worker.fetch(new Request("https://grammar.example/health"), {});
  assert.equal(response.status, 503);
  assert.equal(mockedFetch.mock.callCount(), 0);
  const data = await response.json();
  assert.equal(data.status, "unhealthy");
  assert.equal(data.providers[0].configured, false);
});

test("a stalled health check times out after 10 seconds", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  const pending = worker.fetch(new Request("https://grammar.example/health"), env);
  await setImmediate();
  t.mock.timers.tick(10_000);
  const response = await pending;
  assert.equal(response.status, 503);
  assert.equal((await response.json()).providers[0].error.code, "timeout");
});

for (const body of [null, {}, { text: "" }, { text: " \n\t" }, { text: 42 }, { text: {} }, { text: ["hello"] }]) {
  test(`invalid input returns 400 without an AI request: ${JSON.stringify(body)}`, async t => {
    const mockedFetch = t.mock.method(globalThis, "fetch", () => assert.fail("Invalid input must not reach Gemini"));
    assert.equal((await proofread(body)).status, 400);
    assert.equal(mockedFetch.mock.callCount(), 0);
  });
}

test("malformed JSON returns 400", async t => {
  const mockedFetch = t.mock.method(globalThis, "fetch", () => assert.fail("Invalid JSON must not reach Gemini"));
  const response = await worker.fetch(new Request("https://grammar.example/api/proofread", { method: "POST", body: "{" }), env);
  assert.equal(response.status, 400);
  assert.equal(mockedFetch.mock.callCount(), 0);
});

test("health preflight does not call Gemini", async t => {
  const mockedFetch = t.mock.method(globalThis, "fetch", () => assert.fail("Preflight must not reach Gemini"));
  const response = await worker.fetch(new Request("https://grammar.example/health", { method: "OPTIONS" }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(mockedFetch.mock.callCount(), 0);
});
