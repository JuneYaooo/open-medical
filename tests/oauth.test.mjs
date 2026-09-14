import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceDatabase, WorkspaceStore } from "../server/core/index.mjs";
import { CredentialVault, MCPOAuth } from "../server/core/oauth.mjs";

test("credential vault authenticates owner binding and never stores plaintext tokens", (t) => {
  const root = mkdtempSync(join(tmpdir(), "oauth-vault-"));
  const db = new WorkspaceDatabase(join(root, "db.sqlite"));
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const vault = new CredentialVault(db.db, root);
  vault.set("alice", { token: "private-token-value" });
  assert.deepEqual(vault.get("alice"), { token: "private-token-value" });
  const row = db.db
    .prepare("SELECT data FROM agent_credentials WHERE id='alice'")
    .get();
  assert.ok(!row.data.includes("private-token-value"));
  db.db.prepare("INSERT INTO agent_credentials VALUES ('bob',?)").run(row.data);
  assert.throws(() => vault.get("bob"));
  assert.equal(readFileSync(join(root, "credentials.key")).length, 32);
  vault.delete("alice");
  assert.deepEqual(vault.get("alice"), {});
});

test("MCP OAuth completes local DCR and PKCE callback, rejects wrong state and isolates tokens", async (t) => {
  let origin, registered;
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const send = (value) => res.end(JSON.stringify(value));
    if (req.url.includes("oauth-protected-resource"))
      return send({
        resource: origin + "/mcp",
        authorization_servers: [origin],
      });
    if (
      req.url.includes("oauth-authorization-server") ||
      req.url.includes("openid-configuration")
    )
      return send({
        issuer: origin,
        authorization_endpoint: origin + "/authorize",
        token_endpoint: origin + "/token",
        registration_endpoint: origin + "/register",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    if (req.url === "/register") {
      registered = JSON.parse(raw);
      return send({ ...registered, client_id: "client-test" });
    }
    if (req.url === "/token") {
      const params = new URLSearchParams(raw);
      assert.equal(params.get("code"), "local-code");
      assert.ok(params.get("code_verifier").length >= 43);
      return send({
        access_token: "oauth-private-access",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "oauth-private-refresh",
      });
    }
    res.statusCode = 404;
    send({ error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const root = mkdtempSync(join(tmpdir(), "oauth-flow-"));
  const db = new WorkspaceDatabase(join(root, "db.sqlite")),
    store = new WorkspaceStore(db.db),
    oauth = new MCPOAuth(store);
  t.after(async () => {
    oauth.close();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const w = store.create({ root, permissions: { grants: {} } });
  const config = {
    id: "test",
    url: origin + "/mcp",
    transport: "http",
    oauth: { origins: [origin] },
  };
  store.update(w.id, (value) => {
    value.extensions = { mcpServers: [config] };
  });
  const started = await oauth.start(w.id, config);
  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.origin, origin);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  const callback = new URL(registered.redirect_uris[0]);
  callback.searchParams.set("state", "wrong");
  callback.searchParams.set("code", "local-code");
  assert.equal((await fetch(callback)).status, 403);
  callback.searchParams.set("state", authorization.searchParams.get("state"));
  const result = await fetch(callback);
  assert.equal(result.status, 200, await result.text());
  assert.equal(oauth.status(w.id, config).connected, true);
  assert.equal(
    oauth.provider(w.id, config).tokens().access_token,
    "oauth-private-access",
  );
  assert.equal(oauth.provider("other", config).tokens(), undefined);
  await assert.rejects(
    oauth.fetch(config)("https://unapproved.invalid/token"),
    (e) => e.code === "OAUTH_ORIGIN",
  );
  oauth.revoke(w.id, config);
  assert.equal(oauth.status(w.id, config).connected, false);
});
