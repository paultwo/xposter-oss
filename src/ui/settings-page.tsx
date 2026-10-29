import { formatEt } from "../lib/time";
import { ErrorSummary, Layout } from "./layout";
import type { Shell } from "./shell";

export function SettingsPage(props: {
  shell: Shell;
  tokens: Array<{
    id: string;
    name: string;
    createdAt: number;
    revokedAt: number | null;
    lastUsedAt: number | null;
  }>;
  freshToken: string | null;
  message: string | null;
}) {
  const account = props.shell.account;
  return (
    <Layout shell={props.shell}>
      <h1>Settings</h1>
      <ErrorSummary message={props.message} />
      <section>
        <h2>X connection</h2>
        {account.connected ? (
          <dl>
            <div>
              <dt>Account</dt>
              <dd>@{account.username}</dd>
            </div>
            <div>
              <dt>Last refreshed</dt>
              <dd>
                {account.updatedAt
                  ? formatEt(account.updatedAt, props.shell.timeZone)
                  : "Unknown"}
              </dd>
            </div>
          </dl>
        ) : null}
        <p id="connection-status" role="status" aria-live="polite">
          {account.connected
            ? `Connected as @${account.username}.`
            : "X is disconnected."}
        </p>
        {account.connected ? (
          <p class="actions">
            <button type="button" id="disconnect">
              Disconnect X
            </button>
            <a class="button secondary" href="/oauth/x/start">
              Reconnect X
            </a>
          </p>
        ) : (
          <p>
            <a class="button" href="/oauth/x/start">
              Connect X
            </a>
          </p>
        )}
        <dialog id="disconnect-dialog" aria-labelledby="disconnect-title">
          <h2 id="disconnect-title">Disconnect X</h2>
          <p>Scheduled posts will wait until you connect X again.</p>
          <form method="post" action="/oauth/x/disconnect">
            <input type="hidden" name="csrf" value={props.shell.csrf} />
            <button type="submit">Disconnect X</button>
            <button type="button" class="secondary" id="close-disconnect">
              Cancel
            </button>
          </form>
        </dialog>
      </section>
      <section>
        <h2>Posting</h2>
        <p>
          {props.shell.longPosts
            ? `Long posts are on, up to ${props.shell.premiumLimit.toLocaleString("en-US")} characters. The preview shows more after ${props.shell.showMoreAt.toLocaleString("en-US")}.`
            : `Long posts are off. Posts over ${props.shell.standardLimit.toLocaleString("en-US")} characters must be a thread or an Article.`}
        </p>
        <form method="post" action="/settings/preferences">
          <input type="hidden" name="csrf" value={props.shell.csrf} />
          <div class="field">
            <label for="time-zone">Time zone</label>
            <input
              id="time-zone"
              name="time_zone"
              type="text"
              value={props.shell.timeZone}
              required
              autocomplete="off"
            />
          </div>
          <div class="field">
            <label for="x-plan">X plan</label>
            <select id="x-plan" name="x_plan">
              <option value="" selected={props.shell.planOverride === null}>
                Use the connected account
              </option>
              <option
                value="none"
                selected={props.shell.planOverride === "none"}
              >
                No Premium
              </option>
              <option
                value="basic"
                selected={props.shell.planOverride === "basic"}
              >
                Basic
              </option>
              <option
                value="premium"
                selected={props.shell.planOverride === "premium"}
              >
                Premium
              </option>
              <option
                value="premium_plus"
                selected={props.shell.planOverride === "premium_plus"}
              >
                Premium+
              </option>
            </select>
          </div>
          <button type="submit">Save preferences</button>
        </form>
      </section>
      <section>
        <h2>Bot tokens</h2>
        <p>Bots use a token to send drafts. They can't approve or post.</p>
        {props.freshToken ? (
          <p class="secret-once" role="status">
            Copy this token now. It will not be shown again. {props.freshToken}
          </p>
        ) : null}
        <form method="post" action="/settings/tokens">
          <input type="hidden" name="csrf" value={props.shell.csrf} />
          <div class="field">
            <label for="token-name">Token name. Required.</label>
            <input
              id="token-name"
              name="name"
              type="text"
              required
              minlength={2}
              maxlength={40}
              pattern="[a-z0-9-]{2,40}"
              autocomplete="off"
            />
          </div>
          <button type="submit">Create bot token</button>
        </form>
        {props.tokens.length === 0 ? <p>No bot tokens yet.</p> : null}
        <ul class="rows">
          {props.tokens.map((token) => (
            <li>
              <span>{token.name}</span>
              <span class="status">
                {token.revokedAt ? "Revoked" : "Active"}
              </span>
              {token.revokedAt ? null : (
                <>
                  <button
                    type="button"
                    class="secondary open-resend"
                    data-dialog={`revoke-${token.id}`}
                  >
                    Revoke {token.name}
                  </button>
                  <dialog
                    id={`revoke-${token.id}`}
                    aria-labelledby={`revoke-title-${token.id}`}
                  >
                    <h3 id={`revoke-title-${token.id}`}>
                      Revoke {token.name}?
                    </h3>
                    <p>Bots using this token can no longer send drafts.</p>
                    <form
                      method="post"
                      action={`/settings/tokens/${token.id}/revoke`}
                    >
                      <input
                        type="hidden"
                        name="csrf"
                        value={props.shell.csrf}
                      />
                      <button type="submit">Revoke {token.name}</button>
                      <button type="button" class="secondary close-resend">
                        Cancel
                      </button>
                    </form>
                  </dialog>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Buffer import</h2>
        <p>Imports Buffer drafts as drafts. Nothing is approved.</p>
        <form
          method="post"
          action="/settings/import"
          enctype="multipart/form-data"
        >
          <input type="hidden" name="csrf" value={props.shell.csrf} />
          <div class="field">
            <label for="buffer-file">Buffer export JSON. Required.</label>
            <input
              id="buffer-file"
              name="file"
              type="file"
              accept="application/json,.json"
              required
            />
          </div>
          <button type="submit" data-busy="Importing…">
            Import drafts
          </button>
        </form>
      </section>
    </Layout>
  );
}
