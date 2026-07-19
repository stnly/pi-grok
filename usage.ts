/**
 * Subscription usage lookup against the cli-chat-proxy.
 *
 * The proxy exposes an unofficial `/billing?format=credits` endpoint that
 * reports subscription credit usage. It is undocumented and may move, so
 * everything here is defensive: the response is size-bounded, parsed with
 * the bounded-JSON walker, and individual fields are extracted by name with
 * clamping and length caps. A malformed response surfaces as an error
 * rather than a partial or misleading snapshot.
 *
 * The lookup resolves the user id from `/user` first and forwards it as
 * `x-userid` on the billing request. Neither the user identity nor the raw
 * billing body is cached, logged, or persisted: the snapshot returned to
 * the caller carries only the derived numeric fields.
 *
 * Observed response shape:
 *   {
 *     subscriptionTier: string,
 *     onDemandEnabled: boolean,
 *     config: {
 *       creditUsagePercent: number,
 *       monthlyLimit: { val: cents },
 *       used: { val: cents },
 *       onDemandCap: { val: cents },
 *       onDemandUsed: { val: cents },
 *       prepaidBalance: { val: cents },
 *       isUnifiedBillingUser: boolean,
 *       currentPeriod: { type, start, end },
 *       billingPeriodStart: string,
 *       billingPeriodEnd: string,
 *       history: [{ period, billingCycle, includedUsed, onDemandUsed, totalUsed }],
 *     },
 *   }
 *
 * Every field is optional in practice; the formatter renders whichever
 * subset the response actually carried.
 */

import { XaiErrorCode, XaiOAuthError } from "./errors.js";
import { CLI_PROXY_BASE_URL, buildProxyHeaders } from "./models.js";
import { safeFetch, readBoundedJson } from "./safe-fetch.js";
import { fetchUser } from "./account.js";

/** Bounded response sizes and parse ceilings. */
const USAGE_TIMEOUT_MS = 15_000;
const USAGE_MAX_RESPONSE_BYTES = 64 * 1024;
const USAGE_MAX_HISTORY_PERIODS = 24;
const USAGE_MAX_LABEL_LENGTH = 80;
const USAGE_MAX_TIMESTAMP_LENGTH = 64;
const MAX_USER_ID_LENGTH = 256;
const MIN_BILLING_YEAR = 2000;
const MAX_BILLING_YEAR = 2200;
const MAX_CENTS = 1_000_000_000_000; // $10B ceiling; rejects garbage
const USER_ID_PATTERN = /^[\x21-\x7e]+$/;
const RFC3339_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

// ─── Types ────────────────────────────────────────────

/** One product's usage breakdown (e.g. GrokBuild). */
export interface XaiProductUsage {
	product: string;
	usagePercent: number;
}

export interface XaiUsagePeriod {
	type?: string;
	start?: string;
	end?: string;
}

export interface XaiUsageBillingCycle {
	year: number;
	month: number;
}

export interface XaiUsageHistoryPeriod {
	period?: XaiUsagePeriod;
	billingCycle?: XaiUsageBillingCycle;
	includedUsedCents?: number;
	onDemandUsedCents?: number;
	totalUsedCents?: number;
}

/** Derived snapshot returned to callers. Every field is optional because the
 * billing endpoint's shape varies; the formatter handles a sparse snapshot. */
export interface XaiUsageSnapshot {
	creditUsagePercent?: number;
	currentPeriod?: XaiUsagePeriod;
	usedCents?: number;
	monthlyLimitCents?: number;
	prepaidBalanceCents?: number;
	onDemandCapCents?: number;
	onDemandUsedCents?: number;
	isUnifiedBillingUser?: boolean;
	onDemandEnabled?: boolean;
	subscriptionTier?: string;
	productUsage?: XaiProductUsage[];
	history: XaiUsageHistoryPeriod[];
}

/** Lookup error. Network/transport failures stay retryable; auth failures
 * propagate with reloginRequired so the caller can prompt a re-login. */
export class XaiUsageError extends Error {
	constructor(
		message: string,
		public readonly code: "auth" | "http" | "transport" | "invalid",
		public readonly reloginRequired = false,
	) {
		super(message);
		this.name = "XaiUsageError";
	}
}

// ─── Response parsing ───────────────────────────────────────────────────────

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asLabel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > USAGE_MAX_LABEL_LENGTH) return undefined;
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
	return trimmed;
}

/** RFC 3339 timestamp validated against a real calendar date. Returns the
 * input string on success so the caller renders exactly what the server sent. */
function asTimestamp(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > USAGE_MAX_TIMESTAMP_LENGTH) return undefined;
	const match = value.match(RFC3339_PATTERN);
	if (!match) return undefined;
	const [, ys, mos, ds, hs, mis, ss, sign, ohs, omis] = match;
	const year = Number(ys);
	const month = Number(mos);
	const day = Number(ds);
	const hour = Number(hs);
	const minute = Number(mis);
	const second = Number(ss);
	const offsetHour = ohs === undefined ? 0 : Number(ohs);
	const offsetMinute = omis === undefined ? 0 : Number(omis);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (
		month < 1 || month > 12
		|| day < 1 || day > daysInMonth[month - 1]
		|| hour > 23 || minute > 59 || second > 59
		|| offsetHour > 23 || offsetMinute > 59
		|| (sign !== undefined && sign !== "+" && sign !== "-")
		|| !Number.isFinite(Date.parse(value))
	) return undefined;
	return value;
}

function asPercent(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(100, value));
}

/** Cents values in the billing body are wrapped in `{ val: number }`.
 * Accept only that wrapper with a present, finite integer `val`. A missing
 * or non-numeric `val` is rejected so an empty `{}` is not rendered as $0.00. */
function asCents(value: unknown): number | undefined {
	const wrapper = asObject(value);
	if (!wrapper) return undefined;
	const cents = wrapper.val;
	return typeof cents === "number"
		&& Number.isSafeInteger(cents)
		&& cents >= 0
		&& cents <= MAX_CENTS
		? cents
		: undefined;
}

function parsePeriod(value: unknown): XaiUsagePeriod | undefined {
	const obj = asObject(value);
	if (!obj) return undefined;
	const result: XaiUsagePeriod = {};
	const type = asLabel(obj.type);
	const start = asTimestamp(obj.start);
	const end = asTimestamp(obj.end);
	if (type) result.type = type;
	if (start) result.start = start;
	if (end) result.end = end;
	return Object.keys(result).length > 0 ? result : undefined;
}

function parseBillingCycle(value: unknown): XaiUsageBillingCycle | undefined {
	const obj = asObject(value);
	if (!obj) return undefined;
	const { year, month } = obj;
	return Number.isSafeInteger(year)
		&& Number.isSafeInteger(month)
		&& (year as number) >= MIN_BILLING_YEAR
		&& (year as number) <= MAX_BILLING_YEAR
		&& (month as number) >= 1
		&& (month as number) <= 12
		? { year: year as number, month: month as number }
		: undefined;
}

function parseHistoryPeriod(value: unknown): XaiUsageHistoryPeriod | undefined {
	const obj = asObject(value);
	if (!obj) return undefined;
	const result: XaiUsageHistoryPeriod = {};
	const period = parsePeriod(obj.period);
	const cycle = parseBillingCycle(obj.billingCycle);
	const included = asCents(obj.includedUsed);
	const onDemand = asCents(obj.onDemandUsed);
	const total = asCents(obj.totalUsed);
	if (period) result.period = period;
	if (cycle) result.billingCycle = cycle;
	if (included !== undefined) result.includedUsedCents = included;
	if (onDemand !== undefined) result.onDemandUsedCents = onDemand;
	if (total !== undefined) result.totalUsedCents = total;
	return Object.keys(result).length > 0 ? result : undefined;
}

/** Parse one entry of config.productUsage. The shape is
 * `{ product: string, usagePercent: number }`; the percent is clamped the
 * same way as the headline creditUsagePercent. */
function parseProductUsage(value: unknown): XaiProductUsage | undefined {
	const obj = asObject(value);
	if (!obj) return undefined;
	const product = asLabel(obj.product);
	const usagePercent = asPercent(obj.usagePercent);
	if (product === undefined || usagePercent === undefined) return undefined;
	return { product, usagePercent };
}

/** Validate the user id resolved from `/user` before forwarding it as
 * `x-userid` on the billing call. The id must be a printable-ASCII string
 * (no whitespace, no control characters) within a generous length cap so a
 * malformed or hostile `/user` response can't inject header characters. */
export function parseUserId(value: unknown): string {
	const obj = asObject(value);
	const userId = obj?.userId;
	if (
		typeof userId !== "string"
		|| !userId
		|| userId.length > MAX_USER_ID_LENGTH
		|| !USER_ID_PATTERN.test(userId)
	) {
		throw new XaiUsageError(
			"xAI account identity could not be verified; billing was not requested.",
			"invalid",
		);
	}
	return userId;
}

/**
 * Extract a snapshot from a parsed billing body.
 *
 * Top-level carries `subscriptionTier` and `onDemandEnabled`; the numeric
 * fields live under a nested `config` object, with cents wrapped in
 * `{ val: number }`. History entries are optional but, when present, must
 * be an array within the documented length cap.
 *
 * Throws XaiUsageError on any shape violation (root not an object, `config`
 * present but not an object, `history` present but not an array, history
 * exceeding the period cap) so the caller surfaces a real error instead of
 * rendering a misleading empty snapshot. A well-formed body with no
 * recognized fields still yields a sparse snapshot.
 */
export function parseUsageBody(body: unknown): XaiUsageSnapshot {
	const root = asObject(body);
	if (!root) {
		throw new XaiUsageError("xAI usage returned an invalid response.", "invalid");
	}
	if (root.config !== undefined && root.config !== null && !asObject(root.config)) {
		throw new XaiUsageError("xAI usage returned an invalid response.", "invalid");
	}

	const snapshot: XaiUsageSnapshot = { history: [] };
	const tier = asLabel(root.subscriptionTier);
	if (tier) snapshot.subscriptionTier = tier;
	if (typeof root.onDemandEnabled === "boolean") snapshot.onDemandEnabled = root.onDemandEnabled;

	const config = asObject(root.config);
	if (!config) return snapshot;

	const history = config.history;
	if (history !== undefined && !Array.isArray(history)) {
		throw new XaiUsageError("xAI usage returned invalid billing history.", "invalid");
	}
	if (Array.isArray(history) && history.length > USAGE_MAX_HISTORY_PERIODS) {
		throw new XaiUsageError("xAI usage returned too many billing periods.", "invalid");
	}

	const percent = asPercent(config.creditUsagePercent);
	const monthlyLimit = asCents(config.monthlyLimit);
	const used = asCents(config.used);
	const onDemandCap = asCents(config.onDemandCap);
	const onDemandUsed = asCents(config.onDemandUsed);
	const prepaid = asCents(config.prepaidBalance);
	const currentPeriod = parsePeriod(config.currentPeriod);
	if (percent !== undefined) snapshot.creditUsagePercent = percent;
	if (monthlyLimit !== undefined) snapshot.monthlyLimitCents = monthlyLimit;
	if (used !== undefined) snapshot.usedCents = used;
	if (onDemandCap !== undefined) snapshot.onDemandCapCents = onDemandCap;
	if (onDemandUsed !== undefined) snapshot.onDemandUsedCents = onDemandUsed;
	if (prepaid !== undefined) snapshot.prepaidBalanceCents = prepaid;
	if (currentPeriod) snapshot.currentPeriod = currentPeriod;
	if (typeof config.isUnifiedBillingUser === "boolean") snapshot.isUnifiedBillingUser = config.isUnifiedBillingUser;

	// Fall back to billingPeriodStart/End when the structured currentPeriod is
	// absent; some responses carry the flat fields instead of the nested object.
	if (!snapshot.currentPeriod) {
		const start = asTimestamp(config.billingPeriodStart);
		const end = asTimestamp(config.billingPeriodEnd);
		if (start || end) {
			snapshot.currentPeriod = {
				...(start ? { start } : {}),
				...(end ? { end } : {}),
			};
		}
	}

	if (Array.isArray(history)) {
		snapshot.history = (history as unknown[])
			.map(parseHistoryPeriod)
			.filter((entry): entry is XaiUsageHistoryPeriod => entry !== undefined);
	}

	if (Array.isArray(config.productUsage)) {
		const productUsage = (config.productUsage as unknown[])
			.map(parseProductUsage)
			.filter((entry): entry is XaiProductUsage => entry !== undefined);
		if (productUsage.length > 0) snapshot.productUsage = productUsage;
	}

	return snapshot;
}

// ─── Network ───────────────────────────────────────────────────────────────

function billingHeaders(token: string, userId: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"x-userid": userId,
		...buildProxyHeaders(),
	};
}

/**
 * Resolve the current subscription usage snapshot.
 *
 * Two pinned calls: `/user` to resolve the transient user id, then
 * `/billing?format=credits` with that id in `x-userid`. The user id is
 * validated for printable-ASCII shape before it lands in a header. The
 * billing body is size-bounded and parsed through the bounded-JSON walker,
 * so a malformed or pathological response can't exhaust memory or stack.
 * Either call failing throws `XaiUsageError`; the caller surfaces the message.
 */
export async function fetchUsage(token: string): Promise<XaiUsageSnapshot> {
	let userResponse: unknown;
	try {
		userResponse = await fetchUser(token);
	} catch (cause) {
		if (cause instanceof XaiOAuthError && cause.reloginRequired) {
			throw new XaiUsageError("xAI authentication failed. Re-login required.", "auth", true);
		}
		throw new XaiUsageError(
			`xAI usage lookup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
			"transport",
		);
	}
	// fetchUser returns a fully-typed XaiUser, but parseUserId re-validates
	// the userId field against a strict printable-ASCII pattern so a
	// malformed response can't inject header characters via x-userid.
	const userId = parseUserId(userResponse as Record<string, unknown>);

	let response: Response;
	try {
		response = await safeFetch(`${CLI_PROXY_BASE_URL}/billing?format=credits`, {
			headers: billingHeaders(token, userId),
			signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
		});
	} catch (cause) {
		throw new XaiUsageError(
			`xAI billing lookup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
			"transport",
		);
	}
	if (response.status === 401 || response.status === 403) {
		throw new XaiUsageError("xAI authentication failed. Re-login required.", "auth", true);
	}
	if (!response.ok) {
		throw new XaiUsageError(`xAI billing lookup returned HTTP ${response.status}.`, "http");
	}

	let parsed: unknown;
	try {
		parsed = await readBoundedJson(response, USAGE_MAX_RESPONSE_BYTES);
	} catch (cause) {
		throw new XaiUsageError(
			`xAI usage response was unreadable or unparseable: ${cause instanceof Error ? cause.message : String(cause)}`,
			"invalid",
		);
	}
	return parseUsageBody(parsed);
}

// ─── Formatting ────────────────────────────────────────────────────────────

function formatCents(cents: number): string {
	return `$${(cents / 100).toFixed(2)}`;
}

function formatPercent(value: number): string {
	return `${Number(value.toFixed(1))}%`;
}

/** Capitalize the first character of a label. */
function capitalize(s: string): string {
	return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** When the response omits creditUsagePercent, derive it from used / limit.
 * Returns undefined when neither source is available so the caller can
 * distinguish "genuinely zero" from "no data". */
function effectivePercent(snapshot: XaiUsageSnapshot): number | undefined {
	if (snapshot.creditUsagePercent !== undefined) return snapshot.creditUsagePercent;
	if (
		snapshot.usedCents !== undefined
		&& snapshot.monthlyLimitCents !== undefined
		&& snapshot.monthlyLimitCents > 0
	) {
		return Math.min(100, (snapshot.usedCents / snapshot.monthlyLimitCents) * 100);
	}
	return undefined;
}

/** Map the proxy's period-type enum to a friendly label.
 * `USAGE_PERIOD_TYPE_WEEKLY` -> "weekly", `USAGE_PERIOD_TYPE_MONTHLY` -> "monthly",
 * anything unknown passes through lowercased. */
function periodLabel(type: string | undefined): string | undefined {
	if (!type) return undefined;
	const match = /^USAGE_PERIOD_TYPE_(.+)$/.exec(type);
	const stem = match ? match[1] : type;
	return stem.toLowerCase();
}

/**
 * Render the validated snapshot fields for the explicit `/xai-usage` command.
 * The snapshot is sparse: only the fields the billing endpoint actually
 * returned are rendered, except the headline percent, which defaults to 0%
 * when no usage source was returned so the line never just disappears.
 * The caller owns the not-logged-in message for the missing-token case;
 * this function only runs after a successful parse.
 */
export function formatUsageBlock(snapshot: XaiUsageSnapshot): string {
	const lines = ["xAI usage (unofficial, revision-pinned):"];
	const percent = effectivePercent(snapshot);
	const period = periodLabel(snapshot.currentPeriod?.type);
	if (snapshot.subscriptionTier) lines.push(`Subscription: ${snapshot.subscriptionTier}`);
	// Headline usage percent. Always render so the line never disappears; when
	// no usage source was returned, show 0% (matches the grok.com "0% used"
	// surface for a fresh period with no traffic).
	const percentText = formatPercent(percent ?? 0);
	lines.push(period ? `${capitalize(period)} usage: ${percentText}` : `Included usage: ${percentText}`);
	if (snapshot.productUsage && snapshot.productUsage.length > 0) {
		for (const entry of snapshot.productUsage) {
			lines.push(`  ${entry.product}: ${formatPercent(entry.usagePercent)}`);
		}
	}
	if (snapshot.usedCents !== undefined || snapshot.monthlyLimitCents !== undefined) {
		const used = snapshot.usedCents !== undefined ? `${formatCents(snapshot.usedCents)} used` : "usage unavailable";
		const limit = snapshot.monthlyLimitCents !== undefined ? ` of ${formatCents(snapshot.monthlyLimitCents)}` : "";
		lines.push(`Included credits: ${used}${limit}`);
	}
	if (snapshot.currentPeriod?.start) lines.push(`Period start: ${snapshot.currentPeriod.start}`);
	if (snapshot.currentPeriod?.end) lines.push(`Reset: ${snapshot.currentPeriod.end}`);
	if (snapshot.onDemandUsedCents !== undefined || snapshot.onDemandCapCents !== undefined) {
		const used = snapshot.onDemandUsedCents !== undefined ? `${formatCents(snapshot.onDemandUsedCents)} used` : "usage unavailable";
		const cap = snapshot.onDemandCapCents !== undefined ? ` of ${formatCents(snapshot.onDemandCapCents)}` : "";
		lines.push(`On-demand credits: ${used}${cap}`);
	}
	if (snapshot.prepaidBalanceCents !== undefined) {
		lines.push(`Prepaid balance: ${formatCents(snapshot.prepaidBalanceCents)}`);
	}
	if (snapshot.onDemandEnabled !== undefined) {
		lines.push(`On-demand billing: ${snapshot.onDemandEnabled ? "enabled" : "disabled"}`);
	}
	if (snapshot.isUnifiedBillingUser !== undefined) {
		lines.push(`Usage pool: ${snapshot.isUnifiedBillingUser ? "unified" : "standard"}`);
	}
	if (snapshot.history.length > 0) lines.push(`Validated history periods: ${snapshot.history.length}`);
	return lines.join("\n");
}
