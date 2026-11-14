# iTabs This Video

**Any YouTube video, applied to you.**

Someone pastes a YouTube link and says who's watching (for example, "I run a coffee van in Perth"). Gemini watches the video and makes a swipeable iTabs deck written for that person. The deck gets its own shareable link.

One Cloudflare Worker does everything:

| Address | What it does |
|---|---|
| `/` | The form page |
| `/api/make` | Asks Gemini, checks the answer, saves the deck |
| `/d/<id>` | Shows a saved deck (your `template.html`, with only the DATA block filled in) |

---

## Before you start (5 minutes)

1. **A Cloudflare account.** The free plan is enough: <https://dash.cloudflare.com/sign-up>
2. **A Gemini API key.** Go to <https://aistudio.google.com/apikey>, tap **Create API key**, and copy it. Keep it private. Don't paste it into any file, chat or message.

---

## Deploy from an iPad (no coding, all in Safari)

> Cloudflare sometimes renames its menus. If a button below has a slightly different name, look for the closest match.

### Step 1: Create the storage for decks (KV)

1. Open <https://dash.cloudflare.com> and log in.
2. In the left menu, tap **Storage & databases** → **Workers KV**.
3. Tap **Create instance** (it may say **Create namespace**).
4. Name it `itabs-decks` and tap **Create**.

### Step 2: Create the Worker

1. In the left menu, tap **Workers & Pages** (it may be under **Compute**).
2. Tap **Create** → **Workers** → **Start with Hello World!**
3. Name it `itabs-video` and tap **Deploy**.
4. Tap **Edit code**.

### Step 3: Paste in the code

1. In a new Safari tab, open this project on GitHub and go to `itabs-video/dist/worker.js`.
2. Tap the **Copy raw file** button (two overlapping squares, top right of the file).
3. Go back to the Cloudflare editor tab. Tap inside the code, choose **Select All**, and delete it.
4. Paste. Make sure the very first line starts with `// iTabs This Video: single-file build`.
5. Tap **Deploy** (top right), then go back to the Worker's page.

### Step 4: Connect the storage

1. On the Worker's page, open **Settings** → **Bindings** → **Add binding**.
2. Choose **KV namespace**.
3. **Variable name:** `DECKS` (capital letters, exactly like that).
4. **KV namespace:** choose `itabs-decks`.
5. Tap **Add binding** (or **Deploy**).

### Step 5: Add the Gemini key as a secret

1. Still in **Settings**, open **Variables and Secrets** → **Add**.
2. **Type:** choose **Secret**. (Not "Text". A secret stays hidden, even from you.)
3. **Variable name:** `GEMINI_API_KEY`
4. **Value:** paste your Gemini key.
5. Tap **Deploy** (or **Save**).

*Optional:* add a **Text** variable named `GEMINI_MODEL` with the value `auto`. The site already uses `auto` when this is missing. `auto` means it picks the newest Gemini Flash model your key can use. To force a particular model, put that model's exact name here instead.

### Step 6: Try it

1. On the Worker's page, tap the `itabs-video.<your-name>.workers.dev` link.
2. Paste a public YouTube video under 60 minutes, type who's watching, and tap **Make my iTabs**.
3. Wait 20 to 60 seconds. You should get a link, a **Copy link** button and **Make another**.

**If something goes wrong**, the page shows a plain message:

| Message | What to do |
|---|---|
| "missing GEMINI_API_KEY secret" | Redo Step 5. |
| "missing DECKS storage" | Redo Step 4. Check the name is exactly `DECKS`. |
| "The site's AI key isn't working" | The key was pasted wrong or was deleted in AI Studio. Make a new key and redo Step 5. |

To see what the Worker is doing, open the Worker → **Observability** (or **Logs**).

### Updating the site later

When the code changes, repeat Step 3 with the new `dist/worker.js`. Your storage, your secret and every saved deck stay as they are.

---

## Deploy with commands (computer, or GitHub Codespaces in Safari)

You only need this route if you'd rather use a terminal. To get one on an iPad: on the GitHub repo page, tap **Code** → **Codespaces** → **Create codespace**, and a terminal opens at the bottom. In Codespaces, `wrangler login` can't open its login page. Use an API token instead: in Cloudflare go to **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"** template, then run `export CLOUDFLARE_API_TOKEN=...` with your token before the commands below.

```bash
cd itabs-video
npm install

# 1. Log in (skip this if you set CLOUDFLARE_API_TOKEN)
npx wrangler login

# 2. Create the KV namespace. It prints an id.
npx wrangler kv namespace create DECKS
#    Copy the id it prints into wrangler.toml, replacing PASTE_YOUR_KV_NAMESPACE_ID_HERE

# 3. Add the Gemini key as a secret (it asks you to paste it, and nothing is shown)
npx wrangler secret put GEMINI_API_KEY

# 4. Deploy
npx wrangler deploy
```

Other useful commands:

```bash
npm test                      # rebuilds dist/worker.js and runs the offline tests
npm run bundle                # rebuilds dist/worker.js only (the paste-in file)
npx wrangler tail             # watch live logs
GEMINI_API_KEY=... node scripts/live-test.mjs "https://youtu.be/VIDEO" "I run a coffee van in Perth" en
                              # real end-to-end run from your machine; writes live-deck.html
```

For local testing with `npx wrangler dev`, put `GEMINI_API_KEY=...` in a file named `.dev.vars`. That file is git-ignored, so it never gets committed.

---

## Custom domain (later): video.itabs.co

This needs `itabs.co` to be managed by Cloudflare (added as a site in the same account).

- **Dashboard:** Worker → **Settings** → **Domains & Routes** → **Add** → **Custom domain** → `video.itabs.co`.
- **Commands:** in `wrangler.toml`, remove the `#` in front of the `routes = …` line, then run `npx wrangler deploy`.

Deck links made on workers.dev keep working, and the same decks also open at `video.itabs.co/d/<id>`.

---

## How it works

**The AI step** (`src/worker.js`)
- Sends Gemini the YouTube URL as video input (`fileData.fileUri`) plus a prompt that includes the viewer's description and language. Asks for JSON only (`responseMimeType: application/json`).
- Uses low media resolution, which uses about three times fewer tokens. That keeps a 60-minute video affordable and inside the model's context window.
- Checks the answer: 6 to 10 cards; every field present; exactly one blue "you" button and it comes first; 1 or 2 gold buttons; colours are real hex codes; timestamps are numbers. If the answer fails, it asks Gemini once more and tells it exactly what was wrong. Only a valid deck gets saved.
- Title and channel come from YouTube's own oEmbed lookup when possible. The video ID always comes from the link, never from the AI.

**If Gemini can't watch the video** (private, restricted, unavailable or an error), the page shows **"Paste the transcript instead"** and tries again using the text.

**Safety and cost**

| Rule | Where to change it |
|---|---|
| 50 decks per day in total | `LIMITS` at the top of `src/worker.js` |
| 3 decks per hour per visitor (by IP) | same |
| Extra cap on Gemini calls: 150 per day, 8 per hour per visitor | same. Failed attempts still cost money, so they're capped too |
| Videos over 60 minutes are rejected | same. Checked against YouTube before calling Gemini, and checked again against Gemini's answer |
| Description up to 300 characters, transcript up to 60,000 | same |

- Visitor IPs are never stored. Only a scrambled (hashed) version is kept, for two hours, to count requests.
- The viewer's description goes to Gemini as data, never as instructions. Every piece of deck text is escaped before it's shown.

**Files**

| File | What it is |
|---|---|
| `src/worker.js` | All the server logic |
| `src/page.html` | The form page |
| `src/template.html` | Your deck template, unchanged. Only the DATA block is replaced. |
| `dist/worker.js` | Everything above in one file, for pasting into the dashboard. Rebuild it with `npm run bundle`. |
| `wrangler.toml` | Cloudflare settings for the command route |
| `test/` | Offline tests |
| `scripts/live-test.mjs` | Real end-to-end test |
