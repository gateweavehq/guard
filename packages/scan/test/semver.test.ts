import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion, type Version } from "../src/semver";

function version(text: string): Version {
	const parsed = parseVersion(text);
	if (parsed === null) throw new Error(`${text} did not parse`);
	return parsed;
}

describe("parseVersion", () => {
	it("reads releases, pre-releases and build metadata", () => {
		expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
		expect(parseVersion("1.0.0-rc.1+build.5")).toEqual({
			major: 1,
			minor: 0,
			patch: 0,
			prerelease: ["rc", 1],
		});
	});

	it("turns down what a lockfile holds for packages that did not come from a registry", () => {
		for (const text of [
			"1.2",
			"v1.2.3",
			"01.2.3",
			"^1.2.3",
			"github:someone/thing",
			"https://codeload.github.com/someone/thing/tar.gz/abc",
			"file:../thing",
			"99999999999999999999.0.0",
		]) {
			expect(parseVersion(text), text).toBeNull();
		}
	});
});

describe("compareVersions", () => {
	it("orders versions the way semver does", () => {
		const ordered = [
			"0.9.9",
			"1.0.0-alpha",
			"1.0.0-alpha.1",
			"1.0.0-alpha.beta",
			"1.0.0-beta",
			"1.0.0-beta.2",
			"1.0.0-beta.11",
			"1.0.0-rc.1",
			"1.0.0",
			"1.9.0",
			"1.10.0",
			"2.0.0",
		];
		for (let index = 1; index < ordered.length; index++) {
			const before = ordered[index - 1] ?? "";
			const after = ordered[index] ?? "";
			expect(compareVersions(version(before), version(after)), `${before} < ${after}`).toBe(-1);
			expect(compareVersions(version(after), version(before)), `${after} > ${before}`).toBe(1);
		}
		expect(compareVersions(version("1.0.0+a"), version("1.0.0+b"))).toBe(0);
	});
});
