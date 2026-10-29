import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { defineWorkersProject, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

const TEST_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  const bufferJson = readFileSync("test/fixtures/buffer-drafts.json", "utf8");
  return {
    test: {
      projects: [
        {
          test: {
            name: "unit",
            environment: "node",
            include: ["test/unit/**/*.test.ts"],
          },
        },
        defineWorkersProject({
          test: {
            name: "workers",
            include: ["test/workers/**/*.test.ts"],
            setupFiles: ["./test/workers/apply.ts"],
            poolOptions: {
              workers: {
                singleWorker: true,
                wrangler: { configPath: "./wrangler.jsonc" },
                miniflare: {
                  bindings: {
                    ENVIRONMENT: "production",
                    POSTING_ENABLED: "true",
                    X_STANDARD_POST_LIMIT: "280",
                    X_PREMIUM_POST_LIMIT: "25000",
                    X_SHOW_MORE_AT: "280",
                    MAX_DAILY_POSTS: "20",
                    ALLOWED_APPROVER_EMAILS: "you@example.com",
                    ACCESS_TEAM_DOMAIN: "team.example.invalid",
                    ACCESS_AUD: "test-audience,intake-audience",
                    ACCESS_CERTS_URL: "https://access.test/cdn-cgi/access/certs",
                    X_API_BASE: "https://api.x.com",
                    X_AUTHORIZE_URL: "https://x.com/i/oauth2/authorize",
                    INTAKE_ACCESS_CLIENT_ID: "x-poster-intake",
                    X_FETCH_TIMEOUT_MS: "80",
                    PUBLIC_ORIGIN: "https://poster.example.com",
                    X_CLIENT_ID: "test-client-id",
                    X_CLIENT_SECRET: "test-client-secret",
                    TOKEN_ENC_KEY: TEST_KEY,
                    CSRF_SECRET: "test-csrf-secret",
                    INTAKE_TOKEN: "test-intake-token",
                    MIGRATIONS_JSON: JSON.stringify(migrations),
                    BUFFER_JSON: bufferJson,
                  },
                },
              },
            },
          },
        }),
      ],
    },
  };
});
