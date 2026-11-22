import { createHash, randomBytes, randomUUID } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function createLocalNotificationAdapter({ simulateTransientFailure = false } = {}) {
  const deliveries = [];
  let failNext = simulateTransientFailure;

  return {
    mode: "local_simulated_adapter",
    liveDelivery: false,
    deliveries,
    setFailNext(value) {
      failNext = Boolean(value);
    },
    async send({ idempotencyKey, recipient, event, payload }) {
      const existing = deliveries.find((item) => item.idempotencyKey === idempotencyKey && item.status === "simulated_delivered");
      if (existing) return { ...existing, deduplicated: true };
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error("Simulated transient notification transport failure."), { retryable: true });
      }
      const record = {
        id: randomUUID(),
        idempotencyKey,
        recipient,
        event,
        payloadSummary: payload?.summary ?? event,
        status: "simulated_delivered",
        liveDelivery: false,
        deliveredAt: new Date().toISOString(),
      };
      deliveries.push(record);
      return record;
    },
  };
}

export function issueRecoveryContactVerification(db, { userId, channel = "email", address, ttlMinutes = 30 }) {
  const cleanAddress = typeof address === "string" ? address.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanAddress) || cleanAddress.length > 254) {
    throw Object.assign(new Error("Valid recovery email address required."), { status: 400, code: "invalid_recovery_contact" });
  }
  const token = randomBytes(24).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
  const id = randomUUID();
  db.prepare(`INSERT INTO recovery_contacts (id, user_id, channel, address, verified_at, verification_token_hash, verification_expires_at, created_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(user_id, channel) DO UPDATE SET
      address = excluded.address,
      verified_at = NULL,
      verification_token_hash = excluded.verification_token_hash,
      verification_expires_at = excluded.verification_expires_at`).run(id, userId, channel, cleanAddress, sha256(token), expiresAt, now.toISOString());
  return { contactId: id, channel, address: cleanAddress, expiresAt, verificationToken: token };
}

export function verifyRecoveryContactToken(db, { userId, token, nowMs = Date.now() }) {
  if (typeof token !== "string" || token.length < 16 || token.length > 128) {
    return { verified: false, reason: "invalid_verification_token" };
  }
  const nowIso = new Date(nowMs).toISOString();
  const row = db.prepare(`SELECT id, channel, address, verification_expires_at
    FROM recovery_contacts WHERE user_id = ? AND verification_token_hash = ?`).get(userId, sha256(token));
  if (!row || !row.verification_expires_at || row.verification_expires_at <= nowIso) {
    return { verified: false, reason: "verification_token_expired" };
  }
  db.prepare("UPDATE recovery_contacts SET verified_at = ?, verification_token_hash = NULL, verification_expires_at = NULL WHERE id = ?")
    .run(nowIso, row.id);
  return { verified: true, contactId: row.id, channel: row.channel, address: row.address, verifiedAt: nowIso };
}

export async function dispatchRecoveryNotification(db, adapter, { userId, event, fallbackRecipient, idempotencyKey }) {
  const now = new Date().toISOString();
  const verified = db.prepare("SELECT address FROM recovery_contacts WHERE user_id = ? AND verified_at IS NOT NULL ORDER BY verified_at DESC LIMIT 1").get(userId);
  const outboxId = randomUUID();
  if (!verified) {
    db.prepare(`INSERT INTO notification_outbox (id, user_id, event, recipient, status, attempts, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'blocked_unverified_contact', 0, ?, ?, ?)`)
      .run(outboxId, userId, event, fallbackRecipient, idempotencyKey ?? null, now, now);
    return { status: "blocked_unverified_contact", outboxId, liveDelivery: false };
  }
  const existing = idempotencyKey
    ? db.prepare("SELECT id, status FROM notification_outbox WHERE idempotency_key = ?").get(idempotencyKey)
    : null;
  if (existing && existing.status === "simulated_local_delivery") {
    return { status: existing.status, outboxId: existing.id, deduplicated: true, liveDelivery: false };
  }
  try {
    await adapter.send({ idempotencyKey: idempotencyKey ?? outboxId, recipient: verified.address, event, payload: { summary: event } });
    db.prepare(`INSERT INTO notification_outbox (id, user_id, event, recipient, status, attempts, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'simulated_local_delivery', 1, ?, ?, ?)`)
      .run(outboxId, userId, event, verified.address, idempotencyKey ?? null, now, now);
    return { status: "simulated_local_delivery", outboxId, liveDelivery: false };
  } catch (error) {
    const safeError = error instanceof Error ? error.message.slice(0, 200) : "Delivery failed.";
    db.prepare(`INSERT INTO notification_outbox (id, user_id, event, recipient, status, attempts, last_error, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'retry_pending', 1, ?, ?, ?, ?)`)
      .run(outboxId, userId, event, verified.address, safeError, idempotencyKey ?? null, now, now);
    return { status: "retry_pending", outboxId, error: safeError, liveDelivery: false };
  }
}
