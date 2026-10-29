import { Hono } from "hono";
import { authenticate, protectCsrf, securityHeaders } from "./auth/gate";
import { htmlWanted, jsonError, loadShell } from "./http/shell";
import type { AppEnv } from "./http/types";
import { AppError } from "./items/model";
import { log } from "./lib/log";
import { registerApiRoutes } from "./routes/api";
import { registerHtmlRoutes } from "./routes/html";
import { registerOauthRoutes } from "./routes/oauth";
import { ProblemPage } from "./ui/pages";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", securityHeaders);
  app.use("*", authenticate);
  app.use("*", protectCsrf);

  app.onError(async (err, c) => {
    if (err instanceof AppError) {
      if (htmlWanted(c) && c.get("identity")?.kind === "human") {
        const shell = await loadShell(c, "Error", "");
        const heading =
          err.statusCode === 403
            ? "Forbidden"
            : err.statusCode === 404
              ? "Not found"
              : "Something went wrong";
        return c.html(
          <ProblemPage shell={shell} heading={heading} message={err.message} />,
          err.statusCode as 400,
        );
      }
      return jsonError(c, err);
    }
    log("error", "unhandled", {
      name: err instanceof Error ? err.name : "error",
    });
    return c.text(
      "Something broke on the server. Reload the page. Nothing was posted.",
      500,
    );
  });

  app.notFound(async (c) => {
    if (c.get("identity")?.kind === "human" && htmlWanted(c)) {
      const shell = await loadShell(c, "Not found", "");
      return c.html(
        <ProblemPage
          shell={shell}
          heading="Not found"
          message="That page is not here."
        />,
        404,
      );
    }
    return c.text("Not found", 404);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));
  registerHtmlRoutes(app);
  registerOauthRoutes(app);
  registerApiRoutes(app);
  return app;
}
