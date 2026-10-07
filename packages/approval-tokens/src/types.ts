/** ADR-0007's own payload shape, verbatim. */
export interface ApprovalTokenPayload {
  caseId: string;
  actionId: string;
  tenantId: string;
  approverId: string;
  nonce: string;
  /** Unix seconds. */
  exp: number;
}

export type ApprovalTokenVerifyError =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'reused';

/**
 * `expired` and `reused` carry the decoded payload; `malformed` and
 * `bad_signature` never do. The split is not stylistic: by the time a
 * token can fail as expired or reused, its signature has ALREADY been
 * verified, so the payload is authentic and safe for a caller (e.g. the
 * audit entry ADR-0007 requires for every rejection) to read. A
 * malformed token or a bad signature means nothing about the payload
 * was ever trustworthy, so none of it is exposed — not even a
 * caller-inaccessible decode.
 */
export type ApprovalTokenVerifyResult =
  | { ok: true; payload: ApprovalTokenPayload }
  | { ok: false; error: 'malformed' | 'bad_signature' }
  | { ok: false; error: 'expired' | 'reused'; payload: ApprovalTokenPayload };

/**
 * The storage seam for single-use enforcement (ADR-0007: "burned in
 * Redis on first use and persisted in Postgres... Redis unavailable
 * falls back to the Postgres uniqueness constraint"). `burn` returns
 * true the FIRST time a given nonce is presented, false on every
 * subsequent presentation — the only two outcomes that matter to a
 * caller; this package has no idea whether a `false` came from Redis
 * or Postgres, by design (see apps/api's own
 * RedisPostgresNonceStore for the real dual-backend implementation —
 * kept there, not here, because it needs both a Redis client and a
 * Postgres pool, and this package stays infra-agnostic the same way
 * @sentinel/notifications' dispatcher does).
 */
export interface NonceStore {
  burn(payload: ApprovalTokenPayload): Promise<boolean>;
}
