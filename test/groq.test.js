import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import worker from "../app.js";
const env = { GROQ_KEY: "private-groq-key", GEMINI_API_KEY: "private-google-key" };
const endpoint = "https://api.groq.com/openai/v1/chat/completions";
const reply = text => Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }] });
const request = () => new Request("https://grammar.example/api/proofread", {
  method: "POST", body: JSON.stringify({ text: "  This are correct.\n" }),
});
beforeEach(t => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
});
test("Groq is primary and preserves exact text with separate instructions", async t => {
  const mocked = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, endpoint);
    assert.equal(init.headers.Authorization, `Bearer ${env.GROQ_KEY}`);
    assert.equal(init.headers["x-goog-api-key"], undefined);
    assert.equal(init.redirect, "manual");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "qwen/qwen3.8-27b");
    assert.equal(body.messages[0].role, "system");
    assert.match(body.messages[0].content, /Correct only spelling/);
    assert.deepEqual(body.messages[1], { role: "user", content: "  This are correct.\n" });
    assert.equal(body.reasoning_effort, "low");
    assert.equal(body.reasoning_format, "hidden");
    return reply("  This is correct.\n");
  });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    text: "  This is correct.\n", provider: "groq", model: "qwen/qwen3.8-27b", fallbackUsed: false,
  });
  assert.equal(mocked.mock.callCount(), 1);
});
for (const failure of [
  () => Response.json({ error: { message: "rate limited" } }, { status: 429 }),
  () => Response.json({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] }),
  () => reply(""),
  () => { throw new TypeError("network failure"); },
]) {
  test("Groq failure falls back to Gemini in order", async t => {
    const urls = [];
    t.mock.method(globalThis, "fetch", async url => {
      urls.push(url);
      if (url === endpoint) return failure();
      return Response.json({ candidates: [{ content: { parts: [{ text: "Correct." }] }, finishReason: "STOP" }] });
    });
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.provider, "gemini");
    assert.equal(result.fallbackUsed, true);
    assert.equal(urls.length, 2);
    assert.equal(urls[0], endpoint);
    assert.match(urls[1], /generativelanguage.googleapis.com/);
  });
}
test("health reports both providers and probes Groq with a small token limit", async t => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    if (url === endpoint) {
      assert.equal(body.max_completion_tokens, 1024);
      return reply("OK");
    }
    return Response.json({ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] });
  });
  const response = await worker.fetch(new Request("https://grammar.example/health"), env);
  const data = await response.json();
  assert.equal(data.status, "healthy");
  assert.deepEqual(data.providers.map(p => [p.provider, p.role, p.working]), [["groq", "primary", true], ["gemini", "fallback", true]]);
});
