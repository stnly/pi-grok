/**
 * Typed error for xAI OAuth failures.
 *
 * Codes allow the login flow and stream handlers to distinguish
 * retryable failures (network) from fatal ones (revoked refresh token).
 */
export class XaiOAuthError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly reloginRequired = false,
	) {
		super(message);
		this.name = "XaiOAuthError";
	}
}

/** Well-known error codes. */
export const XaiErrorCode = {
	/** OIDC discovery failed (network, invalid response). */
	DISCOVERY_FAILED: "discovery_failed",
	/** Discovery endpoint returned a non-xAI origin. */
	DISCOVERY_INVALID_ORIGIN: "discovery_invalid_origin",
	/** Authorization was denied or errored in the browser. */
	AUTHORIZATION_FAILED: "authorization_failed",
	/** CSRF state mismatch between request and callback. */
	STATE_MISMATCH: "state_mismatch",
	/** Callback did not include an authorization code. */
	CODE_MISSING: "code_missing",
	/** Token exchange failed (network, invalid response). */
	TOKEN_EXCHANGE_FAILED: "token_exchange_failed",
	/** Token exchange returned an invalid payload. */
	TOKEN_EXCHANGE_INVALID: "token_exchange_invalid",
	/** Returned id_token failed validation (bad JWT, nonce mismatch). */
	ID_TOKEN_INVALID: "id_token_invalid",
	/** id_token signature did not verify against the pinned JWKS. */
	ID_TOKEN_SIGNATURE_INVALID: "id_token_signature_invalid",
	/** Refresh token is missing or empty. */
	REFRESH_MISSING: "refresh_missing",
	/** Token refresh failed (expired, revoked). */
	REFRESH_FAILED: "refresh_failed",
	/** No credentials stored. */
	AUTH_MISSING: "auth_missing",
	/** A cli-chat-proxy call (account, privacy, billing) failed. */
	PROXY_REQUEST_FAILED: "proxy_request_failed",
	/** Device-code login failed (request rejected, denied, expired, network). */
	DEVICE_CODE_FAILED: "device_code_failed",
} as const;
