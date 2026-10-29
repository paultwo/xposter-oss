import { existsSync, readFileSync } from "node:fs";

const NIL_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
const configFlag = process.argv.indexOf("--config");
const configPath =
  configFlag >= 0 ? process.argv[configFlag + 1] : "wrangler.local.jsonc";

if (!configPath || !existsSync(configPath)) {
  console.error(
    `Refusing to deploy. ${configPath || "wrangler.local.jsonc"} is missing. Copy wrangler.local.jsonc.example to wrangler.local.jsonc and replace the placeholders.`,
  );
  process.exit(1);
}

const config = JSON.parse(
  readFileSync(configPath, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1"),
);

const problems = [];

function textOf(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isPlaceholder(value) {
  const text = textOf(value);
  if (!text) return true;
  if (text.includes("YOUR_")) return true;
  if (text.includes("example.invalid")) return true;
  if (text.includes("example.com")) return true;
  if (text === NIL_DATABASE_ID) return true;
  return false;
}

function hostOf(value) {
  const text = textOf(value);
  if (!text) return "";
  const candidate = text.includes("://") ? text : `https://${text}`;
  try {
    return new URL(candidate).hostname.replace(/\.$/, "").toLowerCase();
  } catch {
    return text.split("/")[0].replace(/^\*\./, "").toLowerCase();
  }
}

function isReservedHost(host) {
  return (
    host === "example.com" ||
    host.endsWith(".example.com") ||
    host === "example.invalid" ||
    host.endsWith(".example.invalid")
  );
}

function isReservedEmail(email) {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (!domain || domain === email) return false;
  return (
    domain === "example.com" ||
    domain.endsWith(".example.com") ||
    domain === "example.org" ||
    domain.endsWith(".example.org") ||
    domain === "example.net" ||
    domain.endsWith(".example.net") ||
    domain === "invalid" ||
    domain.endsWith(".invalid")
  );
}

if (isPlaceholder(config.account_id)) {
  problems.push("account_id is missing or still a placeholder");
}

const databases = Array.isArray(config.d1_databases) ? config.d1_databases : [];
if (databases.length > 1) {
  problems.push("d1_databases has more than one entry");
}
const dbEntries = databases.filter((entry) => entry?.binding === "DB");
if (dbEntries.length !== 1) {
  problems.push("d1_databases must contain one DB binding");
} else if (
  textOf(dbEntries[0].database_id) === NIL_DATABASE_ID ||
  isPlaceholder(dbEntries[0].database_id)
) {
  problems.push("database_id is the nil UUID or still a placeholder");
}

for (const key of ["ACCESS_AUD", "ACCESS_TEAM_DOMAIN"]) {
  const value = config.vars?.[key];
  if (!textOf(value) || isPlaceholder(value)) {
    problems.push(`${key} is empty or still a placeholder`);
  }
}

for (const key of ["ACCESS_CERTS_URL", "INTAKE_ACCESS_CLIENT_ID"]) {
  const value = config.vars?.[key];
  if (textOf(value) && isPlaceholder(value)) {
    problems.push(`${key} is still a placeholder`);
  }
}

const routePatterns = [];
if (typeof config.route === "string") routePatterns.push(config.route);
else if (typeof config.route?.pattern === "string") {
  routePatterns.push(config.route.pattern);
}
if (Array.isArray(config.routes)) {
  for (const route of config.routes) {
    if (typeof route === "string") routePatterns.push(route);
    else if (typeof route?.pattern === "string")
      routePatterns.push(route.pattern);
  }
}
if (routePatterns.some((pattern) => isReservedHost(hostOf(pattern)))) {
  problems.push("routes uses an example.com or example.invalid host");
}

const origin = config.vars?.PUBLIC_ORIGIN;
if (!textOf(origin) || isReservedHost(hostOf(origin))) {
  problems.push(
    "PUBLIC_ORIGIN is empty or uses an example.com or example.invalid host",
  );
}

const approvers = textOf(config.vars?.ALLOWED_APPROVER_EMAILS);
const approverList = approvers
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter((email) => email.length > 0);
if (approverList.length === 0 || approverList.some(isReservedEmail)) {
  problems.push(
    "ALLOWED_APPROVER_EMAILS is empty or uses a placeholder address",
  );
}

if (problems.length > 0) {
  console.error(`Refusing to deploy ${configPath}:`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
