import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const NIL_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
const DATABASE_ID = "11111111-1111-4111-8111-111111111111";

function run(
  script: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("deploy preflight", () => {
  it("refuses the committed example and a missing file", () => {
    const example = run("scripts/preflight-deploy.mjs", [
      "--config",
      "wrangler.local.jsonc.example",
    ]);
    expect(example.status).toBe(1);
    expect(example.stderr).toContain(
      "account_id is missing or still a placeholder",
    );
    expect(example.stderr).toContain(
      "database_id is the nil UUID or still a placeholder",
    );
    expect(example.stderr).toContain(
      "ACCESS_AUD is empty or still a placeholder",
    );
    expect(example.stderr).toContain(
      "ACCESS_TEAM_DOMAIN is empty or still a placeholder",
    );
    expect(example.stderr).toContain(
      "routes uses an example.com or example.invalid host",
    );
    expect(example.stderr).toContain(
      "PUBLIC_ORIGIN is empty or uses an example.com or example.invalid host",
    );
    expect(example.stderr).toContain(
      "ALLOWED_APPROVER_EMAILS is empty or uses a placeholder address",
    );
    const missing = run("scripts/preflight-deploy.mjs", [
      "--config",
      "wrangler.local.jsonc",
    ]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("wrangler.local.jsonc is missing");
  });

  it("accepts a filled config and refuses each blocked value", () => {
    const dir = mkdtempSync(join(tmpdir(), "x-poster-preflight-"));
    const path = join(dir, "wrangler.jsonc");
    const base = {
      account_id: "a".repeat(32),
      routes: [{ pattern: "poster.example.test", custom_domain: true }],
      d1_databases: [{ binding: "DB", database_id: DATABASE_ID }],
      vars: {
        ACCESS_AUD: "audience-tag",
        ACCESS_TEAM_DOMAIN: "access.example.test",
        ACCESS_CERTS_URL: "",
        INTAKE_ACCESS_CLIENT_ID: "",
        ALLOWED_APPROVER_EMAILS: "owner@example.test",
        PUBLIC_ORIGIN: "https://poster.example.test",
      },
    };
    const blocked = [
      {
        value: { ...base, account_id: "YOUR_CLOUDFLARE_ACCOUNT_ID" },
        needle: "account_id",
      },
      {
        value: {
          ...base,
          d1_databases: [{ binding: "DB", database_id: NIL_DATABASE_ID }],
        },
        needle: "database_id",
      },
      {
        value: {
          ...base,
          d1_databases: [
            { binding: "DB", database_id: DATABASE_ID },
            { binding: "x_poster", database_id: DATABASE_ID },
          ],
        },
        needle: "more than one",
      },
      {
        value: {
          ...base,
          d1_databases: [{ binding: "x_poster", database_id: DATABASE_ID }],
        },
        needle: "one DB binding",
      },
      {
        value: { ...base, vars: { ...base.vars, ACCESS_AUD: "" } },
        needle: "ACCESS_AUD",
      },
      {
        value: {
          ...base,
          vars: { ...base.vars, ACCESS_TEAM_DOMAIN: "team.example.invalid" },
        },
        needle: "ACCESS_TEAM_DOMAIN",
      },
      {
        value: {
          ...base,
          vars: { ...base.vars, ACCESS_CERTS_URL: "https://certs.example.com" },
        },
        needle: "ACCESS_CERTS_URL",
      },
      {
        value: {
          ...base,
          vars: { ...base.vars, INTAKE_ACCESS_CLIENT_ID: "YOUR_CLIENT_ID" },
        },
        needle: "INTAKE_ACCESS_CLIENT_ID",
      },
      {
        value: {
          ...base,
          routes: [{ pattern: "poster.example.com", custom_domain: true }],
        },
        needle: "routes",
      },
      {
        value: {
          ...base,
          routes: [{ pattern: "*.example.invalid/*", custom_domain: false }],
        },
        needle: "routes",
      },
      {
        value: {
          ...base,
          vars: { ...base.vars, PUBLIC_ORIGIN: "https://poster.example.com" },
        },
        needle: "PUBLIC_ORIGIN",
      },
      {
        value: {
          ...base,
          vars: { ...base.vars, PUBLIC_ORIGIN: "https://team.example.invalid" },
        },
        needle: "PUBLIC_ORIGIN",
      },
      {
        value: { ...base, vars: { ...base.vars, PUBLIC_ORIGIN: "" } },
        needle: "PUBLIC_ORIGIN",
      },
      {
        value: { ...base, vars: { ...base.vars, ALLOWED_APPROVER_EMAILS: "" } },
        needle: "ALLOWED_APPROVER_EMAILS",
      },
      {
        value: {
          ...base,
          vars: { ...base.vars, ALLOWED_APPROVER_EMAILS: "you@example.com" },
        },
        needle: "ALLOWED_APPROVER_EMAILS",
      },
      {
        value: {
          ...base,
          vars: {
            ...base.vars,
            ALLOWED_APPROVER_EMAILS: "owner@mail.example.org",
          },
        },
        needle: "ALLOWED_APPROVER_EMAILS",
      },
      {
        value: {
          ...base,
          vars: { ...base.vars, ALLOWED_APPROVER_EMAILS: "owner@example.net" },
        },
        needle: "ALLOWED_APPROVER_EMAILS",
      },
      {
        value: {
          ...base,
          vars: { ...base.vars, ALLOWED_APPROVER_EMAILS: "owner@dept.invalid" },
        },
        needle: "ALLOWED_APPROVER_EMAILS",
      },
    ];
    try {
      writeFileSync(path, JSON.stringify(base));
      expect(
        run("scripts/preflight-deploy.mjs", ["--config", path]).status,
      ).toBe(0);
      for (const { value, needle } of blocked) {
        writeFileSync(path, JSON.stringify(value));
        const result = run("scripts/preflight-deploy.mjs", ["--config", path]);
        expect(result.status, needle).toBe(1);
        expect(result.stderr, needle).toContain(needle);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses deploy, versions upload, and dev of the committed config", () => {
    for (const command of ["deploy", "versions upload", "dev"]) {
      const result = run("scripts/refuse-committed-deploy.mjs", [], {
        WRANGLER_COMMAND: command,
      });
      expect(result.status, command).toBe(1);
      expect(result.stderr, command).toContain("x-poster-unconfigured");
    }
  });

  it("stays silent for wrangler types", () => {
    const result = run("scripts/refuse-committed-deploy.mjs", [], {
      WRANGLER_COMMAND: "types",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
