import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const SCOPE = "tweet.read tweet.write users.read media.write offline.access";
const keys = await generateKeyPair("RS256", { extractable: true });
const jwk = await exportJWK(keys.publicKey);
jwk.kid = "test-key";
jwk.alg = "RS256";
jwk.use = "sig";

const state = {
  scope: SCOPE,
  username: "exampleuser",
  displayName: "Test Account",
  subscriptionType: "None",
  failOnTweet: 0,
  tweetStatus: 0,
  tweets: 0,
  requests: [],
};

function record(method, path) {
  state.requests.push({ method, path });
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1:9099");
  const path = url.pathname;
  if (path !== "/__sign" && path !== "/__control" && path !== "/__requests")
    record(req.method ?? "GET", path);

  if (path === "/cdn-cgi/access/certs") {
    send(res, 200, { keys: [jwk] });
    return;
  }
  if (path === "/__sign" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    const claims = {};
    if (body.email) claims.email = body.email;
    if (body.common_name) claims.common_name = body.common_name;
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://team.example.invalid")
      .setAudience(body.audience || "test-audience")
      .setExpirationTime(body.exp || "2h")
      .sign(keys.privateKey);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(token);
    return;
  }
  if (path === "/__control" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    if (body.reset) {
      state.failOnTweet = 0;
      state.tweetStatus = 0;
      state.tweets = 0;
      state.requests = [];
      state.scope = SCOPE;
      state.username = "exampleuser";
      state.displayName = "Test Account";
      state.subscriptionType = "None";
    }
    if (typeof body.failOnTweet === "number")
      state.failOnTweet = body.failOnTweet;
    if (typeof body.tweetStatus === "number")
      state.tweetStatus = body.tweetStatus;
    if (typeof body.scope === "string") state.scope = body.scope;
    if (typeof body.username === "string") state.username = body.username;
    if (typeof body.subscriptionType === "string")
      state.subscriptionType = body.subscriptionType;
    send(res, 200, { ok: true, requests: state.requests.length });
    return;
  }
  if (path === "/__requests") {
    send(res, 200, { requests: state.requests });
    return;
  }
  if (path === "/i/oauth2/authorize") {
    const redirect = new URL(
      url.searchParams.get("redirect_uri") || "http://127.0.0.1/",
    );
    redirect.searchParams.set("code", "mock-code");
    redirect.searchParams.set("state", url.searchParams.get("state") || "");
    res.writeHead(302, { location: redirect.toString() });
    res.end();
    return;
  }
  if (path.startsWith("/2/dm") || path.startsWith("/2/chat")) {
    send(res, 404, { error: "not found" });
    return;
  }
  if (path === "/2/oauth2/token") {
    send(res, 200, {
      access_token: "mock-access-token",
      refresh_token: "mock-refresh-token",
      expires_in: 7200,
      scope: state.scope,
    });
    return;
  }
  if (path === "/2/oauth2/revoke") {
    send(res, 200, {});
    return;
  }
  if (path === "/avatar.jpg") {
    const bytes = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../fixtures/avatar.jpg"),
    );
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(bytes);
    return;
  }
  if (path === "/2/users/me") {
    send(res, 200, {
      data: {
        id: "999",
        username: state.username,
        name: state.displayName,
        subscription_type: state.subscriptionType,
        profile_image_url: "http://127.0.0.1:9099/avatar.jpg",
      },
    });
    return;
  }
  if (path === "/2/tweets" && req.method === "POST") {
    state.tweets += 1;
    if (state.failOnTweet && state.tweets === state.failOnTweet) return;
    if (state.tweetStatus) {
      send(res, state.tweetStatus, {});
      return;
    }
    const raw = JSON.parse((await readBody(req)).toString() || "{}");
    send(res, 201, {
      data: { id: String(8000 + state.tweets), text: raw.text ?? "" },
    });
    return;
  }
  if (path === "/2/media/upload") {
    send(res, 200, { data: { id: `med_${state.requests.length}` } });
    return;
  }
  if (path === "/2/media/metadata") {
    send(res, 200, {});
    return;
  }
  if (path === "/2/articles/draft") {
    send(res, 200, { data: { id: "art_e2e" } });
    return;
  }
  if (path.startsWith("/2/articles/") && path.endsWith("/publish")) {
    send(res, 200, { data: { post_id: "8555" } });
    return;
  }
  send(res, 404, { error: "not found" });
});

server.listen(9099, "127.0.0.1");
