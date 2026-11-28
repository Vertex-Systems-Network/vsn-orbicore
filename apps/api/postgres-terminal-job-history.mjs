// OFFLINE CI ONLY: migrate immutable, fully terminal, synthetic inventory
// job history. Never copy active queues, arbitrary user/payload data or
// reusable provider credentials; this does not restore live worker ownership.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const validId = (value) => typeof value === "string" && ID.test(value);
const SAFE_RESULT_KEYS = new Set(["source", "live", "ciFixture", "accountId", "sites", "fetchedAt"]);
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

export function validateSyntheticTerminalJobs(jobs, source) {
  if (!Array.isArray(jobs) || !source || !Array.isArray(source.accounts) || !Array.isArray(source.users)) {
    throw new TypeError("complete_terminal_job_source_required");
  }
  const accountTenant = new Map(source.accounts.filter((row) => row?.source === "mock_fixture").map((row) => [row.id, row.organization_id]));
  const userTenant = new Map(source.users.map((row) => [row.id, row.organization_id]));
  const seenIds = new Set();
  const seenKeys = new Set();
  const resultByJob = [];
  for (const row of jobs) {
    const key = typeof row?.idempotency_key === "string" ? row.idempotency_key : "";
    // The real SQLite HTTP route prefixes caller idempotency keys with the
    // authenticated tenant. Accept only this exact tenant + fixture marker,
    // or the narrower explicitly seeded CI key; never arbitrary user tokens.
    const marker = key.startsWith(row?.organization_id + ":")
      ? key.slice((row.organization_id + ":").length) : key;
    const safeKey = /^ci-terminal-[A-Za-z0-9._:-]{1,100}$/.test(marker) &&
      (marker === key || key === row.organization_id + ":" + marker);
    if (!row || typeof row !== "object" ||
        !validId(row.id) || !validId(row.organization_id) || !validId(row.account_id) ||
        row.type !== "inventory_refresh" || !safeKey ||
        (row.status !== "completed" && row.status !== "failed")) {
      throw new Error("unsupported_nonterminal_or_nonfixture_job");
    }
    if (accountTenant.get(row.account_id) !== row.organization_id ||
        !validId(row.requested_by) || userTenant.get(row.requested_by) !== row.organization_id) {
      throw new Error("terminal_job_tenant_actor_mismatch");
    }
    if (seenIds.has(row.id) || seenKeys.has(key)) {
      throw new Error("duplicate_terminal_job_identity");
    }
    seenIds.add(row.id);
    seenKeys.add(key);
    if (!timestamp(row.created_at) || !timestamp(row.completed_at) ||
        (row.started_at !== null && !timestamp(row.started_at)) ||
        row.completed_at < row.created_at ||
        (row.started_at !== null && (row.started_at < row.created_at || row.started_at > row.completed_at))) {
      throw new Error("terminal_job_invalid_timestamps");
    }
    if (row.status === "failed") {
      if (row.result_json !== null || row.error !== "ci_fixture_failure") {
        throw new Error("terminal_job_failure_is_not_fixture_safe");
      }
      resultByJob.push(null);
      continue;
    }
    if (row.error !== null || typeof row.result_json !== "string" || row.result_json.length > 4096) {
      throw new Error("terminal_job_result_not_fixture_safe");
    }
    let parsed;
    try { parsed = JSON.parse(row.result_json); }
    catch { throw new Error("terminal_job_result_not_fixture_safe"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        Object.keys(parsed).some((key) => !SAFE_RESULT_KEYS.has(key)) ||
        parsed.source !== "mock_fixture" || parsed.live !== false ||
        (parsed.ciFixture !== undefined && parsed.ciFixture !== true) || parsed.accountId !== row.account_id ||
        (parsed.sites !== undefined && (!Number.isInteger(parsed.sites) || parsed.sites < 0)) ||
        (parsed.fetchedAt !== undefined && !timestamp(parsed.fetchedAt))) {
      throw new Error("terminal_job_result_not_fixture_safe");
    }
    resultByJob.push(parsed);
  }
  return resultByJob;
}

export async function insertSyntheticTerminalJobs({ client, source }) {
  if (!client || typeof client.query !== "function") throw new TypeError("pg_client_required");
  const parsed = validateSyntheticTerminalJobs(source?.jobs, source);
  for (let index = 0; index < source.jobs.length; index += 1) {
    const row = source.jobs[index];
    await client.query(
      "INSERT INTO jobs(id,organization_id,type,account_id,requested_by,status," +
        "idempotency_key,created_at,started_at,completed_at,result_json,error) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)",
      [row.id,row.organization_id,row.type,row.account_id,row.requested_by,
        row.status,row.idempotency_key,row.created_at,row.started_at,
        row.completed_at,parsed[index] === null ? null : JSON.stringify(parsed[index]),row.error],
    );
  }
}
