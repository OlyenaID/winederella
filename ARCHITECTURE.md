# Winederella — Architecture & Feature Reference

**Last updated:** 2026-07-16  
**Deployment:** Vercel (auto-deploys from GitHub `master`)  
**Live URL:** https://winederella.vercel.app

---

## Overview

Winederella is an AI wine guide web app powered by a character called **Wini** — a knowledgeable, dry-humoured wine friend for Australian home cooks, party hosts, and everyday wine lovers. Users can chat with Wini, send photos of wine labels or menus, and (when signed in) have their palate preferences saved and recalled across sessions.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Plain HTML + CSS + vanilla JS — single file, no build step |
| Backend | Vercel serverless functions (`api/*.js`) |
| AI model | Anthropic Claude (`claude-sonnet-4-6`) via `@anthropic-ai/sdk` |
| Preference extraction | Anthropic Claude (`claude-haiku-4-5`) — cheaper model for background tasks |
| Web search | Anthropic built-in `web_search_20250305` tool |
| Auth | Supabase — Google OAuth + email/password |
| Database | Supabase (PostgreSQL) with Row Level Security |
| Deployment | Vercel, connected to GitHub — push to `master` = auto-deploy |
| Package manager | npm (`package.json` in `/winederella`) |

---

## File Structure

```
winederella/
├── index.html              # Entire frontend — UI, styles, and JS in one file
├── package.json            # Node dependencies (Anthropic SDK, Supabase JS)
├── vercel.json             # Route rewrites for serverless functions
├── ARCHITECTURE.md         # This document
└── api/
    ├── chat.js             # Main chat endpoint — calls Claude with web search
    ├── config.js           # Returns Supabase public config to frontend
    ├── extract-palate.js   # Background preference extraction using Claude Haiku
    └── delete-account.js   # Account deletion using Supabase admin API
```

---

## Architecture

```
Browser (index.html)
    │
    ├── GET  /api/config          → returns Supabase URL + anon key
    │
    ├── POST /api/chat            → calls Claude (sonnet) with web search
    │                               returns filtered text-only response
    │
    ├── POST /api/extract-palate  → background call after each exchange
    │                               extracts + stores palate signals via Claude Haiku
    │
    └── POST /api/delete-account  → deletes user from Supabase auth
    
Supabase
    ├── Auth (Google OAuth, email/password)
    ├── conversations table  (RLS: user owns their own rows)
    ├── messages table       (RLS: user owns their own rows)
    └── palate_profile table (RLS: user owns their own row)
```

**Security model:**
- `ANTHROPIC_API_KEY` — Vercel env var, backend only, never sent to frontend
- `SUPABASE_SERVICE_ROLE_KEY` — Vercel env var, backend only (used by extract-palate, delete-account, chat for profile fetch)
- `SUPABASE_URL` + `SUPABASE_ANON_KEY` — served via `/api/config`; safe to expose (anon key is designed to be public; RLS enforces data access)
- Frontend never calls Anthropic directly — always via `/api/chat`

---

## Features

### 1. AI Chat — Wini

**File:** `api/chat.js`

The core feature. The frontend sends the full conversation history on every message; the backend calls Claude with the Wini system prompt and returns the response.

**How it works:**
- Frontend POSTs `{ messages, userId, recentRecommendations }` to `/api/chat`
- If `userId` is present, the backend fetches the user's palate profile from Supabase and prepends it to the system prompt as context
- Claude is called with the Wini system prompt + web search tool enabled (max 5 uses per response)
- Response content is filtered to text-only blocks before returning — tool_use, web_search_tool_result, and citation blocks are stripped so the frontend always reads `content[0].text` reliably
- Returns full Anthropic response object with filtered `content` array

**Conversation seeding:**
On page load, `init()` sends `[{ role: 'user', content: 'Hi' }]` to the API so Claude generates Wini's opening greeting in-character. The synthetic `Hi` message is hidden from the visible conversation history.

**Key config:**
- Model: `claude-sonnet-4-6`
- `max_tokens`: 2000
- Web search: `web_search_20250305`, max 5 uses per response
- System prompt: hardcoded in `api/chat.js` as `const SYSTEM_PROMPT`

**Multi-block text handling:** When web search fires mid-response, Claude splits its output across multiple `text` blocks (e.g. intro text → search → recommendations text). The backend concatenates all `text` blocks into one before returning, since the frontend only reads `content[0].text`. Returning just the first block silently truncated responses whenever a search ran partway through.

---

### 2. Web Search

**File:** `api/chat.js`

Wini can search the web for real product pages, prices, and shop links when a user is actually looking to buy — not on every chat.

**How it works:**
- `tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]` is passed to every Claude call
- Anthropic handles the search server-side — no client-side tool loop needed
- The system prompt directs Wini to pick specific wines from her own knowledge first, then search each by exact name (plus shop name if known) to find its real product page — never search a category, never link to a search results page
- The prompt also instructs Wini to search and narrate silently — the user sees only the final picks with links, not the search process or swap reasoning
- Text-only filtering (see multi-block handling above) ensures the frontend never sees raw search result or citation blocks

---

### 3. Image / Photo Analysis

**File:** `index.html`

Users can attach a photo via the camera icon in the input bar. Wini can read wine labels, wine lists, and menus.

**How it works:**
- Camera icon triggers a file input (`accept="image/*"`)
- On selection, the image is drawn onto a hidden canvas and resized to max 1024px on the longest side at 85% JPEG quality — keeps payloads under Vercel's 4.5MB body limit
- The base64-encoded image is appended to the message content array as `{ type: 'image', source: { type: 'base64', media_type, data } }`
- Sent to `/api/chat` alongside the text message; Claude handles multimodal input natively

---

### 3a. Message Rendering (Markdown)

**File:** `index.html` (`renderMarkdown()`)

Wini's responses are rendered from lightweight markdown, not raw HTML.

**Supported:** bold/italic (`**`, `*`), unordered/ordered lists, `[text](url)` links (rendered as clickable `<a target="_blank">` with the wine-link styling), and `---` horizontal rules (rendered as `<hr>` between recommendation blocks).

**Note:** This is a small hand-rolled parser, not a full markdown library — it covers exactly what the Wini system prompt is expected to produce. If the prompt starts using markdown features outside this set (tables, headings, nested lists), the renderer needs a matching update.

---

### 4. Authentication

**File:** `index.html` (auth JS section), `api/config.js`

Two auth methods: Google OAuth and email/password. Both use Supabase Auth.

**How it works:**
- On boot, frontend calls `/api/config` to get `SUPABASE_URL` and `SUPABASE_ANON_KEY`
- Supabase client is initialised with these values
- `onAuthStateChange` handles all auth state — fires on page load (`INITIAL_SESSION`), after sign-in (`SIGNED_IN`), and after sign-out (`SIGNED_OUT`)
- Google OAuth uses PKCE flow (Supabase v2 default) — redirects to Google, then back to the app; state is restored via `INITIAL_SESSION` on the return
- Auth state change updates the header: shows login button when signed out, user avatar + dropdown when signed in
- Dropdown shows user email + logout option

**Redirect URL** (must be registered in both Google Console and Supabase dashboard):
`https://winederella.vercel.app`

---

### 5. Conversation Persistence

**File:** `index.html`

Signed-in users can save conversations to Supabase.

**How it works:**
- `saveCurrentConversation()` upserts a row to the `conversations` table and inserts all messages into the `messages` table
- Called automatically on first sign-in if a conversation is already in progress
- Save nudge: after Wini's 3rd response in a session, inline pill buttons appear asking the user if they want to save — implemented via `appendNudgeStrip()`
- Conversation history is stored in `session.messages` in memory for the duration of the page session

**Database tables:**
```sql
conversations (id, user_id, title, created_at, updated_at)
messages      (id, conversation_id, user_id, role, content, created_at)
```
Both tables have RLS policies: users can only read/write their own rows.

---

### 6. Palate Profile (Preference Learning)

**File:** `api/extract-palate.js`

After each exchange, the frontend fires a background call to extract wine preference signals and store them against the user's profile.

**How it works:**
- After Wini responds, frontend POSTs `{ userId, userMessage, assistantMessage, todayDate }` to `/api/extract-palate`
- Claude Haiku analyses the exchange and returns a JSON object of new preference signals only (`{}` if nothing new)
- The backend merges extracted signals into the existing `palate_profile` row using context-aware deduplication (same grape + same context = update, not duplicate)
- Array fields are capped at 20 items — oldest `last_mentioned` entries are dropped
- On the next chat request, the profile is fetched and prepended to the system prompt so Wini knows the user's history

**Extracted fields:**
`styles`, `grapes_loved`, `grapes_disliked`, `regions_loved`, `regions_disliked`, `budget`, `dislikes`, `bottle_shop`

**Database table:**
```sql
palate_profile (user_id, profile jsonb, updated_at)
```
Unique constraint on `user_id` (required for `upsert(..., { onConflict: 'user_id' })` to work).

**Error visibility:** Every exit path in `extract-palate.js` now logs a distinct message — successful upsert, upsert failure, unparseable model output, or nothing-extracted — so failures are diagnosable from Vercel function logs alone, without needing a browser network trace. The handler always returns `200` to the client regardless of outcome (fire-and-forget from the frontend's perspective); failures are visible only server-side, by design.

**Resolved bugs (July 2026):**
- `.single()` on the initial profile read threw a 406 for any user with no existing row (i.e. every new user's first message), which was caught by the outer `try/catch` and exited before extraction or the upsert ever ran. Fixed by switching to `.maybeSingle()`, which returns `null` instead of throwing. The same pattern existed in `chat.js`'s profile fetch (silently swallowed there, so no user-visible symptom, but same noisy-log issue) — fixed identically.
- Separately, the upsert result was never checked — supabase-js returns errors on the result object rather than throwing, so a failed upsert looked identical to a successful one in the logs. Fixed by checking `{ error }` on the upsert and logging it explicitly.
- Root cause of the actual empty-table symptom: `SUPABASE_SERVICE_ROLE_KEY` was missing from Vercel's environment variables (only `SUPABASE_ANON_KEY` and `SUPABASE_URL` were set). `createClient()` throws `supabaseKey is required` when the key is undefined — this affected `extract-palate.js`, the profile-fetch in `chat.js`, and `delete-account.js` simultaneously, since all three depend on it. Adding the key in Vercel and redeploying resolved it.

---

### 7. Account Deletion

**File:** `api/delete-account.js`

Users can delete their account from the dropdown menu.

**How it works:**
- Frontend calls `/api/delete-account` with `{ userId }`
- Backend uses Supabase admin API (`service_role` key) to delete the user from Supabase Auth
- Cascade deletes handle associated `conversations`, `messages`, and `palate_profile` rows (configured in Supabase dashboard)

---

### 8. Supabase Config Endpoint

**File:** `api/config.js`

A simple GET endpoint that returns public Supabase credentials to the frontend without embedding them in the HTML source.

```json
{ "supabaseUrl": "...", "supabaseAnonKey": "..." }
```

---

## Environment Variables

All set in Vercel dashboard under Project → Settings → Environment Variables.

| Variable | Used by | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `api/chat.js`, `api/extract-palate.js` | Never sent to frontend |
| `SUPABASE_URL` | All api files | Also returned by `/api/config` |
| `SUPABASE_ANON_KEY` | `api/config.js` | Safe to expose — designed to be public |
| `SUPABASE_SERVICE_ROLE_KEY` | `api/chat.js`, `api/extract-palate.js`, `api/delete-account.js` | Never sent to frontend. **Distinct from `SUPABASE_ANON_KEY`** — copy the `service_role` key from Supabase → Project Settings → API. If missing, all three files fail (palate extraction, profile injection, account deletion) with `supabaseKey is required` in Vercel logs. |

**Reminder:** Adding or changing a Vercel environment variable does not affect already-built deployments — trigger a redeploy for it to take effect.

---

## Key Design Decisions

- **No build step** — plain HTML/CSS/JS keeps deployment simple and removes toolchain overhead. Supabase JS is loaded from CDN.
- **Single file frontend** — `index.html` contains all styles and scripts. Acceptable at current scale; would split into modules if the codebase grows significantly.
- **Model generates its own greeting** — rather than hardcoding an opening message, `init()` sends `[user: 'Hi']` to the API so Claude produces Wini's greeting in-character.
- **Text-block filtering** — web search tool responses include non-text content blocks; filtering before returning preserves the `content[0].text` contract the frontend relies on.
- **Haiku for extraction** — preference extraction runs on every exchange but doesn't need a powerful model. Haiku is significantly cheaper and fast enough for a background task.
- **Palate profile prepended, not appended** — profile context goes before the system prompt so it has highest salience; the system prompt's persona instructions follow.
- **iOS Safari zoom fix** — textarea `font-size` set to minimum `16px`; below this Safari auto-zooms on focus.
- **Canvas resize** — Vercel has a 4.5MB request body limit. Images are resized to max 1024px / 85% JPEG quality before base64 encoding to stay safely under this limit.

---

## Routing

Defined in `vercel.json`:

| Route | Handler |
|---|---|
| `POST /api/chat` | `api/chat.js` |
| `GET  /api/config` | `api/config.js` |
| `POST /api/extract-palate` | `api/extract-palate.js` |
| `POST /api/delete-account` | `api/delete-account.js` |

---

## Known Issues / In Progress

- **Google OAuth `Unable to exchange external code`** — Supabase server-side token exchange failing intermittently. Likely cause: Google Client Secret mismatch or app in Testing mode in Google Console. Fix: regenerate Client Secret in Google Console and re-enter in Supabase Auth settings. Status unconfirmed — needs re-testing.
- **Conversation loading** — UI for browsing and loading past saved conversations is not yet built. Persistence (save) works; retrieval UI is a future feature.

## Recently Resolved

- **Palate profile never populated** (July 2026) — see the Resolved bugs note under Feature 6 above. Root cause was a missing `SUPABASE_SERVICE_ROLE_KEY` env var compounded by two `.single()` vs `.maybeSingle()` bugs.
- **Web search truncating responses** (July 2026) — fixed by concatenating all `text` blocks instead of returning only `content[0]`.
- **Wini narrating her own search process** (July 2026) — fixed via an explicit "do this silently" instruction in the system prompt.
- **Markdown links/dividers rendering as plain text** (July 2026) — `renderMarkdown()` now converts `[text](url)` to clickable links and `---` to `<hr>`.
- **System prompt contradicted web search capability** (July 2026) — the old "you don't have live inventory" line was replaced with instructions to search and link real bottle pages.
