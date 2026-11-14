# iTabs This Video

**Any YouTube video, applied to you.**

Someone pastes a YouTube link and says who's watching (for example, "I run a coffee van in Perth"). Gemini watches the video and makes a swipeable iTabs deck written for that person, with its own shareable link.

---

# Deploy it from your iPad

Everything happens in Safari. There are 5 parts and about 15 minutes in total.

> Cloudflare and GitHub sometimes rename buttons. If a button isn't exactly where these steps say, look for the closest match on the same screen.

## Part A: Get your Gemini key (2 minutes)

1. Open **aistudio.google.com/apikey** in Safari and sign in with your Google account.
2. Tap **Create API key**.
3. If it asks you to pick a project, choose any project (or tap **Create API key in new project**).
4. Tap the **copy** icon next to the new key.
5. Paste the key into the Notes app for now. You'll need it in Part D. Don't send it to anyone.

## Part B: Create the KV storage for decks (3 minutes)

6. Open **dash.cloudflare.com** and log in.
7. In the left menu, tap **Storage & databases**. On a narrow screen, tap the **☰** menu icon first.
8. Tap **Workers KV**.
9. Tap the blue **Create Instance** button. It may say **Create namespace**.
10. In **Namespace name**, type `itabs-decks`.
11. Tap **Create**.
12. You're now back at the list. Find `itabs-decks` and look at its **ID** column: a long code of letters and numbers.
13. Tap the **copy** icon next to that ID. If there's no icon, press and hold the ID, tap **Select All**, then tap **Copy**.

## Part C: Put that ID into the code on GitHub (3 minutes)

14. Open **github.com/boilermaker-innovator/itabs-this-video** in a new Safari tab.
15. Tap the file named **wrangler.toml**.
16. Tap the **pencil icon ✏️** (top right of the file) to edit it.
17. Find this line:
    `id = "PASTE-KV-ID-HERE"`
18. Select only the words **PASTE-KV-ID-HERE**. Keep the quote marks around them.
19. Paste your ID. The line should now look like `id = "a1b2c3…"`: your ID, still inside quote marks.
20. Tap the green **Commit changes…** button (top right).
21. In the box that pops up, tap the green **Commit changes** button again.

## Part D: Connect the GitHub repo to Cloudflare (5 minutes)

22. Go back to the Cloudflare tab. In the left menu, tap **Compute (Workers)**, then **Workers & Pages**. On some accounts it's just **Workers & Pages**.
23. Tap the blue **Create** button. It may say **Create application**.
24. Tap **Import a repository**. It may say **Connect to Git** or **Continue with GitHub**.
25. If it asks you to connect GitHub, tap **Connect GitHub**. On the GitHub page, choose your account and tap **Only select repositories**. Pick **itabs-this-video** and tap **Install & Authorize**. You'll come back to Cloudflare.
26. In the list of repositories, tap **itabs-this-video**. Then tap **Begin setup** (or **Next**).
27. Check the settings on the next screen:
    - **Project name:** `itabs-this-video`. It must be exactly this.
    - **Build command:** leave empty.
    - **Deploy command:** `npx wrangler deploy`. This is usually filled in already.
    - **Root directory / Path:** leave as `/`.
28. Tap **Create and deploy** (or **Deploy**).
29. Wait 1 to 2 minutes until it says **Success**. If it says **Failed**, re-check Part C: the ID must sit inside the quote marks.

## Part E: Add the Gemini key as an encrypted secret (2 minutes)

30. Still in Cloudflare, tap **Continue to project** (or open **Workers & Pages** and tap **itabs-this-video**).
31. Tap the **Settings** tab.
32. Scroll to **Variables and Secrets** and tap **+ Add**.
33. Next to **Type**, tap the dropdown and choose **Secret**. Don't choose "Text". Secret means encrypted and hidden.
34. In **Variable name**, type exactly: `GEMINI_API_KEY`
35. In **Value**, paste your Gemini key from Notes.
36. Tap **Deploy** (or **Save and deploy**).
37. Delete the key from your Notes app.

## Try it

38. On the Worker's page, tap the **Visit** link. It ends in `.workers.dev`, for example `itabs-this-video.yourname.workers.dev`.
39. Paste a public YouTube link (under 60 minutes). Type who's watching and tap **Make my iTabs**.
40. Wait 20 to 60 seconds. You'll get your deck link, a **Copy link** button and **Make another**.

### If something goes wrong

| What you see | What to do |
|---|---|
| "missing GEMINI_API_KEY secret" | Redo Part E. Check the name is spelled exactly `GEMINI_API_KEY`. |
| "The site's AI key isn't working" | Make a new key (Part A), then on the Worker: **Settings** → **Variables and Secrets** → tap the **⋯** or pencil next to `GEMINI_API_KEY` → paste the new key → **Deploy**. |
| The deploy in step 29 says **Failed** | Go back to Part C and check the ID line. Saving the file on GitHub redeploys automatically. |
| Anything else | On the Worker, open the **Logs** (or **Observability**) tab to see what happened, or send a screenshot of the message. |

### Updating later

Any change saved to the GitHub repo deploys by itself within a couple of minutes. Your stored decks and your secret key stay as they are.

### Custom domain later (video.itabs.co)

This works once `itabs.co` is on Cloudflare in the same account:

1. Open the Worker.
2. Tap **Settings** → **Domains & Routes** → **+ Add** → **Custom domain**.
3. Type `video.itabs.co`, then tap **Add domain**.

Old workers.dev links keep working.

---

## For developers

| What | Details |
|---|---|
| `src/worker.js` | All server logic: `/` is the form, `POST /api/make` builds a deck, `/d/<id>` shows one |
| `src/page.html` | The form page |
| `src/template.html` | The iTabs deck template, used unchanged. Only the DATA block between the markers is replaced. |
| `dist/worker.js` | Single-file build, for pasting straight into the dashboard editor. Rebuild with `npm run bundle`. |
| `npm test` | Rebuilds `dist/` and runs the offline tests, which use a simulated Gemini |
| `GEMINI_API_KEY=… node scripts/live-test.mjs "<youtube url>" "<who>" en` | A real end-to-end run. Writes `live-deck.html`. |

Command-line setup, as an alternative to the dashboard:

1. `npx wrangler kv namespace create DECKS`, then put the printed ID in `wrangler.toml`.
2. `npx wrangler secret put GEMINI_API_KEY`
3. `npx wrangler deploy`

**The AI step.** Gemini gets the YouTube URL as video input (`fileData.fileUri`, low media resolution) and is asked for JSON only. The model is chosen by `GEMINI_MODEL`; `auto` means the newest stable `gemini-X-flash` the key can use. The answer is checked:

- 6–10 cards
- exactly one blue "you" button, and it comes first
- 1–2 gold buttons
- hex colours
- whole-number timestamps

If the answer fails, Gemini retries once with the list of problems. Title and channel come from YouTube oEmbed, and the video ID always comes from the link. If Gemini can't open the video, the page asks the person to paste the transcript.

**Limits** (the `LIMITS` object in `src/worker.js`):

| Limit | Value |
|---|---|
| Decks per day, everyone together | 50 |
| Decks per hour, per visitor (by IP) | 3 |
| Gemini calls per day / per hour per visitor | 150 / 8 (failed attempts cost money too) |
| Longest video | 60 minutes. Checked against YouTube before calling Gemini, and against Gemini's answer. |
| Description | 300 characters |
| Pasted transcript | 60,000 characters |

IPs are only stored as a hash, for 2 hours.
