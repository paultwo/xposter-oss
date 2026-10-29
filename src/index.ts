import { createApp } from "./app";
import { log } from "./lib/log";
import { dispatch } from "./posting/dispatch";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const result = await dispatch(env, Date.now());
          log("info", "dispatch_finished", {
            posted: result.posted,
            skipped: result.skipped,
          });
        } catch (error) {
          log("error", "dispatch_failed", {
            name: error instanceof Error ? error.name : "error",
          });
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
