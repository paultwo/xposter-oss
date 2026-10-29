import { applyD1Migrations, env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";
import { installMocks } from "./mock-x";

beforeAll(async () => {
  await applyD1Migrations(env.DB, JSON.parse(env.MIGRATIONS_JSON));
  fetchMock.activate();
  fetchMock.disableNetConnect();
  await installMocks();
});

beforeEach(async () => {
  await env.DB.prepare(
    "UPDATE app_settings SET x_plan = NULL, time_zone = 'America/New_York' WHERE id = 1",
  ).run();
});
