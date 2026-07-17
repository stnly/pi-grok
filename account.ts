/**
 * Account + privacy calls against the cli-chat-proxy.
 *
 * The proxy serves both the read side (GET /user, which carries the
 * coding-data-retention flag and account principal) and the write side
 * (PUT /privacy/coding-data-retention). Both accept the same OAuth access
 * token the provider already obtains: the `grok-cli:access` scope authorizes
 * them, so no separate auth path is needed.
 *
 * Network calls are isolated here so the pure parsing/formatting helpers
 * stay unit-testable without touching the network.
 */

import { XaiErrorCode, XaiOAuthError } from "./errors.js";
import { CLI_PROXY_BASE_URL, buildProxyHeaders } from "./models.js";

/** Request timeout for proxy calls. Account reads should feel instant. */
const PROXY_TIMEOUT_MS = 10_000;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Shape of GET /user from the cli-chat-proxy.
 *
 * Fields are nullable rather than optional: the proxy always returns every
 * key, with null for accounts that lack a team or organization. `isZdr` is
 * the only field the proxy omits for accounts where Zero Data
 * Retention does not apply, so it stays optional.
 */
export interface XaiUser {
	userId: string;
	email: string | null;
	firstName: string | null;
	lastName: string | null;
	profileImageAssetId: string | null;
	userBlockedReason: string | null;
	principalType: string | null;
	principalId: string | null;
	teamId: string | null;
	teamName: string | null;
	teamRole: string | null;
	teamBlockedReasons: string[] | null;
	organizationId: string | null;
	organizationName: string | null;
	organizationRole: string | null;
	codingDataRetentionOptOut: boolean;
	hasGrokCodeAccess: boolean;
	/** Present only when Zero Data Retention is enforced on the account. */
	isZdr?: boolean;
}

// ─── Proxy calls ──────────────────────────────────────────────────────────────

function proxyHeaders(token: string, json: boolean): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		...(json ? { "Content-Type": "application/json" } : {}),
		...buildProxyHeaders(),
	};
}

async function proxyError(prefix: string, res: Response): Promise<never> {
	const body = await res.text().catch(() => "");
	throw new XaiOAuthError(
		`${prefix}: HTTP ${res.status}${body ? ` ${body}` : ""}`,
		XaiErrorCode.PROXY_REQUEST_FAILED,
	);
}

/** Fetch the account enrichment payload (GET /user). */
export async function fetchUser(token: string): Promise<XaiUser> {
	let res: Response;
	try {
		res = await fetch(`${CLI_PROXY_BASE_URL}/user`, {
			headers: proxyHeaders(token, false),
			signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
		});
	} catch (cause) {
		throw new XaiOAuthError(
			`xAI account lookup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
			XaiErrorCode.PROXY_REQUEST_FAILED,
		);
	}
	if (res.status === 401) {
		throw new XaiOAuthError(
			"xAI authentication failed. Re-login required.",
			XaiErrorCode.PROXY_REQUEST_FAILED,
			true,
		);
	}
	if (!res.ok) return proxyError("xAI account lookup failed", res);
	return (await res.json()) as XaiUser;
}

/**
 * Set the coding-data-retention opt-out flag (PUT /privacy/coding-data-retention).
 *
 * `optOut = true` is privacy mode: your coding data is not used to train or improve xAI's models.
 * Returns the echoed state from the response so the caller renders the value
 * the server applied rather than the one it sent.
 */
export async function setCodingDataRetention(token: string, optOut: boolean): Promise<boolean> {
	let res: Response;
	try {
		res = await fetch(`${CLI_PROXY_BASE_URL}/privacy/coding-data-retention`, {
			method: "PUT",
			headers: proxyHeaders(token, true),
			body: JSON.stringify({ codingDataRetentionOptOut: optOut }),
			signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
		});
	} catch (cause) {
		throw new XaiOAuthError(
			`xAI privacy update failed: ${cause instanceof Error ? cause.message : String(cause)}`,
			XaiErrorCode.PROXY_REQUEST_FAILED,
		);
	}
	if (res.status === 401) {
		throw new XaiOAuthError(
			"xAI authentication failed. Re-login required.",
			XaiErrorCode.PROXY_REQUEST_FAILED,
			true,
		);
	}
	if (!res.ok) return proxyError("xAI privacy update failed", res);
	const body = (await res.json()) as { codingDataRetentionOptOut?: boolean };
	return body.codingDataRetentionOptOut ?? optOut;
}

// ─── Privacy argument parsing ────────────────────────────────────────────────

export type PrivacyArg =
	| { kind: "select" }
	| { kind: "set"; optOut: boolean }
	| { kind: "invalid"; arg: string };

/**
 * Map aliases to the boolean they set. Shared by parsing and by the command's
 * usage line, so the two can never drift apart.
 *
 * `true` opts out (privacy mode); `false` shares data.
 */
export const PRIVACY_ALIASES: Record<string, boolean> = {
	"opt-in": false,
	in: false,
	share: false,
	"opt-out": true,
	out: true,
	private: true,
};

/**
 * Parse a `/xai-privacy` argument into a normalized action.
 *
 * Empty input means "select": show an interactive picker (the default, so no
 * argument is ever required). A recognized alias means "set", for
 * callers that want to pin a mode without the picker. Anything else is
 * invalid; the caller surfaces the usage line. Lowercased and trimmed so
 * `Opt-Out`, `OUT`, and `opt-out` all resolve the same way.
 */
export function parsePrivacyArg(arg: string): PrivacyArg {
	const key = arg.trim().toLowerCase();
	if (key === "") return { kind: "select" };
	if (key in PRIVACY_ALIASES) return { kind: "set", optOut: PRIVACY_ALIASES[key] };
	return { kind: "invalid", arg };
}

// ─── Privacy selection ───────────────────────────────────────────────────────

/** One row in the interactive privacy picker. */
export interface PrivacyChoice {
	/** Stable label describing the mode (no current-state suffix). */
	label: string;
	/** The opt-out value this choice applies. */
	optOut: boolean;
	/** Whether this is the account's current state. */
	current: boolean;
}

/**
 * Build the two picker rows for a given current state.
 *
 * Pure and ordered (privacy mode first) so the rendered list and the label-to-
 * value mapping stay deterministic. The caller marks the current row when
 * rendering and maps a picked label back to its opt-out value.
 */
export function privacyChoices(currentOptOut: boolean): PrivacyChoice[] {
	return [
		{
			label: "Privacy mode (your coding data is not used to train or improve xAI's models)",
			optOut: true,
			current: currentOptOut === true,
		},
		{
			label: "Share data (your coding data may be used to train and improve xAI's models)",
			optOut: false,
			current: currentOptOut === false,
		},
	];
}

/** Human-readable list of accepted aliases, for usage/error messages. */
export function privacyUsage(): string {
	const ins = Object.entries(PRIVACY_ALIASES)
		.filter(([, v]) => v === false)
		.map(([k]) => k)
		.join(", ");
	const outs = Object.entries(PRIVACY_ALIASES)
		.filter(([, v]) => v === true)
		.map(([k]) => k)
		.join(", ");
	return `Valid: opt-in (${ins}) | opt-out (${outs})`;
}

// ─── Status formatting ───────────────────────────────────────────────────────

/** One-line privacy label for the current retention state. */
export function privacyLine(user: Pick<XaiUser, "codingDataRetentionOptOut" | "isZdr">): string {
	if (user.isZdr) return "Zero Data Retention enabled (locked by your organization)";
	return user.codingDataRetentionOptOut
		? "privacy mode (your coding data is not used to train or improve xAI's models)"
		: "share data (your coding data may be used to train and improve xAI's models)";
}

/**
 * Build the multi-line status block shown by `/xai-status`.
 *
 * Pure: takes the resolved pieces, returns a string. The command handler owns
 * the network calls and the model-registry lookup; this only formats.
 */
export function formatStatusBlock(parts: {
	user: XaiUser | null;
	modelCount: number;
	tokenSource: "oauth" | "env" | "none";
	discovery?: { state: "cold" | "in-flight" | "warm"; modelCount: number; lastError: string | null };
}): string {
	const { user, modelCount, tokenSource, discovery } = parts;
	const lines: string[] = [];

	if (tokenSource === "env") {
		lines.push("xAI: XAI_OAUTH_TOKEN env bypass (no auto-refresh)");
	} else if (tokenSource === "none") {
		lines.push("xAI: not logged in. Run /login, choose xAI (SuperGrok Subscription).");
		return lines.join("\n");
	}

	lines.push(`Models: ${modelCount} available`);

	if (user) {
		lines.push(`Account: ${formatAccountLabel(user)}`);
		if (user.teamName) lines.push(`Team: ${user.teamName}`);
		if (user.organizationName) lines.push(`Org: ${user.organizationName}`);
		lines.push(`Code access: ${user.hasGrokCodeAccess ? "yes" : "no"}`);
		lines.push(`Privacy: ${privacyLine(user)}`);
	}

	if (discovery) {
		const label = discovery.state === "warm"
			? `warm (${discovery.modelCount} catalog ids)`
			: discovery.state === "in-flight"
				? "fetching"
				: "cold (using built-in list)";
		lines.push(`Catalog: ${label}${discovery.lastError ? ` - last error: ${discovery.lastError}` : ""}`);
	}

	return lines.join("\n");
}

/** "name <email>" or whichever fields are present, for the Account line. */
function formatAccountLabel(user: XaiUser): string {
	const name = [user.firstName, user.lastName].filter((s): s is string => !!s).join(" ").trim();
	const email = user.email ?? "";
	if (name && email) return `${name} <${email}>`;
	return name || email || user.userId;
}
