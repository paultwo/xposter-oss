# Contributing

Forks and pull requests are welcome, from people and from their bots.

## How to send a change

1. Fork the repo and create a branch.
2. Run `npm ci`, `npm run fonts`, and `npm run types`.
3. Make the change. Keep it small and focused, and include a test.
4. Run the checks before you open the pull request:
   - `npx biome check .`
   - `npm run typecheck`
   - `npm test`
   - `npx playwright install chromium webkit` and then `npx playwright test`
5. Open a pull request against `main`. Say what changed, why, and how you tested it.

CI runs the same checks and a gitleaks scan. A maintainer approves CI runs for first-time contributors before they start.

## Ground rules

- Never commit secrets, tokens, `.dev.vars`, `.secrets.local`, or `wrangler.local.jsonc`. Use the placeholders in `wrangler.local.jsonc.example` and `.dev.vars.example`.
- Never put real people's drafts or posts in fixtures. Use made-up text.
- Tests use the mock X server in `test/mock-x`. Never point tests at the real X API.
- Anything that can post to X must stay behind approval. Anything that is posting, or has any part on X, must not be deleted or changed by the app. An unconfirmed send can be deleted only after a dialog that says it may already be on X.

## Reporting a security issue

Please don't open a public issue. Use GitHub's private vulnerability reporting on this repo instead.

By contributing, you agree that your contribution is licensed under the MIT License in `LICENSE`.
