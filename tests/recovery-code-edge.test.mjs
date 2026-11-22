import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createApp } from "../apps/api/server.mjs";
import { recoveryCodeHash, totpAt } from "../apps/api/mfa.mjs";

test("ORB-011: issued recovery codes containing multiple hyphens remain accepted", async () => {
  const clock = 1_700_000_000_000;
  const token = "recovery-regression-bootstrap-token";
  const app = createApp({ dbPath: ":memory:", startWorker: false, bootstrapToken: token, mfaKey: randomBytes(32).toString("base64"), mfaClock: () => clock });
  await new Promise((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
  const base = "http://127.0.0.1:" + app.server.address().port;
  const post = (url, body, cookie = "") => fetch(base + url, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  try {
    const boot = await post("/api/auth/bootstrap", { token, email: "owner@example.test", password: "test-owner-password-12345" });
    assert.equal(boot.status, 201);
    const cookie = boot.headers.get("set-cookie").split(";")[0];
    const enroll = await post("/api/auth/mfa/enroll", { password: "test-owner-password-12345" }, cookie);
    assert.equal(enroll.status, 201);
    const secret = (await enroll.json()).secret;
    const confirmed = await post("/api/auth/mfa/confirm", { code: totpAt(secret, clock / 1000) }, cookie);
    assert.equal(confirmed.status, 200);
    const { recoveryCodes } = await confirmed.json();
    const fixtureCode = "ABCD----EFGHIJKLMNOPQR";
    assert.equal(fixtureCode.length, 22);
    assert.equal(fixtureCode.replaceAll("-", "").length, 18);
    app.db.prepare("UPDATE recovery_codes SET code_hash = ? WHERE code_hash = ?")
      .run(recoveryCodeHash(fixtureCode), recoveryCodeHash(recoveryCodes[0]));
    const login = await post("/api/auth/login", { email: "owner@example.test", password: "test-owner-password-12345" });
    assert.equal(login.status, 202);
    const challenge = (await login.json()).challenge;
    const recovered = await post("/api/auth/mfa/challenge", { challenge, code: fixtureCode });
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).recoveryCodeUsed, true);
  } finally { app.close(); }
});
