import { describe, expect, it } from "vitest";
import { redirectDestination } from "./oauth";

describe("where a grant goes", () => {
	it("calls a loopback address an app on this computer, whatever its port or path", () => {
		for (const uri of [
			"http://127.0.0.1:47199/callback",
			"http://localhost:3000/",
			"http://[::1]:8080/cb",
		]) {
			expect(redirectDestination(uri)).toBe("an app on this computer");
		}
	});

	it("names the host of anything else", () => {
		expect(redirectDestination("https://claude.ai/api/mcp/auth_callback")).toBe("claude.ai");
		expect(redirectDestination("https://app.example.com:8443/cb")).toBe("app.example.com:8443");
	});

	it("shows only the scheme of a custom one, and says 'the app' for nothing usable", () => {
		expect(redirectDestination("cursor://anysphere.cursor/oauth")).toBe("cursor:");
		expect(redirectDestination(undefined)).toBe("the app");
		expect(redirectDestination("not a url")).toBe("the app");
	});
});
