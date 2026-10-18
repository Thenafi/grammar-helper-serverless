import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Log, LogLevel, Miniflare, Response as RuntimeResponse } from "miniflare";

const primaryEndpoint = "https://agentrouter.org/v1/chat/completions";
const backupEndpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";

function jsonReply(value, status = 200) {
  return new RuntimeResponse(JSON.stringify(value), {
    status, headers: { "Content-Type": "application/json" },
  });
}

function primaryReply() {
  return jsonReply({ choices: [{ message: { content: "This is correct." }, finish_reason: "stop" }] });
}

function backupReply() {
  return jsonReply({ candidates: [{ content: { parts: [{ text: "This is correct." }] }, finishReason: "STOP" }] });
}

function createWorker(t, handleOutbound) {
  const requests = [];
  const worker = new Miniflare({
    modules: true,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    scriptPath: fileURLToPath(new URL("../app.js", import.meta.url)),
    compatibilityDate: "2024-11-18",
    log: new Log(LogLevel.NONE),
    bindings: { agentrouter_key: "runtime-primary-key", GEMINI_API_KEY: "runtime-backup-key" },
    outboundService: async request => {
      const recorded = {
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: await request.json(),
      };
      requests.push(recorded);
      return handleOutbound(recorded);
    },
  });
  t.after(() => worker.dispose());
  return { worker, requests };
}

function proofread(worker) {
  return worker.dispatchFetch("https://grammar.example/api/proofread", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "This are correct." }),
  });
}

test("Worker runtime can send an authenticated proofreading request to the requested AgentRouter host", async t => {
  const { worker, requests } = createWorker(t, () => primaryReply());
  const response = await proofread(worker);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    text: "This is correct.", provider: "agentrouter", model: "deepseek-v4-flash", fallbackUsed: false,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, primaryEndpoint);
  assert.equal(requests[0].headers.authorization, "Bearer runtime-primary-key");
  assert.equal(requests[0].body.model, "deepseek-v4-flash");
});

test("Worker runtime reaches Gemini with its own credential after a primary HTTP failure", async t => {
  const { worker, requests } = createWorker(t, request => request.url === primaryEndpoint
    ? jsonReply({ error: { message: "Unavailable" } }, 503)
    : backupReply());
  const response = await proofread(worker);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).provider, "gemini");
  assert.deepEqual(requests.map(request => request.url), [primaryEndpoint, backupEndpoint]);
  assert.equal(requests[1].headers["x-goog-api-key"], "runtime-backup-key");
  assert.equal(requests[1].headers.authorization, undefined);
});

test("Worker runtime rejects redirects without sending credentials to their destination", async t => {
  const { worker, requests } = createWorker(t, request => request.url === primaryEndpoint
    ? new RuntimeResponse(null, { status: 307, headers: { Location: "https://redirect.invalid/collect" } })
    : backupReply());
  const response = await proofread(worker);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).fallbackUsed, true);
  assert.deepEqual(requests.map(request => request.url), [primaryEndpoint, backupEndpoint]);
});

test("Worker runtime health checks make valid outbound requests to both providers", async t => {
  const { worker, requests } = createWorker(t, request => request.url === primaryEndpoint ? primaryReply() : backupReply());
  const response = await worker.dispatchFetch("https://grammar.example/health");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "healthy");
  assert.ok(result.providers.every(provider => provider.working));
  assert.deepEqual(requests.map(request => request.url).sort(), [primaryEndpoint, backupEndpoint].sort());
});
