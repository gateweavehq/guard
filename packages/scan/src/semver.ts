// Versions as npm and pnpm write them in lockfiles, and as OSV writes them in npm ranges:
// MAJOR.MINOR.PATCH with an optional pre-release and build. A git commit, a tarball URL or a
// local path is not a version, and a package installed from one cannot be looked up in OSV.

export interface Version {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly prerelease: readonly (string | number)[];
}

const VERSION =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function safeInteger(text: string): number | null {
	const value = Number(text);
	return Number.isSafeInteger(value) ? value : null;
}

export function parseVersion(text: string): Version | null {
	const match = VERSION.exec(text);
	if (!match) return null;
	const [, majorText = "", minorText = "", patchText = "", pre] = match;
	const major = safeInteger(majorText);
	const minor = safeInteger(minorText);
	const patch = safeInteger(patchText);
	if (major === null || minor === null || patch === null) return null;
	const prerelease = pre
		? pre.split(".").map((part) => (/^\d+$/.test(part) ? (safeInteger(part) ?? part) : part))
		: [];
	return { major, minor, patch, prerelease };
}

export function isVersion(text: string): boolean {
	return parseVersion(text) !== null;
}

function compareIdentifiers(a: string | number, b: string | number): number {
	if (typeof a === "number" && typeof b === "number") return a - b;
	// Numeric identifiers sort before alphanumeric ones.
	if (typeof a === "number") return -1;
	if (typeof b === "number") return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Negative when `a` comes first, positive when `b` does, zero when they are the same release. */
export function compareVersions(a: Version, b: Version): number {
	const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
	if (core !== 0) return Math.sign(core);
	// A pre-release comes before its release: 1.0.0-rc.1 < 1.0.0.
	if (a.prerelease.length === 0 || b.prerelease.length === 0) {
		return Math.sign(b.prerelease.length - a.prerelease.length);
	}
	const length = Math.min(a.prerelease.length, b.prerelease.length);
	for (let index = 0; index < length; index++) {
		const order = compareIdentifiers(a.prerelease[index] ?? 0, b.prerelease[index] ?? 0);
		if (order !== 0) return Math.sign(order);
	}
	return Math.sign(a.prerelease.length - b.prerelease.length);
}
