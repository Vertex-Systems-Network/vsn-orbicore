import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { redactSecrets } from "./security.mjs";

export function computeAuditEntryHash({
  prevHash,
  organizationId,
  actor,
  action,
  targetId,
  outcome,
  detailsJson,
  createdAt,
}) {
  const payload = JSON.stringify([
    prevHash ?? "GENESIS",
    organizationId,
    actor,
    action,
    targetId,
    outcome,
    detailsJson,
    createdAt,
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

function serializeAuditDetails(details, detailsJson) {
  if (typeof detailsJson === "string") {
    try {
      return JSON.stringify(redactSecrets(JSON.parse(detailsJson)));
    } catch {
      return detailsJson;
    }
  }
  return JSON.stringify(redactSecrets(details ?? {}));
}

export function appendAuditEvent(
  db,
  {
    id = randomUUID(),
    organizationId,
    actor,
    action,
    targetId,
    outcome,
    createdAt = new Date().toISOString(),
    details = {},
    detailsJson,
  },
) {
  const normalizedDetailsJson = serializeAuditDetails(details, detailsJson);
  const previous = db
    .prepare("SELECT entry_hash FROM audit_events WHERE organization_id = ? AND entry_hash IS NOT NULL ORDER BY rowid DESC LIMIT 1")
    .get(organizationId);
  const prevHash = previous?.entry_hash ?? "GENESIS";
  const entryHash = computeAuditEntryHash({
    prevHash,
    organizationId,
    actor,
    action,
    targetId,
    outcome,
    detailsJson: normalizedDetailsJson,
    createdAt,
  });
  db.prepare(
    `INSERT INTO audit_events (id, organization_id, actor, action, target_id, outcome, created_at, details_json, prev_hash, entry_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, organizationId, actor, action, targetId, outcome, createdAt, normalizedDetailsJson, prevHash, entryHash);
  return { id, prevHash, entryHash, createdAt };
}

function hashesEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function verifyAuditChain(db, organizationId) {
  const rows = db
    .prepare(
      `SELECT id, organization_id, actor, action, target_id, outcome, created_at, details_json, prev_hash, entry_hash
       FROM audit_events WHERE organization_id = ? ORDER BY rowid ASC`,
    )
    .all(organizationId);

  let legacyUnchainedCount = 0;
  let checkedCount = 0;
  let expectedPrev = "GENESIS";
  let sawChained = false;

  for (const row of rows) {
    if (row.entry_hash == null && row.prev_hash == null) {
      if (sawChained) {
        return {
          valid: false,
          checkedCount,
          legacyUnchainedCount,
          headHash: expectedPrev,
          brokenAtId: row.id,
          reason: "unchained_row_after_chain",
        };
      }
      legacyUnchainedCount += 1;
      continue;
    }

    sawChained = true;
    checkedCount += 1;

    if (!hashesEqual(row.prev_hash ?? "", expectedPrev)) {
      return {
        valid: false,
        checkedCount,
        legacyUnchainedCount,
        headHash: expectedPrev,
        brokenAtId: row.id,
        reason: "prev_hash_mismatch",
      };
    }

    const expectedHash = computeAuditEntryHash({
      prevHash: expectedPrev,
      organizationId: row.organization_id,
      actor: row.actor,
      action: row.action,
      targetId: row.target_id,
      outcome: row.outcome,
      detailsJson: row.details_json,
      createdAt: row.created_at,
    });

    if (!hashesEqual(row.entry_hash ?? "", expectedHash)) {
      return {
        valid: false,
        checkedCount,
        legacyUnchainedCount,
        headHash: expectedPrev,
        brokenAtId: row.id,
        reason: "entry_hash_mismatch",
      };
    }

    expectedPrev = row.entry_hash;
  }

  return {
    valid: true,
    checkedCount,
    legacyUnchainedCount,
    headHash: expectedPrev,
    brokenAtId: null,
    reason: null,
    checkedAt: new Date().toISOString(),
  };
}
