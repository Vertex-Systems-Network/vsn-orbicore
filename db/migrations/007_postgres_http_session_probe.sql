-- ORB-005: a scoped, read-only session probe for a disposable PostgreSQL
-- authenticated HTTP/CSRF slice. Not a production API auth cutover.
-- Applies after migration 006. Function does not trust tenant GUCs, caller
-- actor fields or SQLite session state.
BEGIN;

CREATE OR REPLACE FUNCTION public.orbicore_probe_synthetic_session(
  p_token_hash TEXT
) RETURNS TABLE(organization_id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT s.organization_id
    FROM public.sessions AS s
    JOIN public.users AS u
      ON u.id = s.user_id
     AND u.organization_id = s.organization_id
    WHERE s.token_hash = p_token_hash
      AND s.expires_at > clock_timestamp()
      AND u.disabled = FALSE
      AND u.role IN ('owner', 'admin', 'operator')
      AND (u.mfa_enabled = FALSE OR s.mfa_verified = TRUE);
END
$body$;

REVOKE ALL ON FUNCTION public.orbicore_probe_synthetic_session(TEXT)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.orbicore_probe_synthetic_session(TEXT)
  TO orbicore_synthetic_submitter;
COMMIT;
