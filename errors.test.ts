import { describe, expect, it } from "vitest";
import { XaiErrorCode, XaiOAuthError, classifyHttpStatus } from "./errors.js";

describe("classifyHttpStatus", () => {
	it("classifies 401 as authentication rejected (fatal)", () => {
		const cls = classifyHttpStatus(401);
		expect(cls.code).toBe(XaiErrorCode.PROXY_REQUEST_FAILED);
		expect(cls.label).toBe("authentication rejected");
		expect(cls.fatal).toBe(true);
	});

	it("classifies 403 as authentication rejected (fatal)", () => {
		const cls = classifyHttpStatus(403);
		expect(cls.label).toBe("authentication rejected");
		expect(cls.fatal).toBe(true);
	});

	it("classifies 404 as endpoint unavailable (retryable)", () => {
		const cls = classifyHttpStatus(404);
		expect(cls.label).toBe("endpoint unavailable");
		expect(cls.fatal).toBe(false);
	});

	it("classifies 429 as rate limited (retryable)", () => {
		const cls = classifyHttpStatus(429);
		expect(cls.label).toBe("rate limited");
		expect(cls.fatal).toBe(false);
	});

	it.each([500, 502, 503, 599])("classifies %i as upstream error (retryable)", (status) => {
		const cls = classifyHttpStatus(status);
		expect(cls.label).toBe("upstream error");
		expect(cls.fatal).toBe(false);
	});

	it.each([400, 405, 409, 422])("falls back to HTTP N for unhandled 4xx (%i)", (status) => {
		const cls = classifyHttpStatus(status);
		expect(cls.label).toBe(`HTTP ${status}`);
		expect(cls.fatal).toBe(false);
	});

	it("falls back to HTTP N for statuses outside known bands", () => {
		expect(classifyHttpStatus(399).label).toBe("HTTP 399");
		expect(classifyHttpStatus(600).label).toBe("HTTP 600");
	});

	it("always returns PROXY_REQUEST_FAILED as the code", () => {
		for (const status of [200, 301, 400, 401, 404, 429, 500, 599, 777]) {
			expect(classifyHttpStatus(status).code).toBe(XaiErrorCode.PROXY_REQUEST_FAILED);
		}
	});
});

describe("XaiOAuthError", () => {
	it("carries the code and defaults reloginRequired to false", () => {
		const err = new XaiOAuthError("boom", XaiErrorCode.DISCOVERY_FAILED);
		expect(err.message).toBe("boom");
		expect(err.code).toBe(XaiErrorCode.DISCOVERY_FAILED);
		expect(err.reloginRequired).toBe(false);
		expect(err.name).toBe("XaiOAuthError");
	});

	it("carries reloginRequired when set", () => {
		const err = new XaiOAuthError("revoked", XaiErrorCode.REFRESH_FAILED, true);
		expect(err.reloginRequired).toBe(true);
	});

	it("narrows code to the XaiErrorCode literal union", () => {
		// Compile-time check: this assignment must type-check. If the code
		// field were `string`, this would still compile, but the intent is
		// that code is one of the documented literals.
		const err = new XaiOAuthError("x", XaiErrorCode.AUTH_MISSING);
		const code: XaiErrorCode = err.code;
		expect(code).toBe(XaiErrorCode.AUTH_MISSING);
	});
});
