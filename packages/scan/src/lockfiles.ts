import { z } from "zod";
import { UnsupportedLockfileError } from "./errors";
import { isVersion } from "./semver";

export type Ecosystem = "npm";

/** One package at one version, as a lockfile installs it from a registry. */
export interface InstalledPackage {
	readonly ecosystem: Ecosystem;
	readonly name: string;
	readonly version: string;
}

export type LockfileFormat = "pnpm" | "npm";

export interface Lockfile {
	readonly format: LockfileFormat;
	/** The lockfile's own version, such as "9.0" for pnpm or "3" for npm. */
	readonly version: string;
	/**
	 * Every package installed from a registry, once per version, sorted. Packages from git, a
	 * tarball URL or a local path are left out: OSV knows packages by their registry versions.
	 */
	readonly packages: readonly InstalledPackage[];
}

const FORMATS: Readonly<Record<string, LockfileFormat>> = {
	"pnpm-lock.yaml": "pnpm",
	"package-lock.json": "npm",
	"npm-shrinkwrap.json": "npm",
};

/** The lockfile format a path names, or null when it is not a lockfile Guard reads. */
export function lockfileFormat(path: string): LockfileFormat | null {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return Object.hasOwn(FORMATS, name) ? (FORMATS[name] ?? null) : null;
}

export function parseLockfile(path: string, text: string): Lockfile {
	const format = lockfileFormat(path);
	if (format === "pnpm") return parsePnpmLock(text);
	if (format === "npm") return parseNpmLock(text);
	throw new UnsupportedLockfileError(`${path} is not a lockfile Guard reads.`);
}

class PackageSet {
	readonly #packages = new Map<string, InstalledPackage>();

	add(name: string, version: string): void {
		if (name === "" || !isVersion(version)) return;
		this.#packages.set(`${name}@${version}`, { ecosystem: "npm", name, version });
	}

	sorted(): InstalledPackage[] {
		return [...this.#packages.values()].sort(
			(a, b) =>
				(a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.version < b.version ? -1 : 1),
		);
	}
}

/** "name@version" or "@scope/name@version"; the version may be a URL with an "@" of its own. */
function splitNameAndVersion(key: string): [string, string] | null {
	const at = key.indexOf("@", 1);
	return at === -1 ? null : [key.slice(0, at), key.slice(at + 1)];
}

/**
 * The key of a two-space-indented YAML mapping entry, unquoted. pnpm writes its lockfile with a
 * fixed layout, so reading the keys of the top-level `packages:` mapping line by line is enough
 * and stays fast on lockfiles of several megabytes, where a full YAML parser would not.
 */
function entryKey(line: string): string | null {
	if (!line.startsWith("  ") || line[2] === " " || line[2] === undefined) return null;
	const rest = line.slice(2);
	const quote = rest[0];
	if (quote === "'") {
		// Single-quoted YAML: '' stands for one quote.
		let key = "";
		for (let index = 1; index < rest.length; index++) {
			const char = rest[index];
			if (char === "'") {
				if (rest[index + 1] === "'") {
					key += "'";
					index++;
					continue;
				}
				return rest[index + 1] === ":" ? key : null;
			}
			key += char;
		}
		return null;
	}
	if (quote === '"') {
		const end = rest.indexOf('"', 1);
		return end > 0 && rest[end + 1] === ":" ? rest.slice(1, end) : null;
	}
	const colon = /:(?:\s|$)/.exec(rest);
	return colon ? rest.slice(0, colon.index) : null;
}

export function parsePnpmLock(text: string): Lockfile {
	const lines = text.split(/\r?\n/);
	const versionLine = lines.find((line) => line.startsWith("lockfileVersion:"));
	const version = versionLine
		?.slice("lockfileVersion:".length)
		.trim()
		.replace(/^(['"])(.*)\1$/, "$2");
	if (!version) throw new UnsupportedLockfileError("This pnpm-lock.yaml has no lockfileVersion.");
	const major = Number.parseInt(version, 10);
	if (major !== 6 && major !== 9) {
		throw new UnsupportedLockfileError(
			`pnpm lockfile version ${version} is not supported; Guard reads versions 6 and 9 (pnpm 8 and later).`,
		);
	}

	const packages = new PackageSet();
	let inPackages = false;
	for (const line of lines) {
		if (line === "") continue;
		if (line[0] !== " ") {
			// A top-level key. `packages: {}` has no entries, so it does not open the section.
			inPackages = /^packages:\s*$/.test(line);
			continue;
		}
		if (!inPackages) continue;
		let key = entryKey(line);
		if (key === null) continue;
		if (major === 6) {
			// Version 6 keys registry packages as "/name@version", with peers in parentheses;
			// anything else (github.com/…, file:…) did not come from the registry.
			if (!key.startsWith("/")) continue;
			key = key.slice(1);
		}
		const peers = key.indexOf("(");
		if (peers !== -1) key = key.slice(0, peers);
		const parts = splitNameAndVersion(key);
		if (parts) packages.add(...parts);
	}
	return { format: "pnpm", version, packages: packages.sorted() };
}

const npmLock = z.object({
	lockfileVersion: z.number().int(),
	packages: z
		.record(
			z.string(),
			z.object({
				name: z.string().optional(),
				version: z.string().optional(),
				resolved: z.string().optional(),
				link: z.boolean().optional(),
			}),
		)
		.optional(),
});

/** Where a package came from when it was not a registry: git, GitHub tarballs, local paths. */
const NOT_A_REGISTRY = /^(?:git[+:]|github:|file:|https:\/\/codeload\.github\.com\/)/;

const NODE_MODULES = "node_modules/";

export function parseNpmLock(text: string): Lockfile {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		throw new UnsupportedLockfileError("This npm lockfile is not valid JSON.");
	}
	const parsed = npmLock.safeParse(json);
	if (!parsed.success) {
		throw new UnsupportedLockfileError("This file does not look like an npm lockfile.");
	}
	const { lockfileVersion, packages: entries } = parsed.data;
	if (lockfileVersion < 2 || entries === undefined) {
		throw new UnsupportedLockfileError(
			`npm lockfile version ${lockfileVersion} is not supported; npm 7 and later write version 2 or 3.`,
		);
	}

	const packages = new PackageSet();
	for (const [path, entry] of Object.entries(entries)) {
		// "" is the project itself and "packages/web" a workspace member; only what sits under a
		// node_modules folder was installed. A link points at a workspace member.
		const at = path.lastIndexOf(NODE_MODULES);
		if (at === -1 || entry.link || entry.version === undefined) continue;
		if (entry.resolved !== undefined && NOT_A_REGISTRY.test(entry.resolved)) continue;
		// An alias ("my-react": "npm:react@18.3.1") keeps the real name in `name`.
		packages.add(entry.name ?? path.slice(at + NODE_MODULES.length), entry.version);
	}
	return { format: "npm", version: String(lockfileVersion), packages: packages.sorted() };
}
