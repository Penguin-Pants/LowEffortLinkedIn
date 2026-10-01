# LowEffortLinkedIn

Project tier: T3
Conventions version: 1.0

## Purpose

Slack-native employee advocacy tool. A marketer posts an article link and up to 3 caption variants with `/create-post`. Employees connect their LinkedIn account once, then share to LinkedIn with one click inside Slack.

## Stack

- Node.js 20 or newer (`package.json` engines). CI and Docker use Node 22.
- Express with `@slack/bolt` (`ExpressReceiver`), `axios`, `node-cron`
- PostgreSQL with `knex` (`pg`) and migrations in `src/db/migrations/`
- Jest and `supertest` for tests
- Deploy: Railway builds the `Dockerfile` (`railway.json`). Migrations run at container start.

## Commands

- Install: `npm install` (README.md). CI uses `npm ci`.
- Run: `npm start` (`node src/index.js`)
- Run with auto-reload: `npm run dev` (port 3000 by default)
- Migrate: `npm run migrate`
- Migrate rollback: `npm run migrate:rollback`
- New migration: `npm run migrate:make`
- Test all: `npm test` (`jest`)
- Test one: `npx jest test/<file>.test.js` (unverified)
- Lint: none found
- Type check: none found
- Build: none found (the `Dockerfile` builds the image on Railway)

## Key paths

- `docs/PLAN.md`: feature spec and implementation plan
- `docs/SETUP.md`: Railway, Slack app and LinkedIn app setup guide
- `plans/`: roadmap and admin UI specs (`plans/env-var-ui-feature-spec.md`, `plans/roadmap.md`)
- `PRIVACY.md`: privacy policy
- `src/`: source (`handlers/`, `admin/`, `linkedin/`, `slack/`, `jobs/`, `crypto/`, `db/`)
- `src/db/migrations/`: knex migrations
- `test/`: Jest tests
- `.github/workflows/ci.yml`: CI (runs `npm ci` and `npm test`)
- `slack-app-manifest.yaml`: Slack app manifest

## Environment variables

Names only. Source: `.env.example`, `src/config.js`. Never commit values. `.env` is in `.gitignore`.

- Slack: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `MARKETER_SLACK_IDS`, `ADVOCACY_CHANNEL_ID`
- Database: `DATABASE_URL`
- LinkedIn: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI`, `LINKEDIN_MOCK_MODE`, `LINKEDIN_API_VERSION` (optional)
- App secrets: `OAUTH_STATE_SECRET`, `TOKEN_ENCRYPTION_KEY`
- Jobs (optional): `REMINDER_CRON`, `DEFAULT_POST_EXPIRY_HOURS`, `POST_EXPIRY_CRON`
- Server: `PUBLIC_BASE_URL`, `PORT`, `NODE_ENV`
- Admin UI (optional): `ADMIN_UI_ENABLED`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `ADMIN_SESSION_SECRET`
- Other (read in code): `RAILWAY_ENVIRONMENT_NAME`

## Gotchas

- Keep `LINKEDIN_MOCK_MODE=true` locally. Shares are simulated and nothing posts to LinkedIn (README.md).
- Slack must reach a local server over HTTPS. A tunnel is needed for local Slack traffic (README.md).

## Do not

- Do not commit `.env` or real values of any variable above.
- Do not run migrations against the production database without a backup.
- Do not reuse `OAUTH_STATE_SECRET` or `TOKEN_ENCRYPTION_KEY` across environments (`.env.example`).
- Do not edit `package-lock.json` by hand.

## Existing notes

Moved from the previous AGENTS.md. Content kept as is, headings moved down two levels.

### Agent Rules

User has diagnosed ADHD. Optimize every reply for scannability, brevity and single-threaded focus.

#### Output (chat, commits, code comments, docs)

01. Write in ASD-STE100. Plain, warm peer tone. Exception: profanity allowed for emphasis when context fits.
02. Multi-turn tasks: line 1 is `Step X/Y: <summary>`, then a blank line, then the body.
03. Next line: the answer, command, file path or diff. Rationale below it.
04. Unprompted explanations: max ~150 words. Elaborate only when asked.
05. Lists: max 5 items; group longer lists by priority. Number ordered steps sequentially (1., 2., 3.), never repeated 1.
06. One issue at a time. End actionable replies with one next step (file or command). No time estimates.
07. State required context inline. Never ask the user to remember anything across turns.
08. No "I" narration of process. State results and changes in concrete terms.
09. No apologies, sycophancy or preamble. On error: fix, then state what changed.
10. No code snippets except out-of-task diffs for approval.
11. Emoji only as status markers (✅ ❌ ⚠️). Max one per line. Never in prose, headings or code.
12. No em dashes. No Oxford commas.

#### Process

1. Verify before asserting: source read, grep or authoritative docs. Never use general knowledge for specifics (APIs, headers, pricing).
2. Cite sources (`path/file.go:42` or URL). Label uncited claims "unverified assumption" and state how to verify.
3. State confidence (high/medium/low) on diagnoses and fixes.
4. Ambiguous request: verify first. If still ambiguous, ask one question before any edit.
5. Challenge the user's reasoning when evidence disagrees.
6. A question is not an edit instruction. Answer it.
7. Run independent tool calls in parallel.
8. After 3 failed fix attempts: stop edits, name the unverified assumption, ask one diagnostic question.

#### Edits

1. In-task edits: proceed without approval. Report changes after.
2. Out-of-task edits: propose a diff in chat. Edit only after explicit approval. Diff >40 lines: give a 1-line summary first; user chooses view or proceed.
3. Every error found, in any file, gets a root-cause fix: apply in-task fixes, propose out-of-task fixes. Never label or defer.
4. Prefer removing components over adding. Use the fewest moving parts that satisfy the requirement.
5. Search the codebase for an existing implementation before adding a new pattern.
6. New pattern replaces old: migrate all call sites and delete the old implementation in the same change.
7. Delete unused code after confirming zero references (incl. dynamic imports, config, external consumers).
8. One-time scripts: run from /tmp, delete after, never commit.
9. Mock data only in tests.

#### Testing (TDD)

1. Stub first. Prove failure on an assertion, not a compile error. Write minimum code to pass.
2. Unit test every public function and error branch. Integration test every feature slice.
3. Assert behavior, not implementation. Delete assertions that survive an inverted requirement.

#### Tooling

- Use Makefile targets over direct calls when present (e.g. `make test`).
- Grep for exact search, `rg` for regex. Mermaid for complex system diagrams.
- Instruction files (SKILL.md, **/prompts/**, AGENTS.md, CLAUDE.md): format only with `mdformat --number`.

#### Subagents

- Default to the cheapest adequate model. Follow `.agents/skills/shared/SUBAGENT-STEERABILITY.md` if present.
- Verify subagent completion. Retry incomplete work with a higher turn limit. Report turn-limit exhaustion with ⚠️.
- Ask before engineering work (edits, design, debugging) on a downgraded model. Mechanical, read-only, git and docs work: no prompt.

You are cherished.

## Global conventions (synced copy, edit the global file instead)

#### Communication

- Lead with the bottom line or most important point.
- Be concise, direct, and avoid conversational filler like 'Sure, I can help with that
- Verify facts against current sources
- Clarify ambiguity and do not assume the user is always right: Ask critical questions with the AskUserQuestion tool when input is unclear before proceeding.

#### ADHD-Friendly Formatting

- Reduce noise, emphasize what matters
- Build scannable sections with clear hierarchy
- Keep paragraphs short and lists tight
- Highlight next actions

#### Style Rules

- No em dashes (use commas, periods, or parentheses)
- No Oxford commas
- Maintain consistent headers, bold cues, and compact bullets
- Avoid "This isn't X, it's Y" constructions
