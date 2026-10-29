import type { Child } from "hono/jsx";
import type { Shell } from "./shell";
import { pauseConfirmCopy, postingClass, postingLabel } from "./text";

const NAV = [
  { href: "/", label: "Drafts", path: "/" },
  { href: "/queue", label: "Queue", path: "/queue" },
  { href: "/compose", label: "New draft", path: "/compose" },
  { href: "/history", label: "History", path: "/history" },
  { href: "/settings", label: "Settings", path: "/settings" },
];

export function Layout(props: { shell: Shell; children?: Child }) {
  const { shell } = props;
  const account = shell.account.connected
    ? `@${shell.account.username ?? "unknown"}`
    : "X not connected";
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <meta name="csrf" content={shell.csrf} />
        <title>{shell.title} · X Poster</title>
        <link rel="stylesheet" href="/app.css" />
      </head>
      <body>
        <a class="skip" href="#main">
          Skip to content
        </a>
        <header class="top">
          <div>
            <p class="wordmark">X Poster</p>
            <p class="account">{account}</p>
          </div>
        </header>
        <div class="posting-bar">
          <p id="posting-state" class={postingClass(shell)} role="status">
            {postingLabel(shell)}
          </p>
          {shell.showPause ? (
            <button type="button" id="open-pause">
              Pause all posting
            </button>
          ) : null}
        </div>
        {shell.credits ? (
          <p class="banner banner-credits" role="status">
            X API credits are empty. Posting will fail until the balance is
            refilled.
          </p>
        ) : null}
        {shell.account.needsReconnect ? (
          <p class="banner" role="status">
            X needs to be connected again. Scheduled posts are waiting.
          </p>
        ) : null}
        {shell.banner ? (
          <p class="banner" role="status">
            {shell.banner}
          </p>
        ) : null}
        <div class="shell">
          <nav aria-label="Sections">
            <ul>
              {NAV.map((item) => (
                <li>
                  <a
                    href={item.href}
                    aria-current={shell.path === item.path ? "page" : undefined}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <main id="main">
            {shell.notice ? (
              <p class="notice" role="status">
                {shell.notice}
              </p>
            ) : null}
            {props.children}
          </main>
        </div>
        <footer>
          <p>
            {shell.account.username
              ? `Posts go to @${shell.account.username}. `
              : "Posts go to the connected X account. "}
            A draft stays a draft until you approve that exact text.
          </p>
        </footer>
        {shell.showPause ? (
          <dialog
            id="pause-dialog"
            aria-labelledby="pause-title"
            aria-describedby="pause-warning"
          >
            <h2 id="pause-title">Pause all posting?</h2>
            <p id="pause-warning">{pauseConfirmCopy()}</p>
            <form method="post" action="/settings/pause">
              <input type="hidden" name="csrf" value={shell.csrf} />
              <button type="submit" class="danger">
                Pause all posting
              </button>
              <button type="button" class="secondary" id="close-pause">
                Cancel
              </button>
            </form>
          </dialog>
        ) : null}
        <script src="/app.js"></script>
      </body>
    </html>
  );
}

export function ErrorSummary(props: { message: string | null }) {
  if (!props.message) return null;
  return (
    <div id="error-summary" class="error-summary" role="alert" tabindex={-1}>
      <p>{props.message}</p>
    </div>
  );
}
