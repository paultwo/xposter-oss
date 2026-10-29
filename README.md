# X Poster

A tool for composing, approving, scheduling, and posting to the connected X account. It replaces Buffer. Buffer's X connection turned off X Chat encryption.

Nothing posts until you approve the exact text. The Worker ships with posting turned off. One instance has one connected account.

## What it does

- Drafts, threads, images with alt text, and X Articles.
- A Drafts dashboard as the first screen. It lists every draft, including the Buffer imports, with a preview laid out like X: thread segments, images with their alt text, and the character count. Each draft has Approve and Edit. Filters: Draft, In review, Needs your approval, Approved, Scheduled, Posted.
- A queue for the week at `/queue`, a composer, a review step, history, and settings.
- A draft-only intake API for bots. A bot cannot approve or post.
- A cron that runs every minute and posts due items one segment at a time.
- OAuth 2.0 with PKCE. The only scopes are `tweet.read tweet.write users.read media.write offline.access`.

## Editorial stages

Hemingway is an editorial pass before a draft needs your approval. It is a stage on a draft, not a user, and it has no login.

A draft has one of three stages: `draft`, `needs_hemingway`, or `needs_approval`. The stage only applies while the status is `draft`. It is not part of the content hash, and it does not change what can post.

- Intake can set `stage` to `needs_hemingway` or `needs_approval`. It can do this on create (`POST /api/intake/drafts`) or later (`PATCH /api/intake/drafts/:id` with `{"stage": "needs_approval"}`). Any other value returns 422.
- Intake can only change its own drafts, and only while they are drafts.
- Only an allowlisted Access session can approve. Approving from the dashboard sends the content hash shown on screen. If the text changed since the page loaded, approval fails with 409.
- When you edit the text, the item goes back to draft and its stage goes back to `draft`.
- Approving does not schedule. Nothing posts until you schedule it and `POSTING_ENABLED` is true.

## Drafts saved in X

X Poster does not import drafts saved in X. The X API has no endpoint that lists a user's saved post drafts or Article drafts.

On Oct 21, 2026, the X API v2 OpenAPI spec (`https://docs.x.com/openapi.json`, version 2.172) had two Articles operations, and both are writes: `POST /2/articles/draft` and `POST /2/articles/{article_id}/publish`. No path lists, reads, or searches post drafts or Article drafts. The Articles introduction page describes only create and publish.

So X Poster scrapes nothing from X and requests no extra scopes. The scopes stay `tweet.read tweet.write users.read media.write offline.access`. If X adds a read endpoint for drafts under those scopes, it can be imported read-only later.

## Self-host

X Poster is one Cloudflare Worker for one person. Use Node.js 22. Per-deployment values are not in git. Copy `wrangler.local.jsonc.example` to `wrangler.local.jsonc` and replace every placeholder. `wrangler.local.jsonc` is gitignored.

The committed `wrangler.jsonc` is what tests and `wrangler types` load. Its worker name is `x-poster-unconfigured`. It has no account id, no route, and the all-zero D1 id. `npm run dev` runs `wrangler dev --config wrangler.local.jsonc`. `npm run deploy` runs `scripts/preflight-deploy.mjs`, then `wrangler deploy --config wrangler.local.jsonc`. The preflight stops the deploy when `account_id` is missing or still a placeholder, when `d1_databases` has more than one entry, when the `DB` binding is missing or its `database_id` is the nil UUID or still a placeholder, when `ACCESS_AUD` or `ACCESS_TEAM_DOMAIN` is empty or still a placeholder, when `ACCESS_CERTS_URL` or `INTAKE_ACCESS_CLIENT_ID` is a placeholder, when a route or `PUBLIC_ORIGIN` uses an `example.com` or `example.invalid` host, or when `ALLOWED_APPROVER_EMAILS` is empty or any address is at `example.com`, `example.org`, `example.net`, or a `.invalid` domain. A plain `wrangler deploy` loads the committed file. `scripts/refuse-committed-deploy.mjs` exits before upload when `WRANGLER_COMMAND` is `deploy`, `versions upload`, or `dev`. For `wrangler types` it prints nothing and exits 0. The committed worker name stays `x-poster-unconfigured`, so the placeholders stay off the worker name `x-poster`.

`POSTING_ENABLED` stays `"false"` until you have approved a post and decided that posting can be turned on. `workers_dev` stays false.

### Cloudflare Worker and D1

1. Copy `wrangler.local.jsonc.example` to `wrangler.local.jsonc`.
2. `npx wrangler login --config wrangler.local.jsonc`.
3. Set `account_id` to your Cloudflare account id.
4. Create the database and write its id into the `DB` binding: `npx wrangler d1 create x-poster --config wrangler.local.jsonc --update-config --binding DB`. `--binding DB` updates that entry. Without it, Wrangler prompts, defaults the binding to `x_poster`, and appends a second `d1_databases` entry. The `DB` entry keeps `YOUR_D1_DATABASE_ID`, and both the preflight and `d1 migrations apply` keep using that placeholder.
5. If `x-poster` already exists, do not create it again. `npx wrangler d1 list --config wrangler.local.jsonc` prints the database id. Paste that id into `database_id` on the entry whose `binding` is `DB`, and delete any other `d1_databases` entry.
6. Create the private R2 bucket: `npx wrangler r2 bucket create x-poster-media --config wrangler.local.jsonc`. Change `bucket_name` in the local file if you use a different bucket.
7. Set `PUBLIC_ORIGIN` to the https origin you will serve, with no trailing slash. Set the route `pattern` to that hostname and leave `custom_domain` true. The DNS zone for that hostname has to be on this same Cloudflare account, because `custom_domain` attaches the Worker to that zone. The X OAuth redirect URI is `${PUBLIC_ORIGIN}/oauth/x/callback`.
8. Apply migrations: `npx wrangler d1 migrations apply x-poster --remote --config wrangler.local.jsonc`.

### Cloudflare Access

1. Create an Access application for the hostname in your route.
2. Set `ACCESS_TEAM_DOMAIN` to your team host. The example file uses `team.example.invalid` until you replace it.
3. In the Cloudflare dashboard, open Zero Trust, then Access, then Applications. Open this application and copy the Application Audience (AUD) tag into `ACCESS_AUD`.
4. The Access policy has to allow the same email addresses as `ALLOWED_APPROVER_EMAILS`. Put those emails in `ALLOWED_APPROVER_EMAILS`, comma-separated. Only an allowlisted Access session can approve.
5. Leave `ACCESS_CERTS_URL` empty. The Worker then uses `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`.
6. Intake (`/api/intake/*`) can use a second Access application with a service token. When you have one, append its audience tag to `ACCESS_AUD` after the site tag, and set `INTAKE_ACCESS_CLIENT_ID` to the service token's client id (`common_name`). Until then, leave `INTAKE_ACCESS_CLIENT_ID` empty. Requests to `/api/intake/*` are checked against `ACCESS_AUD`.

### X developer app

1. Create an app in the X developer portal with OAuth 2.0 and a confidential client.
2. Set the callback URL to `https://<your PUBLIC_ORIGIN>/oauth/x/callback`.
3. Grant only `tweet.read tweet.write users.read media.write offline.access`.
4. Copy the client id and client secret into Worker secrets. Do not put them in git.

### Secrets

Set each secret with Wrangler. The command reads the value from stdin and does not print it:

```sh
npx wrangler secret put X_CLIENT_ID --config wrangler.local.jsonc
npx wrangler secret put X_CLIENT_SECRET --config wrangler.local.jsonc
npx wrangler secret put TOKEN_ENC_KEY --config wrangler.local.jsonc
npx wrangler secret put CSRF_SECRET --config wrangler.local.jsonc
npx wrangler secret put INTAKE_TOKEN --config wrangler.local.jsonc
```

| Name | What to put |
| --- | --- |
| `X_CLIENT_ID` | Client id from the X developer app. |
| `X_CLIENT_SECRET` | Client secret from the X developer app. |
| `TOKEN_ENC_KEY` | 32 random bytes, base64. Generate one with `openssl rand -base64 32`. |
| `CSRF_SECRET` | A long random string. Generate a new one for this Worker. |
| `INTAKE_TOKEN` | Bearer token for draft intake. Generate a new one. You can also create more tokens in Settings. Those are hashed in D1 and shown once. |

`.dev.vars.example` lists the same names and nothing else. Copy it to `.dev.vars` for local dev. `.dev.vars` is gitignored.

### Deploy

```sh
npm ci
npm run deploy
```

`npm run deploy` is `node scripts/preflight-deploy.mjs && wrangler deploy --config wrangler.local.jsonc`.

Confirm `POSTING_ENABLED` is still `"false"`.

Open the hostname without a session and confirm it redirects to the Access login. `GET /api/health` returns 200 for an allowlisted person's Access JWT. It also returns 200 for the intake service token when `INTAKE_ACCESS_CLIENT_ID` is set. Until that client id is set, the intake check does not pass. Intake with a service token and a bad bearer returns 403.

Connect X from Settings and check the granted scopes. Approving does not post. The first real post waits until you approve one item and set `POSTING_ENABLED` to `true`.

## Local proof

```sh
npm ci
npm run fonts
npm test
npx playwright install chromium
npx playwright test
```

Tests use a mock X API. They do not call X and they do not post.

`scripts/dev-proof.sh` is the proof path. It writes a gitignored `.dev.vars` of obvious test values when that file is missing, applies the local D1 migrations with `--config wrangler.proof.jsonc`, and starts `wrangler dev --config wrangler.proof.jsonc`.

## Decisions that differ from the spec

- Any Cloudflare account can host the Worker. The account id, D1 id, Access audience, team domain, approver emails, public origin, and custom domain stay in gitignored `wrangler.local.jsonc`.
- The GitHub default branch is `master`. The pull request targets `master`.
- `GET /api/health` is the only route that accepts an Access JWT and nothing else. It returns 200 for an allowlisted person's JWT (an AUD in `ACCESS_AUD`) and, when `INTAKE_ACCESS_CLIENT_ID` is set, for the intake service token's JWT (`common_name` equals that id), without the intake bearer. Until that client id is set, the intake check does not pass. Every other route returns 403 for intake credentials. The three intake routes, which also require `Authorization: Bearer`, are `POST /api/intake/drafts`, `GET /api/intake/drafts/:id`, and `PATCH /api/intake/drafts/:id`.
- There is no collection list on the intake API. The spec's route table allows exactly those three routes.
- `INTAKE_TOKEN` is a Worker secret in addition to tokens you create in Settings. The secret is the reserved caller `env:intake` (display name `x-drafts`). Drafts are keyed by that immutable id. A token minted in Settings cannot take the id `env:intake`. Intake accepts image bytes only. Remote image URLs are rejected.
- The content hash includes `kind`. Notes are not part of the hash, so a notes-only edit keeps approval.
- Buffer import is `POST /api/admin/import/buffer` for an allowlisted person, and the same action is on the Settings page. Five fictional sample drafts are committed at `test/fixtures/buffer-drafts.json`. The import test fails if that file is missing. Bracket placeholders are stored byte-identical.
- `x_article_id` and `reviewed_by` are extra columns. An article draft id is stored before publish so a retry publishes the same draft.
- The UI cannot turn `POSTING_ENABLED` on. That stays a Worker var. The app can pause posting: `app_settings.posting_paused` is a D1 flag, and the cron posts only when the var is true and the flag is 0. There is no control that clears the flag. Clearing it is a database change.
- A scheduled item that comes due while posting is off is marked `missed`. It stays scheduled and approved. It does not post when posting returns. You pick a future time with Reschedule. A cron that runs a little late while posting stayed on still posts, because that case has no blocked window.
- The cron posts one segment per tick. Claiming the lease and inserting the attempt row are one D1 statement. A segment with an attempt and no post id is unknown: it goes to Needs you and is not sent again until you confirm. "It posted (paste link)" records that segment's id. "It didn't post. Send again" requires confirm and authorizes one new attempt for that segment. A definite rejection after an earlier segment is live stays on Needs you so you can resume the remainder, mark the item posted, or archive it. The daily cap counts segments that already have a post id.
- Pasting a status link records the id of the unknown segment only. The item becomes scheduled when later segments are still unsent, and posted when every segment has an id. The link must be an https `x.com` or `twitter.com` status URL for the connected account, or an `/i/web/status` or `/i/status` URL.
- Restore moves an archived item back to draft and clears its approval and schedule.

- Delete removes a draft, an approved draft, a scheduled post, or an archived item for good, after a confirm dialog. Deleting a scheduled post takes it off the queue, so it never posts: the delete and the cron's claim are each one guarded D1 statement, so whichever runs first wins. Delete is refused for anything posting, posted, or in Needs you, and for any item with an X post id or an attempt that might have posted. It never touches X. The API is `DELETE /api/items/:id` with the body `{"confirm": true}`. The intake API cannot delete. One audit row with no item id records each deletion.
- On connect, `GET /2/users/me?user.fields=profile_image_url,name,subscription_type` runs under `users.read`. The handle, display name, and avatar come from that response. The image is cached in R2 when the URL is public https or the configured API origin. A failure leaves the initials in place. No scope was added. `subscription_type` (`None`, `Basic`, `Premium`, `PremiumPlus`) is the plan when X returns it. Settings can override the plan, and can set it when the field is absent. The time zone is a setting, default `America/New_York`.
- Post length is config, not a guess. `X_STANDARD_POST_LIMIT` is 280. `X_PREMIUM_POST_LIMIT` is 25000, from X Help, About X Premium: longer posts allow subscribers to post up to 25,000 characters (https://help.x.com/en/using-x/x-premium, archived 2026-10-10 at https://web.archive.org/web/20261010222205/https://help.x.com/en/using-x/x-premium). Basic includes longer posts. `X_SHOW_MORE_AT` is 280. X's data dictionary says `note_tweet` is the full text of a long-form Post over 280 characters (https://docs.x.com/x-api/fundamentals/data-dictionary, read 2026-10-21), and X Help says a longer post extends past the typical 280 and that mentions notify only in the first 280 (https://help.x.com/en/using-x/types-of-posts, archived 2026-10-13 at https://web.archive.org/web/20261013221258/https://help.x.com/en/using-x/types-of-posts). The preview cuts there and says Show more. A draft over the standard limit can stay a long post, become a thread, or become an Article. Approval, the content hash, and posting treat a long post as the same text.
- Articles are text only. The publish call sends the title and body, so an article with an image is rejected at save. Images work on posts and threads.
- The dashboard has an Approved filter as well as Needs your approval, so an item that is approved but not scheduled stays visible. Needs you and missed items are first in the list and under the Needs you filter. Statuses are draft, approved, scheduled, posting, posted, needs you, and archived. Unknown and rejected attempts both use needs you; `needs_reason` says which buttons apply.
- The queue moved from `/` to `/queue`. `/` is the Drafts dashboard.
- VoiceOver and NVDA were not available on the Linux agent that built this. The screen reader note is the accessibility tree from Playwright.

## Contributing

Forks and pull requests are welcome. See `CONTRIBUTING.md`.

## License

`LICENSE` is the MIT License, copyright Paul Dietzel.
