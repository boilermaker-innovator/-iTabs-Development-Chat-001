// Offline tests: run the real worker with in-memory KV and a scripted Gemini/YouTube.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { validateDeck, parseVideoId, renderDeck } from "../dist/worker.js";

function memKV() {
  const m = new Map();
  return { m, async get(k) { return m.has(k) ? m.get(k).v : null; }, async put(k, v, o = {}) { m.set(k, { v, o }); } };
}
const card = (i, extra = {}) => ({
  band: `Point ${i}`, colors: "#1e3a8a,#38bdf8", time: `${i}:05`, seconds: i * 60 + 5,
  headline: "A short headline here", summary: "One sentence. Two sentences.",
  buttons: [{ you: true, title: "For your van", text: "• Do this\n• Then that" }, { title: "Definition", type: "Definition", text: "Background." }],
  ...extra,
});
const goodDeck = (n = 7) => ({ videoTitle: "T", channel: "C", videoId: "x", durationSeconds: 600, forWho: "a coffee van owner in Perth", youLabel: "For your van", cards: Array.from({ length: n }, (_, i) => card(i + 1)) });

// Scripted fetch: queue of Gemini replies; YouTube oEmbed + watch page canned.
let geminiQueue = [], calls = [], ytSeconds = 600, ytStatus = 200;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push({ url, body: init.body });
  if (url.includes("/oembed")) return ytStatus === 200 ? Response.json({ title: "Real Title", author_name: "Real Channel" }) : new Response("", { status: ytStatus });
  if (url.includes("youtube.com/watch")) return new Response(`..."lengthSeconds":"${ytSeconds}"...`);
  if (url.endsWith("/v1beta/models?pageSize=1000")) return Response.json({ models: [
    { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-9-flash-preview", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.8-flash-lite", supportedGenerationMethods: ["generateContent"] },
  ] });
  if (url.includes(":generateContent")) {
    const next = geminiQueue.shift();
    if (!next) throw new Error("unexpected Gemini call");
    if (next.status) return new Response(next.text || "{}", { status: next.status });
    return Response.json({ candidates: [{ content: { parts: [{ text: typeof next === "string" ? next : JSON.stringify(next) }] } }] });
  }
  throw new Error("unexpected fetch " + url);
};

const env = () => ({ GEMINI_API_KEY: "k", GEMINI_MODEL: "auto", DECKS: memKV() });
const post = (e, body, ip = "1.2.3.4") => worker.fetch(new Request("https://x.dev/api/make", {
  method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify(body) }), e);
const base = { url: "https://youtu.be/dQw4w9WgXcQ?si=abc", about: "I run a coffee van in Perth", lang: "en" };
test.beforeEach(() => { geminiQueue = []; calls = []; ytSeconds = 600; ytStatus = 200; });

test("parses YouTube links", () => {
  assert.equal(parseVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10"), "dQw4w9WgXcQ");
  assert.equal(parseVideoId("youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(parseVideoId("https://m.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(parseVideoId("https://vimeo.com/123"), null);
});

test("happy path: makes, saves and serves a deck", async () => {
  const e = env();
  geminiQueue.push(goodDeck());
  const r = await post(e, base); const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.match(j.path, /^\/d\/[A-Za-z0-9]{8}$/);
  const g = calls.find((c) => c.url.includes(":generateContent"));
  assert.ok(g.url.includes("/models/gemini-3.8-flash:generateContent"), "picks newest stable flash: " + g.url);
  const sent = JSON.parse(g.body);
  assert.equal(sent.contents[0].parts[0].fileData.fileUri, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(sent.generationConfig.responseMimeType, "application/json");
  const page = await worker.fetch(new Request("https://x.dev" + j.path), e);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(html.includes('"videoTitle": "Real Title"') && html.includes('"videoId": "dQw4w9WgXcQ"'));
  assert.ok(html.includes("Any YouTube video, applied to you."));
});

test("invalid JSON is retried once, with the errors sent back", async () => {
  const e = env();
  const bad = goodDeck(); bad.cards[2].buttons.reverse();
  geminiQueue.push("not json at all", goodDeck());
  let r = await post(e, base); assert.equal(r.status, 200); assert.equal((await r.json()).attempts, 2);
  geminiQueue.push(bad, bad);
  r = await post(e, base, "9.9.9.9"); assert.equal(r.status, 502);
  const second = JSON.parse(calls.filter((c) => c.url.includes(":generateContent")).at(-1).body);
  assert.match(second.contents[0].parts.at(-1).text, /must be first/);
});

test("unreadable video asks for transcript; transcript retry works", async () => {
  const e = env();
  geminiQueue.push({ status: 400, text: '{"error":{"message":"Cannot fetch content from the provided URL."}}' });
  let r = await post(e, base); let j = await r.json();
  assert.equal(j.needTranscript, true);
  geminiQueue.push(goodDeck());
  r = await post(e, { ...base, transcript: "0:00 hello ".repeat(40) }); j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  const sent = JSON.parse(calls.filter((c) => c.url.includes(":generateContent")).at(-1).body);
  assert.equal(sent.contents[0].parts.length, 1);
  assert.match(sent.contents[0].parts[0].text, /<transcript>/);
});

test("rejects videos over 60 minutes before calling Gemini", async () => {
  ytSeconds = 3700;
  const r = await post(env(), base); const j = await r.json();
  assert.equal(r.status, 400); assert.match(j.error, /under 60 minutes/);
  assert.ok(!calls.some((c) => c.url.includes(":generateContent")));
});

test("3 decks per hour per visitor, 50 per day total", async () => {
  const e = env();
  for (let i = 0; i < 3; i++) { geminiQueue.push(goodDeck()); assert.equal((await post(e, base)).status, 200); }
  const r = await post(e, base); assert.equal(r.status, 429); assert.match((await r.json()).error, /3 iTabs an hour/);
  geminiQueue.push(goodDeck()); assert.equal((await post(e, base, "5.5.5.5")).status, 200, "other visitors still allowed");
  const day = new Date().toISOString().slice(0, 10);
  await e.DECKS.put(`n:decks:${day}`, "50");
  const r2 = await post(e, base, "6.6.6.6"); assert.equal(r2.status, 429); assert.match((await r2.json()).error, /today's limit/);
});

test("input checks give clear errors", async () => {
  const e = env();
  assert.match((await (await post(e, { ...base, url: "https://vimeo.com/1" })).json()).error, /YouTube link/);
  assert.match((await (await post(e, { ...base, about: "x".repeat(301) })).json()).error, /300/);
  assert.match((await (await post(e, { ...base, about: "" })).json()).error, /who's watching/);
  ytStatus = 404;
  assert.match((await (await post(e, base)).json()).error, /couldn't find that video/);
});

test("validator rejects unsafe colours/seconds and wrong card counts", () => {
  const d = goodDeck(); d.cards[0].colors = "red;}</style><script>"; d.cards[1].seconds = "1);alert(1";
  const v = validateDeck(d); assert.equal(v.ok, false); assert.ok(v.errors.some((x) => /colors/.test(x)));
  const d2 = goodDeck(); d2.cards[1].seconds = "1);alert(1"; const v2 = validateDeck(d2); assert.equal(v2.ok, true); assert.equal(v2.data.cards[1].seconds, 125);
  assert.equal(validateDeck(goodDeck(5)).ok, false); assert.equal(validateDeck(goodDeck(11)).ok, false);
});

test("injected data can't break out of the script tag", () => {
  const v = validateDeck(goodDeck()).data; v.cards[0].summary = "</script><script>alert(1)</script> ";
  const html = renderDeck(v);
  assert.equal(html.split("</script>").length, 2);
  assert.ok(html.includes("/* ===== ONLY EDIT THIS DATA BLOCK ===== */") && html.includes("/* ===== END DATA BLOCK ===== */"));
});

test("unknown deck and unknown page show friendly pages", async () => {
  const r = await worker.fetch(new Request("https://x.dev/d/nope1234"), env());
  assert.equal(r.status, 404); assert.match(await r.text(), /Deck not found/);
  const r2 = await worker.fetch(new Request("https://x.dev/"), env());
  assert.match(await r2.text(), /Make my iTabs/);
});
