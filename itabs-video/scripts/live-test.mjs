// Live end-to-end test: real Gemini, real YouTube video, in-memory storage.
// Usage: GEMINI_API_KEY=... node scripts/live-test.mjs "<youtube url>" "<who's watching>" [lang]
// Writes the finished deck to live-deck.html so you can open it.
import { writeFileSync } from "node:fs";
import worker from "../dist/worker.js";

const [url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ", about = "I run a coffee van in Perth", lang = "en"] = process.argv.slice(2);
const store = new Map();
const env = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "x", GEMINI_MODEL: process.env.GEMINI_MODEL || "auto",
  DECKS: { async get(k) { return store.get(k) ?? null; }, async put(k, v) { store.set(k, v); } },
};
const t0 = Date.now();
const r = await worker.fetch(new Request("https://local/api/make", {
  method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": "127.0.0.1" },
  body: JSON.stringify({ url, about, lang }),
}), env);
const j = await r.json();
console.log(`HTTP ${r.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`, j);
if (!j.path) process.exit(1);
const page = await worker.fetch(new Request("https://local" + j.path), env);
writeFileSync("live-deck.html", await page.text());
const data = JSON.parse(store.get("deck:" + j.id));
console.log(`${data.cards.length} cards for "${data.forWho}" (${data.youLabel})`);
for (const c of data.cards) console.log(`- [${c.time || "--"}] ${c.band}: ${c.headline}\n    YOU: ${c.buttons[0].text.replace(/\n/g, " | ")}`);
console.log("Saved live-deck.html");
