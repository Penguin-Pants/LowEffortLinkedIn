# LowEffortLinkedIn — Feature Spec & Implementation Plan

Slack-native employee advocacy app: a marketer broadcasts LinkedIn-ready posts
(link, captions, optional image) into a Slack channel; employees connect LinkedIn
once via OAuth, then share pre-written or custom captions to their own LinkedIn
profile with one click. The post card shows a live share counter, a leaderboard
command keeps it fun, and `/disconnect` gives employees self-service control over
their data.

This document is the complete spec + implementation plan produced from stakeholder
Q&A. It supersedes the original one-page brief — where this doc adds detail or
changes something from that brief, this doc wins. **All previously open questions
have been resolved** (Decisions Log #9–#16); there is no open-questions section.

## 1. Decisions Log

Choices locked in during planning, and why.

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Backend stack | Node.js + `@slack/bolt` (`ExpressReceiver`) | Native Slack SDK, first-class Block Kit/modal support, and `ExpressReceiver` lets us bolt custom HTTP routes (LinkedIn OAuth) onto the same Express app as the Slack routes. |
| 2 | Database | PostgreSQL from day one | Avoids the SQLite-on-ephemeral-filesystem trap; no migration needed later. |
| 3 | Hosting | Railway | Managed Postgres, HTTPS by default, simple env var config, built-in cron for the token-expiry job. |
| 4 | LinkedIn API access | Not yet approved | Plan includes a Phase 0 application step and a `LINKEDIN_MOCK_MODE` so backend work isn't blocked on LinkedIn's review process. |
| 5 | Marketer authorization | Configurable allowlist (`MARKETER_SLACK_IDS` env var, comma-separated) | Matches "single marketer" today, costs nothing to extend to a few people later. |
| 6 | Schema | Added a third table, `shares`, beyond the spec's `users`/`posts` | Powers the share counter, leaderboard, idempotency backstop, and failure debugging. |
| 7 | Token expiry handling | Proactive Slack reminder ~7 days before `token_expires_at` | LinkedIn tokens aren't refreshable in this flow; without a reminder, the Share button just silently breaks after 60 days. |
| 8 | Deliverable of the planning task | Plan document only; implementation follows once reviewed | Matches the branch intent. |
| 9 | Share Variation C button | Rendered whenever Caption C is filled in | Any filled-in caption gets its own one-click button (A always; B/C when present) — symmetrical with the modal and schema. |
| 10 | User-facing copy | Friendly-casual with emoji; final strings in §8 | Internal tool, audience is coworkers. Copy in §8 is the shipping copy, not placeholder. |
| 11 | Marketer share visibility | Live share counter on the post card, in MVP | After each successful share the card's context line updates ("✅ 12 shares"). Zero extra surface, doubles as social proof. |
| 12 | Re-share policy | Blocked: one successful share per person per post, any variation | Enforced by a partial unique index; second attempt gets a friendly ephemeral. Protects employees' feeds from accidental near-duplicates. |
| 13 | Image attachments | In MVP: one optional image per post | Marketer attaches via Slack `file_input`; uploaded to LinkedIn with each share (see §4 — LinkedIn image assets are owned per-member, so upload happens with the sharer's token). |
| 14 | `/disconnect` | In MVP: self-service disconnect + full data erasure | `/disconnect` removes the LinkedIn connection; `/disconnect all` also erases share history. Makes the PRIVACY.md deletion promise self-service. |
| 15 | Leaderboard | In MVP: `/advocacy-stats` command | Ephemeral, anyone can run it, top 10 sharers over a default 30-day window. All data already exists in `shares`. |
| 16 | Company Pages & multi-workspace | Permanently out of scope | Internal tool, one workspace, personal profiles only — advocacy is employee voices, not the company page. Not on any roadmap. |
| 17 | Post sharing expiry | In MVP: disable the Share buttons after a window, keep the message | `DEFAULT_POST_EXPIRY_HOURS` (default 8) applies unless the marketer overrides it per post in `/create-post`. The card and its final counter stay visible for context; only future sharing closes. Deleting the message outright was considered and rejected — it destroys the visible record of what was shared. |
| 18 | LinkedIn article title | Superseded by Decision #19 | Originally: fetched from the destination page's real `<title>`, falling back to the bare hostname. In production this reliably fell back to the hostname anyway — see #19. |
| 19 | LinkedIn link preview | Drop `content.article` for link-only posts; put the URL in `commentary` and let LinkedIn's own crawler unfurl it | The server-side title fetch behind Decision #18 kept failing against real destination sites — most likely cloud-hosting IP ranges (Railway included) being blocked/challenged by WAFs on IP reputation, independent of headers (a browser-like User-Agent made no difference). LinkedIn's own crawler is widely allowlisted and isn't running from a flagged IP, so it succeeds where our fetch didn't. `fetchArticleTitle`/`posts.article_title` are still populated at `/create-post` time but no longer feed the LinkedIn payload; removing them is a candidate follow-up once this is confirmed working. Since the URL is now always appended to the caption (not just for image posts), the `/create-post` and Edit & Share Custom caption-length checks (§2.1) were generalized to always account for it, and the share pipeline logs the built payload's shape so a "still no preview" report can be checked against what actually shipped. |

## 2. Feature Requirements

### 2.1 Feature 1 — Marketer Engine (`/create-post`)

**Trigger & authorization**
- Slash command `/create-post`, registered on the Slack app.
- On invocation, check `command.user_id` against `MARKETER_SLACK_IDS`. If not
  authorized: ephemeral copy string C10 (§8) and stop (no DB write, no modal).

**Modal (Block Kit view)**
- Destination URL — `plain_text_input`, required.
- Caption A — multiline `plain_text_input`, required, capped at 3000 chars (LinkedIn's
  `commentary` field limit).
- Caption B — multiline, optional.
- Caption C — multiline, optional.
- Image — `file_input` block element, optional, max 1 file, filetypes limited to
  `png,jpg,jpeg,gif`. Slack hosts the file; we store its file ID and download it
  at share time (needs the `files:read` scope, §6).
- Server-side validation on submit: URL parses (`new URL()`), Caption A non-empty and
  under the char cap. Invalid input returns a `response_action: errors` pointing at
  the offending block instead of a generic failure.

**Submission handling**
- `ack()` the `view_submission` immediately (§2.3 step 0 applies to all
  interactivity), then:
- `INSERT INTO posts (...) RETURNING id`.
- Post a Block Kit card to `ADVOCACY_CHANNEL_ID` (configurable, rather than the
  original brief's hardcoded `#sales` channel):
  - A text block containing the raw destination URL so Slack's native unfurl renders
    the link preview.
  - If an image was attached: an `image` block rendering it on the card.
  - Section blocks for each non-empty caption variation.
  - An actions block with buttons generated dynamically: `Share Variation A` always,
    `Share Variation B`/`Share Variation C` only if that caption was filled in, and
    `Edit & Share Custom` always. Each button's `value` encodes `{post_id, variation}`.
  - A context block: `Posted by @<marketer> · <date> · ✅ 0 shares` — the counter
    segment is updated live as people share (§2.3 step 6).
- Store the broadcast card's `channel` + `ts` on the `posts` row
  (`slack_channel_id`, `slack_message_ts`) so any later flow can update the card
  without relying on interaction payload context.
- Confirm back to the marketer with ephemeral copy string C9.

**Edge cases**
- Bot not in target channel: request `chat:write.public` so posting to public
  channels doesn't require an invite; surface `channel_not_found`/`not_in_channel`
  as a clear ephemeral error rather than a silent failure.
- Caption exceeding LinkedIn's limit: caught at modal-submission time, not at
  share time — cheaper to fix and doesn't fail in front of an employee.
- Image attached but Slack file fetch fails at share time: the share proceeds
  without the image is **not** acceptable (silently different content) — the share
  fails with copy string C6 and the error is recorded in `shares`.

### 2.2 Feature 2 — One-Time LinkedIn OAuth Handshake

**Trigger points** for the "connect your LinkedIn" prompt (the original brief only
describes the first; the other two are necessary for correctness):
1. No row in `users` for this Slack ID (or a row with no token — e.g. after
   `/disconnect`).
2. Row exists but `token_expires_at` is in the past.
3. Row exists and unexpired, but LinkedIn's API returns `401` at share time (token
   revoked by the user on LinkedIn's side) — treat identically to "not connected."

**Handshake**
1. Any trigger above → `chat.postEphemeral` **in the channel where the user clicked**
   (visible only to them), copy string C1. This satisfies the "ephemeral DM" intent
   from the brief without opening a real DM channel for this prompt (the Phase 6
   expiry reminder does DM users — that's why `im:write` appears in §6).
2. The message contains a Block Kit `url`-type button pointing to
   `${PUBLIC_BASE_URL}/auth/linkedin?token=${signed_slack_id}`. The server is
   already building this ephemeral message in response to a signature-verified
   Slack interaction, so at that moment it signs the `slack_id` (HMAC-SHA256 with
   `OAUTH_STATE_SECRET`, ~15 min expiry) into the link. A raw
   `?slack_id=` param would let anyone who knows a coworker's Slack ID bind their
   own LinkedIn account to it — the victim's future "shares" would then land on
   the attacker's profile — so `/auth/linkedin` rejects requests without a valid
   signed token.
3. `GET /auth/linkedin`: verify the signed `slack_id` token, then build a signed,
   short-lived `state` (HMAC-SHA256 over `{slack_id, nonce, iat}` using
   `OAUTH_STATE_SECRET`, ~10 min expiry), and redirect to LinkedIn's authorization
   endpoint with `scope=openid profile w_member_social`.
4. `GET /auth/linkedin/callback`:
   - If LinkedIn sent an `error` param (e.g. `user_cancelled_authorize` when the
     user clicks Cancel on the consent screen), render page copy P2 and stop.
   - Verify `state` signature and expiry (reject tampered/expired state with a
     friendly error page — this is the CSRF defense), exchange the `code` for an
     access token, call LinkedIn's OIDC userinfo endpoint to get the person's URN
     id (`sub` claim), encrypt the access token (AES-256-GCM, see §5), and
     `UPSERT` into `users` — also clearing `expiry_reminder_sent_at`, so the
     reminder job treats the fresh token as a new 60-day window.
5. Render page copy P1 ("Success! …"). Since the server knows the `slack_id` at
   this point, also send Slack message copy C2 proactively so the user doesn't
   have to tab back to find out it worked.

### 2.3 Feature 3 — Native Sharing Mechanics

**Post card UI** — see §2.1; buttons are generated per-post based on which captions
are populated.

**Instant share (`Share Variation A/B/C`)**
0. `ack()` the interaction immediately — Slack requires an ack within 3 seconds
   and does **not** retry interactive payloads (the user just sees a warning
   icon if we're late). The LinkedIn call can easily exceed 3s, so every
   `block_actions` and `view_submission` handler acks first, then does the real
   work async.
1. Look up the clicking user's token. Missing/expired → run the connect flow
   (§2.2) and stop.
2. Idempotency guard, two layers. A duplicate post is a visible, embarrassing
   failure on someone's real profile:
   - An in-process lock keyed on `(post_id, slack_user_id)` absorbs double-clicks.
   - A partial unique index on `shares (post_id, slack_user_id) WHERE
     status IN ('pending','success')` (§5) is the durable backstop: one
     successful share per person per post (any variation), surviving restarts.
     A repeat attempt gets ephemeral copy string C4 (Decision #12).
   - Each run inserts a `pending` row before calling LinkedIn and settles it to
     `success` or `failed`. A pending row blocks a second run (C13). A pending
     row older than 5 minutes means the outcome is unknown: it is closed as
     `failed` and the user is asked to check LinkedIn before retrying (C14).
3. If the post has an image: download it from Slack (`url_private`, bot token
   auth), then upload it to LinkedIn under **the sharer's token** via the image
   upload flow (§4) to get an image URN. LinkedIn assets belong to the member who
   uploads them, which is why this happens per-share, not once at post creation.
4. Build the LinkedIn Posts API payload (see §4), POST it (or simulate, under
   `LINKEDIN_MOCK_MODE`).
5. Insert a `shares` row recording the outcome.
6. Success → ephemeral copy string C3 as the primary feedback, then update the
   card's context line (`chat.update` using the stored `slack_channel_id` +
   `slack_message_ts`) with the new count:
   `✅ {COUNT(shares WHERE post_id=? AND status='success')} shares`. The ✅
   `reactions.add` on the card is a nice-to-have on the **first** successful share
   only: the bot can add a given emoji to a message just once, so subsequent
   sharers would get an `already_reacted` error — swallow it silently.
   Failure → ephemeral copy string C6 with LinkedIn's error surfaced verbatim.

**Edit & Share Custom**
- Opens a modal pre-filled with Caption A via `initial_value`; `{post_id,
  channel_id}` carried in `private_metadata`.
- Submission runs the same pipeline as instant share (steps 0–6), with
  `variation = 'CUSTOM'` and the edited text stored in `shares.custom_text`.

### 2.4 Feature 4 — `/disconnect` (self-service disconnect & erasure)

- `/disconnect` (no args): clear `linkedin_access_token`, `linkedin_person_id`,
  `token_expires_at`, and `expiry_reminder_sent_at` on the caller's `users` row.
  Share history is retained (it feeds the counter/leaderboard). Respond with
  ephemeral copy string C7.
- `/disconnect all`: additionally delete the caller's `shares` rows and their
  `users` row entirely (FK uses `ON DELETE CASCADE`, §5). Respond with ephemeral
  copy string C8. Card counters are **not** retro-decremented (the LinkedIn posts
  themselves still exist; the counter reflects shares that happened).
- Both variants are idempotent — running them with nothing to delete still
  responds with the same copy, no error.
- Also invalidates the reminder job's interest in the user (no row / no expiry →
  no DM).
- PRIVACY.md's deletion section is updated to mention `/disconnect all` as the
  self-service path alongside the email contact.

### 2.5 Feature 5 — `/advocacy-stats` (leaderboard)

- Slash command, **anyone** in the workspace can run it.
- Response is **ephemeral** (doesn't spam the channel).
- Default window: last 30 days. Optional arg for the window: `/advocacy-stats 7`
  → last 7 days (integer days, clamped to 1–365; anything unparsable falls back
  to 30).
- Content: top 10 sharers by successful share count in the window, plus a total
  line. Format per copy string C11. Names rendered as Slack mentions from
  `slack_user_id`.
- Users erased via `/disconnect all` naturally drop out (their rows are gone).

### 2.6 Feature 6 — Post Sharing Expiry

- Every post gets a sharing window, computed at `/create-post` submission time
  as `now() + hours` and stored on `posts.expires_at`. The marketer may set an
  optional "Sharing window, in hours" field in the modal (1–`MAX_POST_EXPIRY_HOURS`,
  720); left blank, it falls back to `DEFAULT_POST_EXPIRY_HOURS` (Decision #17).
- A cron job (`POST_EXPIRY_CRON`, default every 15 minutes — windows are
  hours-scale, not days-scale like the token reminder) finds posts past their
  window that haven't been closed yet, rebuilds the card **without** the
  Share/Edit buttons, and stamps `posts.expired_at` so the job is idempotent.
  The message, captions, image, and final share counter remain untouched.
- The share pipeline (§2.3) independently checks `expires_at` on every share
  attempt — a click landing in the gap between cron runs, or a stale card left
  open in someone's browser, is rejected with copy C12 rather than silently
  producing a share after the window closed.
- Retroactively editing an already-broadcast post's window, or deleting a post
  outright, remain out of scope (§13).

## 3. System Architecture

```
Slack workspace
   │  slash commands / block_actions / view_submission (HTTPS, signed)
   ▼
Express app (single process, single port)
 ├─ Bolt ExpressReceiver  → /slack/events   (commands, interactivity, modals)
 ├─ custom routes         → /auth/linkedin, /auth/linkedin/callback
 └─ /healthz
   │                                   │
   ▼                                   ▼
PostgreSQL (Railway)              LinkedIn API
 users / posts / shares           OAuth + Posts + Images API
```

Single Node process, single Express app — Bolt's routes and the LinkedIn OAuth
routes share one HTTP server, so only one public port/domain is needed. A daily
cron job (Railway cron or `node-cron` in-process) runs the token-expiry reminder.

## 4. LinkedIn Integration Details

- **OAuth scopes:** `openid profile w_member_social` (current "Sign In with LinkedIn
  using OpenID Connect" + "Share on LinkedIn" products — the older `r_liteprofile`/
  `r_emailaddress` scopes are deprecated).
- **Token exchange:** `POST https://www.linkedin.com/oauth/v2/accessToken`
- **Identity lookup:** `GET https://api.linkedin.com/v2/userinfo` (OIDC) → `sub`
  claim is the person's URN id, used as `linkedin_person_id`.
- **Image upload** (only when the post has an image; runs per-share under the
  sharer's token): `POST /rest/images?action=initializeUpload` with the author URN
  → returns an upload URL + image URN → `PUT` the raw bytes to the upload URL →
  reference the image URN in the post payload. Image ownership is per-member on
  LinkedIn, which is why the upload can't happen once at `/create-post` time.
- **Posting:** `POST https://api.linkedin.com/rest/posts`, headers include
  `LinkedIn-Version: <YYYYMM>` and `X-Restli-Protocol-Version: 2.0.0`. Representative
  payloads:

  Link-only post — no `content` field at all. The destination URL rides as a
  trailing line in `commentary`; LinkedIn detects the bare URL and unfurls it
  itself via its own crawler, the same as when a person pastes a link into
  the share box:

  ```json
  {
    "author": "urn:li:person:{linkedin_person_id}",
    "commentary": "{caption text}\n\n{destination_url}",
    "visibility": "PUBLIC",
    "distribution": { "feedDistribution": "MAIN_FEED" },
    "lifecycleState": "PUBLISHED",
    "isReshareDisabledByAuthor": false
  }
  ```

  This used to build an explicit `content.article` attachment instead, with
  `source` and a required `title` (LinkedIn rejects the field's absence with
  `field is required but not found and has no default value` — the schema-drift
  risk this section originally flagged). That `title` was resolved server-side
  by fetching the destination page's real `<title>` tag at `/create-post` time
  (`src/linkedin/pageTitle.js`, stored on `posts.article_title`). In practice
  that fetch reliably failed for real destination sites and the preview
  degraded to a bare-hostname card: cloud-hosting IP ranges (Railway included)
  are commonly blocked or challenged by WAFs like Cloudflare on IP reputation
  alone, independent of User-Agent or headers, so tuning our own request
  couldn't fix it (confirmed by testing — a browser-like UA/header set made no
  difference). LinkedIn's own crawler runs from LinkedIn's infrastructure and
  is one of the most widely allowlisted bots on the web, so letting it do the
  unfurl (by simply putting the URL in `commentary` and omitting `content`)
  sidesteps the problem instead of trying to disguise our own fetch.
  `fetchArticleTitle`/`posts.article_title` (and `src/linkedin/ssrfGuard.js`,
  which existed to protect that fetch) have since been removed outright — the
  follow-up this paragraph originally flagged: the value was fetched (up to
  ~5s of outbound HTTP per `/create-post`) and stored but never read by
  anything once the payload stopped building `content.article`.

  Post with image: `content` is a oneOf in the Posts API — a post can carry
  media or nothing, never an article attachment. When an image is attached,
  the payload uses `"content": { "media": { "id": "{image URN}" } }`, with the
  destination URL still appended to the commentary as a trailing line so the
  link travels with the post:

  ```json
  {
    "author": "urn:li:person:{linkedin_person_id}",
    "commentary": "{caption text}\n\n{destination_url}",
    "visibility": "PUBLIC",
    "distribution": { "feedDistribution": "MAIN_FEED" },
    "content": { "media": { "id": "{urn:li:image:...}" } },
    "lifecycleState": "PUBLISHED",
    "isReshareDisabledByAuthor": false
  }
  ```

  A `201` response's `x-restli-id` header carries the new post's URN, stored in
  `shares.linkedin_post_urn` for traceability.
- **Token lifetime:** `expires_in` (~5,184,000s / 60 days) from the token exchange
  response defines `token_expires_at`. This flow does not use a refresh token —
  expiry is handled by the reminder job (§2.2) plus reactive re-auth on `401`.

## 5. Database Schema

```sql
-- gen_random_uuid() is built into PostgreSQL 13+; no extension needed.
-- Token encryption is done in the app (AES-256-GCM), not in the database.

CREATE TABLE users (
  slack_user_id           TEXT PRIMARY KEY,
  linkedin_access_token    TEXT,            -- AES-256-GCM encrypted in app, base64
  linkedin_person_id       TEXT,
  token_expires_at         TIMESTAMPTZ,
  expiry_reminder_sent_at  TIMESTAMPTZ,      -- dedupes the reminder job; cleared on
                                             -- reconnect (§2.2 step 4)
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE posts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_url      TEXT NOT NULL,
  caption_a            TEXT NOT NULL,
  caption_b            TEXT,
  caption_c            TEXT,
  image_slack_file_id  TEXT,                -- Slack file ID of the optional image
  slack_channel_id     TEXT,                -- primary card's channel (first broadcast);
                                             -- all cards live in post_cards
  slack_message_ts     TEXT,                -- primary card message ts, for chat.update
  created_by_slack_id  TEXT NOT NULL,
  expires_at           TIMESTAMPTZ,         -- computed at creation (§2.6); marketer's
                                             -- override or DEFAULT_POST_EXPIRY_HOURS
  expired_at           TIMESTAMPTZ,         -- stamped once the expiry job has removed
                                             -- the Share buttons; dedupes that job
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Powers the post-expiry job's "what's due" scan (§2.6).
CREATE INDEX idx_posts_expires_at ON posts(expires_at) WHERE expired_at IS NULL;

-- One row per broadcast: ADVOCACY_CHANNEL_ID may list several channels, so a
-- single post fans out to multiple cards. The share counter and expiry job
-- update every card recorded here.
CREATE TABLE post_cards (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id           UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  slack_channel_id  TEXT NOT NULL,          -- channel the card was broadcast to
  slack_message_ts  TEXT NOT NULL,          -- card message ts, for chat.update
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_post_cards_post_id ON post_cards(post_id);

CREATE TABLE shares (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id             UUID NOT NULL REFERENCES posts(id),
  slack_user_id       TEXT NOT NULL REFERENCES users(slack_user_id)
                        ON DELETE CASCADE,  -- /disconnect all erases history (§2.4)
  variation           TEXT NOT NULL CHECK (variation IN ('A','B','C','CUSTOM')),
  custom_text         TEXT,                 -- set only when variation = 'CUSTOM'
  linkedin_post_urn   TEXT,
  status              TEXT NOT NULL CHECK (status IN ('pending','success','failed')),
  error_message       TEXT,
  shared_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_shares_post_id ON shares(post_id);
CREATE INDEX idx_shares_slack_user_id ON shares(slack_user_id);

-- Durable idempotency backstop: one successful (or in-progress) share per
-- person per post (§2.3).
CREATE UNIQUE INDEX idx_shares_once_per_user_post
  ON shares(post_id, slack_user_id) WHERE status IN ('pending','success');
```

Migrations managed via Knex.js (lightweight query builder + migration runner —
enough structure for a 3-table schema without ORM overhead).

## 6. Slack App Configuration

- **Bot token scopes:** `commands`, `chat:write`, `chat:write.public`,
  `reactions:write`, `im:write` (required by the Phase 6 expiry-reminder DMs),
  `files:read` (to download the marketer's attached image at share time).
- **Slash Commands** (all pointing at Request URL `${PUBLIC_BASE_URL}/slack/events`):
  - `/create-post` — marketer-only (enforced server-side)
  - `/disconnect` — anyone; `all` argument for full erasure
  - `/advocacy-stats` — anyone; optional day-window argument
- **Interactivity & Shortcuts:** on, same Request URL.
- **Socket Mode:** not used — we already need a public HTTPS endpoint for the
  LinkedIn OAuth callback, so Bolt runs in standard HTTP mode on that same endpoint.
- Single-workspace internal install (bot token + signing secret) — no Slack-side
  OAuth/distribution flow needed, since this isn't a multi-workspace app.

## 7. Environment Variables

| Variable | Purpose |
|---|---|
| `SLACK_BOT_TOKEN` | Bot token for the Slack app |
| `SLACK_SIGNING_SECRET` | Verifies incoming Slack requests |
| `MARKETER_SLACK_IDS` | Comma-separated allowlist for `/create-post` |
| `ADVOCACY_CHANNEL_ID` | Channel the post cards are broadcast to |
| `DATABASE_URL` | Postgres connection string (Railway-provided) |
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | LinkedIn app credentials |
| `LINKEDIN_REDIRECT_URI` | Must exactly match the LinkedIn app's registered redirect |
| `OAUTH_STATE_SECRET` | HMAC key for signing the OAuth `state` param and connect-link tokens |
| `TOKEN_ENCRYPTION_KEY` | 32-byte base64 key for AES-256-GCM token encryption at rest |
| `PUBLIC_BASE_URL` | This server's public HTTPS origin |
| `LINKEDIN_MOCK_MODE` | `true` until LinkedIn API access is approved (§10, Phase 0) |
| `REMINDER_CRON` | Optional; cron schedule (UTC) for the daily token-expiry reminder DM. Default `0 9 * * *` |
| `DEFAULT_POST_EXPIRY_HOURS` | Optional; default sharing window for a new post, in hours. Default `8` (§2.6) |
| `POST_EXPIRY_CRON` | Optional; cron schedule (UTC) for the post-expiry job. Default `*/15 * * * *` (§2.6) |
| `PORT`, `NODE_ENV` | Standard server config |

## 8. User-Facing Copy (final)

Friendly-casual with emoji (Decision #10). These are the shipping strings;
`{...}` are runtime substitutions.

**Slack messages**

| ID | Where | Copy |
|----|-------|------|
| C1 | Connect prompt (ephemeral) | 🔗 *Connect your LinkedIn to start sharing!* It takes about 30 seconds and you only do it once. → `[Connect LinkedIn]` |
| C2 | Post-OAuth confirmation | ✅ *LinkedIn connected!* You're all set — head back to the post and hit Share. 🎉 |
| C3 | Share success (ephemeral) | 🎉 *Shared to your LinkedIn!* Nice one — your network thanks you. |
| C4 | Already shared (ephemeral) | 👀 You've already shared this post — no double-dipping! Keep an eye out for the next one. |
| C5 | Reminder DM (7 days before expiry) | ⏰ *Heads up!* Your LinkedIn connection expires in {days} days. Reconnect now (takes 30 seconds) so one-click sharing keeps working: → `[Reconnect LinkedIn]` |
| C6 | Share failed (ephemeral) | 😕 That didn't go through. LinkedIn said: `{error}`. Give it another try in a minute — if it keeps happening, ping {marketer mention}. |
| C7 | `/disconnect` done | 👋 *LinkedIn disconnected.* Your token is deleted; your past share history is kept for the leaderboard. Run `/disconnect all` if you want that erased too. Reconnect anytime by clicking any Share button. |
| C8 | `/disconnect all` done | 🧹 *All gone.* Your LinkedIn connection and your entire share history have been erased. Reconnect anytime by clicking any Share button. |
| C9 | Post created (ephemeral to marketer) | 📣 *Your post is live in {channel}!* You'll see the share counter tick up on the card. |
| C10 | Unauthorized `/create-post` | 🚫 Sorry, only the marketing team can create posts. Think you should have access? Ask {marketer mention}. |
| C11 | `/advocacy-stats` (ephemeral) | 🏆 *Top sharers, last {days} days* — {total} shares total<br>1. {mention} — {n} shares<br>2. … (top 10; if no shares: "No shares in this window yet — be the first! 👀") |
| C12 | Share attempted on an expired post (ephemeral) | ⏰ Sharing for this post has closed. Keep an eye out for the next one! |
| C13 | Share attempted while the same person's share of the post is still pending (ephemeral) | ⏳ Your share of this post is already on its way. Hang tight, you'll get a confirmation here. |
| C14 | A pending share's outcome is unknown (stale pending row, ephemeral) | ⚠️ We couldn't confirm whether your last share of this post reached LinkedIn. Check your LinkedIn profile first. If it isn't there, click Share again. |

**Card context line:** `Posted by {marketer mention} · {date} · ✅ {n} shares · Sharing closes {date/time}` (or `· ⏰ Sharing closed` once the window has passed)

**Browser pages**

| ID | Where | Copy |
|----|-------|------|
| P1 | OAuth success | ✅ **Success!** Your LinkedIn is connected. You can close this tab and head back to Slack. |
| P2 | OAuth cancelled | **No worries — nothing was connected.** You cancelled on LinkedIn's side. Head back to Slack and click the connect button whenever you're ready. |
| P3 | Invalid/expired link or state | **This link has expired.** Go back to Slack and click the connect button again to get a fresh one. |

## 9. Security & Edge Cases

- The connect link itself carries a signed `slack_id` token, only ever minted in
  response to a signature-verified Slack interaction — `/auth/linkedin` cannot be
  used to initiate a binding flow for an arbitrary Slack user (§2.2 step 2).
- OAuth `state` is signed and short-lived — defends the callback route against CSRF
  and replay.
- LinkedIn access tokens are encrypted at rest (AES-256-GCM); the encryption key
  lives only in env config, never logged, never committed.
- Marketer authorization is enforced server-side on every `/create-post` invocation,
  not just hidden from the Slack UI.
- Slack request signatures are verified by Bolt automatically via
  `SLACK_SIGNING_SECRET`.
- Share actions are debounced per `(post_id, slack_user_id)` in-process, with a
  partial unique index as the durable backstop (§2.3), to prevent duplicate
  LinkedIn posts.
- All interactive payloads are `ack()`ed within Slack's 3-second window before any
  LinkedIn/database work runs (§2.3 step 0).
- `/disconnect` acts only on the caller's own `command.user_id` — there is no way
  to disconnect or erase someone else.
- Raw tokens and full LinkedIn payloads are never logged.
- Server fails fast at startup if `MARKETER_SLACK_IDS` is empty/unset, rather than
  silently locking everyone out or (worse) leaving the command unrestricted.
- The article-title fetch (§4, Decision #18) and its SSRF guard
  (`src/linkedin/ssrfGuard.js`) have been removed along with the rest of
  that subsystem (see §4): the server no longer makes any outbound request
  to a marketer-supplied URL, which retires the SSRF surface entirely
  rather than mitigating it. If a server-side fetch of `destination_url`
  is ever reintroduced, restore the guard's approach with it: block
  private/loopback/link-local (including cloud metadata) IPs and internal
  hostnames, validate at DNS-resolution time and on every redirect hop
  (DNS rebinding), enforce a wall-clock timeout, and cap the bytes read.

## 10. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| LinkedIn API access delayed or denied | Core share feature blocked | Apply in Phase 0 immediately; all other phases build/test against `LINKEDIN_MOCK_MODE` in parallel; fallback UX (copy caption + open LinkedIn's `sharing/share-offsite` web intent) if API access is never granted |
| LinkedIn API schema differs from §4's representative payloads | Integration breaks on first real attempt | Verify exact request/response contract (posts + image upload) against LinkedIn's live docs at Phase 3 kickoff |
| Image upload flow doubles LinkedIn calls per share | Slower shares, more failure modes | Upload only when the post has an image; §2.1 edge case defines fail-loud behavior; mock mode covers it in dev |
| Double-click produces duplicate LinkedIn posts | Visible, embarrassing duplicate content on an employee's real profile | Two-layer idempotency guard, §2.3 |
| DB breach exposes LinkedIn tokens | Employees' accounts could be posted to without consent | Encryption at rest, key isolation, restricted DB network access |
| `MARKETER_SLACK_IDS` misconfigured | Wrong people (or nobody) can broadcast company content | Fail-fast startup check |
| LinkedIn per-member rate limits | Shares silently fail during a high-traffic campaign | Surface LinkedIn's error verbatim in the ephemeral failure message (C6) |

## 11. Phased Implementation Plan

**Phase 0 — Foundations (non-code, can run in parallel with Phase 1–2)**
- Apply for LinkedIn Developer App access: "Sign In with LinkedIn using OpenID
  Connect" + "Share on LinkedIn" products.
- Create the Slack app from a manifest (3 slash commands, scopes per §6), install
  to the workspace, capture bot token + signing secret.
- Provision Railway project + Postgres, capture `DATABASE_URL`.

**Phase 1 — Project Scaffold, Server, Schema**
- Init Node project; `@slack/bolt`, `express`, `pg`, `knex`, `axios`, `dotenv`,
  `node-cron`.
- `ExpressReceiver`-based Bolt app so custom routes share the same server.
- Knex migrations for `users` / `posts` / `shares` (incl. cascade + partial
  unique index).
- `/healthz` route; local dev tunnel documented (ngrok or Slack CLI).

**Phase 2 — `/create-post` Flow**
- Slash command handler with marketer allowlist check.
- Modal open + `view_submission` handler: validate, insert into `posts`, broadcast
  the Block Kit card (incl. image block and `✅ 0 shares` context line), store
  card `channel`/`ts` on the post row.

**Phase 3 — LinkedIn OAuth Pipeline**
- `/auth/linkedin` (signed connect-link verification, signed state, redirect) and
  `/auth/linkedin/callback` (deny path, verify, exchange, encrypt, upsert, clear
  reminder stamp) routes; P1–P3 pages.
- Connect-prompt ephemeral message (C1) + button wired to all three trigger points
  from §2.2; post-OAuth Slack confirmation (C2).

**Phase 4 — Share Interactivity + Posting**
- `block_actions` handlers for `share_variation_a/b/c`: ack → token check →
  idempotency guard → Slack image fetch + LinkedIn image upload (when present) →
  LinkedIn POST (real or mocked) → `shares` insert → ephemeral feedback (C3/C4/C6)
  → card counter `chat.update` → first-share ✅ reaction.
- `Edit & Share Custom` modal (pre-filled) and its `view_submission` handler,
  reusing the same pipeline.

**Phase 5 — `/disconnect` + `/advocacy-stats`**
- `/disconnect` handler: token-clear variant and `all` erasure variant (C7/C8);
  idempotent.
- `/advocacy-stats` handler: window arg parsing, top-10 query over `shares`,
  ephemeral leaderboard (C11).
- Update PRIVACY.md's deletion section to mention `/disconnect all`.

**Phase 6 — Token Expiry Reminder**
- Daily job: query `users` where `token_expires_at` is within 7 days and
  `expiry_reminder_sent_at` is null or predates the current token's reminder
  window (it's cleared on reconnect, §2.2 step 4); DM the reconnect button (C5,
  needs `im:write`, §6); stamp `expiry_reminder_sent_at`.

**Phase 7 — Deploy**
- Dockerfile/nixpacks build on Railway; configure env vars.
- Point the Slack app's Request URL and the LinkedIn app's redirect URI at the
  Railway public domain.
- End-to-end smoke test in the real workspace with a real LinkedIn test account.

## 12. Testing Strategy

- **Unit (Jest):** state param and connect-link token sign/verify (valid, tampered,
  expired); token encrypt/decrypt round-trip; LinkedIn payload builder (article vs
  media variants); marketer-allowlist check; stats window-arg parsing.
- **Route-level (supertest):** `/auth/linkedin` redirect status + `Location` header
  (and 4xx on unsigned requests); `/healthz`.
- **Manual QA checklist** (full Slack+LinkedIn e2e needs live accounts, not
  automatable cheaply):
  1. `/create-post` → card appears with the right buttons for the captions filled
     in, image rendered when attached, `✅ 0 shares` context line.
  2. Connect flow end-to-end with a real personal LinkedIn test account.
  3. `Share Variation A` → post appears on LinkedIn; ephemeral confirmation in
     Slack; counter ticks to 1 (plus ✅ reaction on first share).
  4. Share a post that has an image → image appears on the LinkedIn post; URL
     appended to the caption.
  5. Click Share while disconnected → connect prompt appears.
  6. `Edit & Share Custom` → edited text is what's posted.
  7. Rapid double-click on Share → only one LinkedIn post is created.
  8. Share a post already shared earlier → blocked with C4.
  9. `/advocacy-stats` → correct top list and total for the window.
  10. `/disconnect` → token gone, history kept; `/disconnect all` → row + history
      gone; both re-runnable without error.
  11. Force an expired `token_expires_at` → reminder DM fires.
  12. `/create-post` with a short sharing window (e.g. 1 hour, or force
      `expires_at` in the past) → post-expiry job removes the Share/Edit
      buttons but leaves the message and counter; a share attempt in the gap
      before the job runs is still blocked with C12.

## 13. Out of Scope

Settled scope decisions — nothing here is pending an answer.

**On the future list** (plausible later, not designed for now):
- Multi-channel broadcast for a single post.
- Editing an already-broadcast post's caption/image, or deleting it outright.
  (Automatic sharing *expiry* is implemented — §2.6, Decision #17 — this item
  is specifically about manual edit/delete after broadcast.)
- Richer analytics beyond `/advocacy-stats` (per-post breakdowns, scheduled
  digests, exports) — the `shares` table already holds the data.

**Permanently out** (Decision #16 — not planned, don't design around them):
- Posting to LinkedIn Company Pages (`w_organization_social`).
- Multi-workspace Slack distribution.
