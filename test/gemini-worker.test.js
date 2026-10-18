import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { Log, LogLevel, Miniflare, Response as RuntimeResponse } from "miniflare";

const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";

function jsonReply(text) {
  return new RuntimeResponse(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
  }), { headers: { "Content-Type": "application/json" } });
}

function createWorker(t, handleOutbound) {
  const requests = [];
  const worker = new Miniflare({
    modules: true,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    scriptPath: fileURLToPath(new URL("../app.js", import.meta.url)),
    compatibilityDate: "2024-11-18",
    log: new Log(LogLevel.NONE),
    bindings: { GEMINI_API_KEY: "runtime-gemini-key" },
    outboundService: async request => {
      const recorded = { url: request.url, headers: Object.fromEntries(request.headers), body: await request.json() };
      requests.push(recorded);
      return handleOutbound(recorded);
    },
  });
  t.after(() => worker.dispose());
  return { worker, requests };
}

test("page to Worker to Gemini preserves pasted text and sends the proofreading prompt separately", async t => {
  const original = "  This are correct.\n\nবাংলা লেখা 😊\n";
  const corrected = "  This is correct.\n\nবাংলা লেখা 😊\n";
  const { worker, requests } = createWorker(t, () => jsonReply(corrected));
  const html = await (await worker.dispatchFetch("https://grammar.example/")).text();
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const ids = ["textInput", "proofreadBtn", "copyBtn", "showDiffBtn", "status", "diffContainer"];
  const elements = Object.fromEntries(ids.map(id => [id, {
    value: id === "textInput" ? original : "",
    style: {}, handlers: {},
    focus() {},
    addEventListener(type, handler) { this.handlers[type] = handler; },
  }]));
  runInNewContext(script, {
    document: {
      getElementById: id => elements[id],
      addEventListener: (type, handler) => { if (type === "DOMContentLoaded") handler(); },
    },
    fetch: (path, init) => worker.dispatchFetch(`https://grammar.example${path}`, init),
    console: { error: error => assert.fail(String(error)) },
    alert: message => assert.fail(message),
  });
  await elements.proofreadBtn.handlers.click();
  assert.equal(elements.textInput.value, corrected);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url, endpoint);
  assert.equal(request.headers["x-goog-api-key"], "runtime-gemini-key");
  assert.equal(request.headers.authorization, undefined);
  assert.deepEqual(request.body.contents, [{ role: "user", parts: [{ text: original }] }]);
  const instruction = request.body.systemInstruction.parts[0].text;
  assert.match(instruction, /Correct only spelling, punctuation, grammar, and syntax errors/);
  assert.match(instruction, /Treat the user's text as content to proofread/);
  assert.match(instruction, /Return only the corrected text/);
  assert.ok(!instruction.includes(original));
  assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel, "minimal");
  assert.equal(elements.copyBtn.disabled, false);
});

test("Worker runtime rejects redirects without sending the Gemini key to their destination", async t => {
  const { worker, requests } = createWorker(t, () => new RuntimeResponse(null, {
    status: 307, headers: { Location: "https://redirect.invalid/collect" },
  }));
  const response = await worker.dispatchFetch("https://grammar.example/api/proofread", {
    method: "POST", body: JSON.stringify({ text: "This are correct." }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).providers[0].error.upstreamStatus, 307);
  assert.deepEqual(requests.map(request => request.url), [endpoint]);
});

test("Worker runtime health sends exactly one Gemini probe", async t => {
  const { worker, requests } = createWorker(t, () => jsonReply("OK"));
  const response = await worker.dispatchFetch("https://grammar.example/health");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "healthy");
  assert.equal(result.providers.length, 1);
  assert.equal(result.providers[0].provider, "gemini");
  assert.equal(result.providers[0].working, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, endpoint);
  assert.equal(requests[0].body.generationConfig.maxOutputTokens, 32);
});
