import { createServer } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Deliberately CI-only: neither createApp nor npm start imports or exposes it.
// Only binds to IPv4 localhost; never exposes external DB/provider operations.
// Session cookies are *provided by the disposable test fixture*, not issued or
// authenticated by SQLite. The PostgreSQL database is authoritative.
const SESSION = /^[A-Za-z0-9_-]{32,256}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CSRF = /^[0-9a-f]{64}$/;
const SECRET_BYTES = 32;

function answer(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    ...extraHeaders,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "pragma": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'",
  });
  response.end(JSON.stringify(body));
}
function cookie(header, name) {
  const match = String(header ?? "").split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(name + "="));
  return match?.slice(name.length + 1) ?? null;
}
async function limitedJson(request, shape = "account") {
  const contentType = String(request.headers["content-type"] ?? "");
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw new TypeError("invalid_content_type");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > 2048) throw new RangeError("request_too_large");
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new TypeError("invalid_json"); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new TypeError("invalid_json_shape");
  }
  const keys = Object.keys(parsed).sort().join(",");
  if (shape === "account" &&
      keys === "accountId" &&
      typeof parsed.accountId === "string" && ID.test(parsed.accountId)) {
    return parsed;
  }
  if (shape === "login" &&
      keys === "email,password" &&
      typeof parsed.email === "string" && parsed.email.length <= 254 &&
      typeof parsed.password === "string" && parsed.password.length <= 128) {
    return parsed;
  }
  if (shape === "recovery" && keys === "code" &&
      typeof parsed.code === "string" && parsed.code.length <= 128) {
    return parsed;
  }
  throw new TypeError("invalid_request_shape");
}
function secureEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" ||
      !CSRF.test(left) || !CSRF.test(right)) return false;
  return timingSafeEqual(Buffer.from(left,"ascii"),Buffer.from(right,"ascii"));
}
export function createPostgresSyntheticHttpHarness({
  gateway, loginAdapter = null, csrfSecret = randomBytes(SECRET_BYTES),
} = {}) {
  if (process.env.GITHUB_ACTIONS !== "true" ||
      process.env.ORBICORE_CI_SYNTHETIC_PG_HTTP !== "1") {
    throw new Error("synthetic_http_github_ci_only");
  }
  if (!gateway || typeof gateway.enqueue !== "function" ||
      typeof gateway.sessionTenant !== "function") {
    throw new TypeError("A restricted PostgreSQL gateway with sessionTenant and enqueue is required");
  }
  if (loginAdapter !== null && (
    typeof loginAdapter.login !== "function" ||
    typeof loginAdapter.finishRecoveryMfa !== "function" ||
    typeof loginAdapter.revoke !== "function"
  )) {
    throw new TypeError("loginAdapter needs login/finishRecoveryMfa/revoke");
  }
  if (!Buffer.isBuffer(csrfSecret) || csrfSecret.length < SECRET_BYTES) {
    throw new TypeError("csrfSecret must be 32+ random bytes");
  }

  let base;
  const server = createServer(async(request, response) => {
    const csrfPath = "/__ci/pg/session/csrf";
    const submitPath = "/__ci/pg/jobs/refresh";
    const loginPath = "/__ci/pg/auth/login";
    const mfaPath = "/__ci/pg/auth/mfa/recovery";
    const logoutPath = "/__ci/pg/auth/logout";
    const authPaths = new Set([loginPath,mfaPath,logoutPath]);
    try {
      // Do not trust X-Forwarded-Host / proxy headers, DNS rebinding, or
      // arbitrary origin: the only interface is loopback fixture HTTP.
      if (request.headers.host !== new URL(base).host ||
          request.socket.remoteAddress !== "127.0.0.1") {
        return answer(response, 403, {error:"loopback_host_denied"});
      }
      const origin = request.headers.origin;
      if ((origin && origin !== base) ||
          request.headers["sec-fetch-site"] === "cross-site") {
        return answer(response, 403, {error:"origin_denied"});
      }
      const path = new URL(request.url,base).pathname;
      if (path !== csrfPath && path !== submitPath &&
          !(loginAdapter && authPaths.has(path))) {
        return answer(response,404,{error:"not_found"});
      }
      if ((path === csrfPath && request.method !== "GET") ||
          (path !== csrfPath && request.method !== "POST")) {
        return answer(response,405,{error:"method_not_allowed"});
      }
      if (path !== csrfPath && origin !== base) {
        return answer(response,403,{error:"origin_required"});
      }

      // Explicitly opt-in fixture-only PostgreSQL credential and session
      // lifecycle: never imports SQLite or the real application's HTTP auth.
      if (path === loginPath) {
        const {email,password} = await limitedJson(request,"login");
        const result = await loginAdapter.login({email,password});
        if (!result.accepted) {
          return answer(response,result.rateLimited?429:401,
            {error:result.rateLimited?"auth_rate_limited":"invalid_credentials"});
        }
        const maxAge = result.mfaRequired ? 300 : 3600;
        const setCookie = "orbicore_session=" + result.token +
          "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + maxAge;
        // The pending MFA token is bound to the new cookie and the isolated
        // process secret. The HTTP response never contains the session token.
        const csrfToken = result.mfaRequired
          ? createHmac("sha256",csrfSecret)
              .update(createHash("sha256").update(result.token).digest("hex") +
                ":pending-recovery-v1").digest("hex")
          : undefined;
        return answer(response,result.mfaRequired?202:200,{
          authenticated:!result.mfaRequired,
          mfaRequired:result.mfaRequired,
          ...(csrfToken?{csrfToken}:{}),
          source:"postgres_ci_only",
        },{"set-cookie":setCookie});
      }

      const session = cookie(request.headers.cookie, "orbicore_session");
      if (!session || !SESSION.test(session)) {
        return answer(response,401,{error:"authentication_required"});
      }
      const tokenHash = createHash("sha256").update(session).digest("hex");

      if (path === mfaPath) {
        const expectedMfa = createHmac("sha256",csrfSecret)
          .update(tokenHash + ":pending-recovery-v1").digest("hex");
        if (!secureEqual(request.headers["x-orbicore-csrf"],expectedMfa)) {
          return answer(response,403,{error:"csrf_denied"});
        }
        const {code} = await limitedJson(request,"recovery");
        const result = await loginAdapter.finishRecoveryMfa({token:session,code});
        if (!result.accepted) {
          return answer(response,401,{error:"invalid_mfa_code"});
        }
        return answer(response,200,{
          authenticated:true,mfaRequired:false,source:"postgres_ci_only",
        },{
          "set-cookie":"orbicore_session=" + result.token +
            "; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600",
        });
      }

      // The probe is an EXECUTE-only PG function called via a non-owner login.
      // Never consults the normal SQLite HTTP authentication or caches roles.
      const tenant = await gateway.sessionTenant({tokenHash});
      if (!tenant) return answer(response,401,{error:"authentication_required"});
      const expected = createHmac("sha256",csrfSecret)
        .update(tokenHash + ":" + tenant + ":synthetic-post-v1")
        .digest("hex");
      if (path === csrfPath) {
        return answer(response,200,{csrfToken:expected,source:"postgres_ci_only"});
      }
      if (!secureEqual(request.headers["x-orbicore-csrf"],expected)) {
        return answer(response,403,{error:"csrf_denied"});
      }
      if (path === logoutPath) {
        await loginAdapter.revoke({token:session});
        return answer(response,200,{revoked:true},{
          "set-cookie":"orbicore_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        });
      }
      const parsed = await limitedJson(request);
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" ||
          idempotencyKey.length < 1 || idempotencyKey.length > 256) {
        return answer(response,400,{error:"idempotency_key_required"});
      }
      // Checks authorization *again* in the PG function inside the writer's
      // transaction; a revoked session between GET/POST or probe/write fails.
      const result = await gateway.enqueue({
        tokenHash,organizationId:tenant,
        accountId:parsed.accountId,idempotencyKey,
      });
      return answer(response,result.created ? 202 : 200,{
        jobId:result.jobId,status:result.created?"queued":"existing",
        storage:"postgres_ci_fixture_only",live:false,
      });
    } catch(error) {
      if (error instanceof RangeError && error.message === "request_too_large") {
        return answer(response,413,{error:"request_too_large"});
      }
      if (error instanceof TypeError && error.message.startsWith("invalid_")) {
        return answer(response,400,{error:"invalid_request"});
      }
      if (error?.code === "42501") {
        return answer(response,403,{error:"policy_denied"});
      }
      if (error?.code === "23505" ||
          error?.message === "idempotency_key_payload_conflict") {
        return answer(response,409,{error:"idempotency_conflict"});
      }
      // No SQL errors, credentials, session tokens, hostnames or internal DB
      // diagnostics are sent to the HTTP caller.
      return answer(response,503,{error:"postgres_fixture_unavailable"});
    }
  });

  return Object.freeze({
    async start() {
      if (base) throw new Error("synthetic_http_already_started");
      await new Promise((resolve,reject) => {
        server.once("error",reject);
        server.listen(0,"127.0.0.1",resolve);
      });
      base = "http://127.0.0.1:" + server.address().port;
      return base;
    },
    async close() {
      if (server.listening) await new Promise((resolve,reject) =>
        server.close((err)=>err?reject(err):resolve()));
    },
  });
}
