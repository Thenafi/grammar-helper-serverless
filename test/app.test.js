import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { beforeEach, test } from "node:test";
import worker from "../app.js";

const env = { agentrouter_key: "test-agentrouter-secret", GEMINI_API_KEY: "test-gemini-secret" };
const agentRouterEndpoint = "https://co.agentrouter.org/v1/chat/completions";
const geminiEndpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";

beforeEach(t => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
});

function agentRouterResponse(text = "This is correct.", finishReason = "stop") {
  return Response.json({ choices: [{ message: { content: text }, finish_reason: finishReason }] });
}

function geminiResponse(text = "This is correct.", finishReason = "STOP") {
  return Response.json({ candidates: [{ content: { parts: [{ text }] }, finishReason }] });
}

function proofread(body = { text: "This are correct." }, bindings = env) {
  return worker.fetch(new Request("https://grammar.example/api/proofread", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), bindings);
}

function health(bindings = env, path = "/health") {
  return worker.fetch(new Request(`https://grammar.example${path}`), bindings);
}

test("proofreading uses AgentRouter first with the existing lowercase secret and preserves formatting", async t => {
  const original = "  This are correct.\n";
  const corrected = "  This is correct.\n";
  const mockedFetch = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, agentRouterEndpoint);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, `Bearer ${env.agentrouter_key}`);
    assert.equal(init.headers["x-goog-api-key"], undefined);
    const body = JSON.parse(init.body);
    assert.equal(body.model, "deepseek-v4-flash");
    assert.equal(body.messages[0].role, "system");
    assert.match(body.messages[0].content, /You are a proofreader/);
    assert.deepEqual(body.messages[1], { role: "user", content: original });
    assert.equal(body.stream, false);
    assert.equal(body.thinking.type, "disabled");
    return agentRouterResponse(corrected);
  });

  const response = await proofread({ text: original });
  assert.equal(response.status, 200);
  assert.equal(mockedFetch.mock.callCount(), 1);
  assert.deepEqual(await response.json(), {
    text: corrected, provider: "agentrouter", model: "deepseek-v4-flash", fallbackUsed: false,
  });
});

const primaryFailures = [
  ...[401, 403, 429, 500, 503].map(status => [
    `HTTP ${status}`, () => new Response("upstream failure", { status }),
  ]),
  ["network errors", () => { throw new TypeError("Network failure"); }],
  ["HTML verification pages with HTTP 200", () => new Response("<!doctype html>Verification required")],
  ["null JSON", () => Response.json(null)],
  ["empty responses", () => agentRouterResponse("   ")],
  ["truncated responses", () => agentRouterResponse("Partial correction", "length")],
];

for (const [name, failure] of primaryFailures) {
  test(`proofreading falls back to Gemini after ${name}`, async t => {
    const urls = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      urls.push(url);
      if (url === agentRouterEndpoint) return failure();
      assert.equal(url, geminiEndpoint);
      assert.equal(init.headers["x-goog-api-key"], env.GEMINI_API_KEY);
      assert.equal(init.headers.Authorization, undefined);
      const body = JSON.parse(init.body);
      assert.equal(body.contents[0].parts[0].text, "This are correct.");
      assert.match(body.systemInstruction.parts[0].text, /You are a proofreader/);
      assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "minimal");
      assert.equal(body.generationConfig.temperature, undefined);
      return geminiResponse();
    });

    const response = await proofread();
    assert.equal(response.status, 200);
    assert.deepEqual(urls, [agentRouterEndpoint, geminiEndpoint]);
    assert.deepEqual(await response.json(), {
      text: "This is correct.", provider: "gemini", model: "gemini-3.5-flash-lite", fallbackUsed: true,
    });
  });
}

test("a missing primary key skips AgentRouter and Gemini returns only final text parts", async t => {
  const mockedFetch = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, geminiEndpoint);
    assert.equal(JSON.parse(init.body).contents[0].parts[0].text, "  He are here.\n");
    return Response.json({ candidates: [{
      finishReason: "STOP",
      content: { parts: [{ thought: true, text: "Internal thought" }, { text: "  He " }, { text: "is here.\n" }] },
    }] });
  });

  const response = await proofread({ text: "  He are here.\n" }, { GEMINI_API_KEY: env.GEMINI_API_KEY });
  assert.equal(response.status, 200);
  assert.equal(mockedFetch.mock.callCount(), 1);
  assert.equal((await response.json()).text, "  He is here.\n");
});

test("provider base and model aliases can be configured without changing secrets", async t => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://agentrouter.org/v1/chat/completions");
    assert.equal(JSON.parse(init.body).model, "deepseek-flash-account-alias");
    return agentRouterResponse();
  });
  const response = await proofread(undefined, {
    ...env, AGENTROUTER_BASE_URL: "https://agentrouter.org/v1///", AGENTROUTER_MODEL: "deepseek-flash-account-alias",
  });
  assert.equal((await response.json()).model, "deepseek-flash-account-alias");
});

test("when both providers fail the response has safe diagnostics without keys or user text", async t => {
  t.mock.method(globalThis, "fetch", async url => {
    if (url === agentRouterEndpoint) {
      return Response.json({ error: `rejected ${env.agentrouter_key}` }, { status: 401 });
    }
    throw new Error(`URL contained key=${env.GEMINI_API_KEY}`);
  });
  const response = await proofread({ text: "Private user input must not appear in errors" });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const raw = await response.text();
  assert.ok(!raw.includes(env.agentrouter_key));
  assert.ok(!raw.includes(env.GEMINI_API_KEY));
  assert.ok(!raw.includes("Private user input"));
  const data = JSON.parse(raw);
  assert.equal(data.providers[0].error.code, "http_error");
  assert.equal(data.providers[0].error.upstreamStatus, 401);
  assert.equal(data.providers[1].error.code, "request_failed");
});

for (const phase of ["connection", "response body"]) {
  test(`a primary ${phase} timeout triggers fallback after 20 seconds`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const mockedFetch = t.mock.method(globalThis, "fetch", async (url, init) => {
      if (url === geminiEndpoint) return geminiResponse();
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
    assert.equal(mockedFetch.mock.callCount(), 1);
    t.mock.timers.tick(20_000);
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(mockedFetch.mock.callCount(), 2);
    assert.equal((await response.json()).fallbackUsed, true);
  });
}

test("health probes both models concurrently with small real generation requests", async t => {
  const resolvers = [];
  const mockedFetch = t.mock.method(globalThis, "fetch", (url, init) => {
    const body = JSON.parse(init.body);
    if (url === agentRouterEndpoint) {
      assert.equal(body.max_tokens, 32);
      assert.equal(body.messages[1].content, "Reply with exactly OK.");
    } else {
      assert.equal(url, geminiEndpoint);
      assert.equal(body.generationConfig.maxOutputTokens, 32);
      assert.equal(body.contents[0].parts[0].text, "Reply with exactly OK.");
    }
    return new Promise(resolve => resolvers.push(resolve));
  });

  const pending = health();
  assert.equal(mockedFetch.mock.callCount(), 2, "both requests start before either provider replies");
  resolvers[1](geminiResponse("OK"));
  resolvers[0](agentRouterResponse("OK"));
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const raw = await response.text();
  assert.ok(!raw.includes(env.agentrouter_key));
  assert.ok(!raw.includes(env.GEMINI_API_KEY));
  const data = JSON.parse(raw);
  assert.equal(data.status, "healthy");
  assert.ok(Number.isFinite(Date.parse(data.checkedAt)));
  assert.deepEqual(data.providers.map(provider => [provider.provider, provider.role, provider.working]), [
    ["agentrouter", "primary", true], ["gemini", "backup", true],
  ]);
  assert.deepEqual(data.providers.map(provider => provider.endpoint), [agentRouterEndpoint, geminiEndpoint]);
  for (const provider of data.providers) {
    assert.equal(provider.configured, true);
    assert.ok(provider.latencyMs >= 0);
  }
});

for (const failingProvider of ["agentrouter", "gemini"]) {
  test(`health is degraded when only ${failingProvider} fails`, async t => {
    t.mock.method(globalThis, "fetch", async url => {
      const provider = url === agentRouterEndpoint ? "agentrouter" : "gemini";
      if (provider === failingProvider) return Response.json({ error: "Unavailable" }, { status: 503 });
      return provider === "agentrouter" ? agentRouterResponse("OK") : geminiResponse("OK");
    });
    const response = await health();
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.status, "degraded");
    const failed = data.providers.find(provider => provider.provider === failingProvider);
    assert.equal(failed.working, false);
    assert.equal(failed.error.upstreamStatus, 503);
    assert.equal(data.providers.filter(provider => provider.working).length, 1);
  });
}

test("health rejects HTML gateway responses and blocked Gemini output", async t => {
  t.mock.method(globalThis, "fetch", async url => url === agentRouterEndpoint
    ? new Response("<html>Verification required</html>")
    : geminiResponse("", "SAFETY"));
  const response = await health();
  assert.equal(response.status, 503);
  const data = await response.json();
  assert.equal(data.status, "unhealthy");
  assert.deepEqual(data.providers.map(provider => provider.error.code), ["invalid_response", "incomplete_response"]);
});

for (const path of ["/health", "/api/health"]) {
  test(`${path} reports missing credentials without calling providers`, async t => {
    const mockedFetch = t.mock.method(globalThis, "fetch", () => assert.fail("No credentials: do not make requests"));
    const response = await health({}, path);
    assert.equal(response.status, 503);
    assert.equal(mockedFetch.mock.callCount(), 0);
    const data = await response.json();
    assert.equal(data.status, "unhealthy");
    for (const provider of data.providers) {
      assert.equal(provider.configured, false);
      assert.equal(provider.working, false);
      assert.equal(provider.error.code, "missing_api_key");
    }
  });
}

test("health times out a stalled provider independently after 10 seconds", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === geminiEndpoint) return geminiResponse("OK");
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  });
  const pending = health();
  await setImmediate();
  t.mock.timers.tick(10_000);
  const response = await pending;
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.status, "degraded");
  assert.equal(data.providers[0].error.code, "timeout");
  assert.equal(data.providers[1].working, true);
});

for (const body of [null, {}, { text: "" }, { text: " \n\t" }, { text: 42 }, { text: {} }, { text: ["hello"] }]) {
  test(`invalid proofreading input returns 400: ${JSON.stringify(body)}`, async t => {
    const mockedFetch = t.mock.method(globalThis, "fetch", () => assert.fail("Invalid input must not reach providers"));
    assert.equal((await proofread(body)).status, 400);
    assert.equal(mockedFetch.mock.callCount(), 0);
  });
}

test("malformed JSON returns 400 without calling providers", async t => {
  const mockedFetch = t.mock.method(globalThis, "fetch", () => assert.fail("Invalid JSON must not reach providers"));
  const response = await worker.fetch(new Request("https://grammar.example/api/proofread", {
    method: "POST", body: "{",
  }), env);
  assert.equal(response.status, 400);
  assert.equal(mockedFetch.mock.callCount(), 0);
});

test("health preflight does not trigger AI requests", async t => {
  const mockedFetch = t.mock.method(globalThis, "fetch", () => assert.fail("Preflight must not reach providers"));
  const response = await worker.fetch(new Request("https://grammar.example/health", { method: "OPTIONS" }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(response.headers.get("Access-Control-Allow-Methods"), /GET/);
  assert.equal(mockedFetch.mock.callCount(), 0);
});
