import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { type ItemJson, intakeHeaders, ORIGIN } from "./helpers";
import { resetX, signAccess } from "./mock-x";

const app = createApp();

beforeEach(() => {
  resetX();
});

describe("access gate", () => {
  it("rejects missing, wrong, expired, and non-allowlisted tokens", async () => {
    expect((await SELF.fetch(`${ORIGIN}/`)).status).toBe(403);
    const wrong = await signAccess(
      { email: "you@example.com" },
      { audience: "wrong" },
    );
    expect(
      (
        await SELF.fetch(`${ORIGIN}/`, {
          headers: { "cf-access-jwt-assertion": wrong },
        })
      ).status,
    ).toBe(403);
    const expired = await signAccess(
      { email: "you@example.com" },
      { exp: Math.floor(Date.now() / 1000) - 60 },
    );
    expect(
      (
        await SELF.fetch(`${ORIGIN}/`, {
          headers: { "cf-access-jwt-assertion": expired },
        })
      ).status,
    ).toBe(403);
    const intakeAud = await signAccess(
      { email: "you@example.com" },
      { audience: "intake-audience" },
    );
    expect(
      (
        await SELF.fetch(`${ORIGIN}/`, {
          headers: { "cf-access-jwt-assertion": intakeAud },
        })
      ).status,
    ).toBe(200);
    const other = await signAccess({ email: "other@example.com" });
    expect(
      (
        await SELF.fetch(`${ORIGIN}/`, {
          headers: { "cf-access-jwt-assertion": other },
        })
      ).status,
    ).toBe(403);
  });

  it("lets the intake service token read health and blocks it everywhere else", async () => {
    const serviceOnly = await signAccess({ common_name: "x-poster-intake" });
    expect(
      (
        await SELF.fetch(`${ORIGIN}/api/health`, {
          headers: { "cf-access-jwt-assertion": serviceOnly },
        })
      ).status,
    ).toBe(200);
    const headers = await intakeHeaders();
    const allowed = [
      {
        method: "POST",
        path: "/api/intake/drafts",
        body: { kind: "post", segments: [{ text: "Health check draft" }] },
      },
    ];
    for (const route of allowed) {
      const response = await SELF.fetch(`${ORIGIN}${route.path}`, {
        method: route.method,
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(route.body),
      });
      expect(response.status, route.path).not.toBe(403);
    }
    const created = (await (
      await SELF.fetch(`${ORIGIN}/api/intake/drafts`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          kind: "post",
          source_ref: "route-read",
          segments: [{ text: "Readable" }],
        }),
      })
    ).json()) as { item: ItemJson };
    const read = await SELF.fetch(
      `${ORIGIN}/api/intake/drafts/${created.item.id}`,
      { headers },
    );
    expect(read.status).toBe(200);
    const patch = await SELF.fetch(
      `${ORIGIN}/api/intake/drafts/${created.item.id}`,
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          kind: "post",
          segments: [{ text: "Readable still" }],
        }),
      },
    );
    expect(patch.status).toBe(200);

    const forbidden = [
      "GET /",
      "GET /?status=needs_approval",
      "GET /queue",
      "GET /compose",
      "GET /history",
      "GET /settings",
      "GET /items/01J00000000000000000000000",
      "GET /items/01J00000000000000000000000/review",
      "POST /items",
      "POST /items/01J00000000000000000000000",
      "POST /items/01J00000000000000000000000/approve",
      "POST /items/01J00000000000000000000000/schedule",
      "POST /items/01J00000000000000000000000/post-now",
      "POST /items/01J00000000000000000000000/archive",
      "POST /items/01J00000000000000000000000/restore",
      "POST /items/01J00000000000000000000000/reschedule",
      "POST /items/01J00000000000000000000000/mark-link",
      "POST /settings/pause",
      "GET /archived",
      "GET /avatar",
      "POST /oauth/x/disconnect",
      "GET /oauth/x/start",
      "GET /oauth/x/callback",
      "GET /api/account",
      "GET /api/items",
      "POST /api/items",
      "POST /api/items/01J00000000000000000000000/approve",
      "POST /api/items/01J00000000000000000000000/schedule",
      "POST /api/items/01J00000000000000000000000/post-now",
      "POST /api/items/01J00000000000000000000000/mark-link",
      "POST /api/items/01J00000000000000000000000/reschedule",
      "POST /api/settings/pause",
      "POST /api/admin/import/buffer",
      "DELETE /media/01J00000000000000000000000",
      "POST /__dev/dispatch",
    ];
    for (const route of forbidden) {
      const [method, path] = route.split(" ");
      const response = await SELF.fetch(`${ORIGIN}${path}`, {
        method,
        headers,
      });
      expect(response.status, route).toBe(403);
    }
  });

  it("returns 403 when ACCESS_AUD is empty", async () => {
    const jwt = await signAccess({ email: "you@example.com" });
    const response = await health(jwt, { ACCESS_AUD: "" });
    expect(response.status).toBe(403);
  });

  it("returns 403 when the team domain is empty", async () => {
    const jwt = await signAccess({ email: "you@example.com" });
    const response = await health(jwt, { ACCESS_TEAM_DOMAIN: "" });
    expect(response.status).toBe(403);
  });

  it("returns 403 when the allowlist is empty", async () => {
    const jwt = await signAccess({ email: "you@example.com" });
    const response = await health(jwt, { ALLOWED_APPROVER_EMAILS: "" });
    expect(response.status).toBe(403);
  });

  it("returns 403 when the allowlist is not a string", async () => {
    const jwt = await signAccess({ email: "you@example.com" });
    const response = await health(jwt, {
      ALLOWED_APPROVER_EMAILS: { bad: true } as unknown as string,
    });
    expect(response.status).toBe(403);
  });

  it("rejects a service identity when the intake client id is empty", async () => {
    const blank = await signAccess({ common_name: "" });
    const named = await signAccess({ common_name: "x-poster-intake" });
    for (const jwt of [blank, named]) {
      const response = await health(jwt, { INTAKE_ACCESS_CLIENT_ID: "" });
      expect(response.status).toBe(403);
    }
  });
});

function health(jwt: string, bindings: Partial<Env>): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${ORIGIN}/api/health`, {
        headers: { "cf-access-jwt-assertion": jwt },
      }),
      { ...env, ...bindings },
    ),
  );
}
