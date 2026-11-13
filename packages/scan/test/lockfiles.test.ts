import { describe, expect, it } from "vitest";
import { UnsupportedLockfileError } from "../src/errors";
import { lockfileFormat, parseLockfile, parseNpmLock, parsePnpmLock } from "../src/lockfiles";

const PNPM_9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      react:
        specifier: ^18.3.1
        version: 18.3.1
      react-dom:
        specifier: ^18.3.1
        version: 18.3.1(react@18.3.1)

packages:

  '@babel/code-frame@7.24.7':
    resolution: {integrity: sha512-abc}
    engines: {node: '>=6.9.0'}

  js-tokens@4.0.0:
    resolution: {integrity: sha512-def}

  react-dom@18.3.1:
    resolution: {integrity: sha512-ghi}
    peerDependencies:
      react: ^18.3.1

  react@18.3.1:
    resolution: {integrity: sha512-jkl}

  tiny-fork@https://codeload.github.com/someone/tiny-fork/tar.gz/0123456789abcdef:
    resolution: {tarball: https://codeload.github.com/someone/tiny-fork/tar.gz/0123456789abcdef}
    version: 1.0.0

snapshots:

  '@babel/code-frame@7.24.7':
    dependencies:
      js-tokens: 4.0.0

  js-tokens@4.0.0: {}

  react-dom@18.3.1(react@18.3.1):
    dependencies:
      react: 18.3.1

  react@18.3.1: {}
`;

const PNPM_6 = `lockfileVersion: '6.0'

dependencies:
  react-dom:
    specifier: ^18.2.0
    version: 18.2.0(react@18.2.0)

packages:

  /loose-envify@1.4.0:
    resolution: {integrity: sha512-x}
    hasBin: true
    dependencies:
      js-tokens: 4.0.0
    dev: false

  /react-dom@18.2.0(react@18.2.0):
    resolution: {integrity: sha512-y}
    peerDependencies:
      react: ^18.2.0
    dev: false

  github.com/someone/thing/abcdef:
    resolution: {tarball: https://codeload.github.com/someone/thing/tar.gz/abcdef}
    name: thing
    version: 2.0.0
    dev: false
`;

const NPM_3 = JSON.stringify({
	name: "app",
	version: "1.0.0",
	lockfileVersion: 3,
	requires: true,
	packages: {
		"": { name: "app", workspaces: ["packages/*"], dependencies: { lodash: "^4.17.0" } },
		"node_modules/lodash": {
			version: "4.17.20",
			resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",
		},
		"node_modules/@scope/util": {
			version: "1.0.0",
			resolved: "https://registry.npmjs.org/@scope/util/-/util-1.0.0.tgz",
		},
		"node_modules/my-react": {
			name: "react",
			version: "18.3.1",
			resolved: "https://registry.npmjs.org/react/-/react-18.3.1.tgz",
		},
		"node_modules/web": { resolved: "packages/web", link: true },
		"packages/web": { name: "web", version: "0.1.0" },
		"packages/web/node_modules/lodash": {
			version: "4.17.21",
			resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
		},
		"node_modules/forked": {
			version: "1.0.0",
			resolved: "git+ssh://git@github.com/someone/forked.git#0123456789abcdef",
		},
	},
});

describe("pnpm lockfiles", () => {
	it("lists the registry packages of a version 9 lockfile once each", () => {
		const lockfile = parsePnpmLock(PNPM_9);
		expect(lockfile.version).toBe("9.0");
		expect(lockfile.packages).toEqual([
			{ ecosystem: "npm", name: "@babel/code-frame", version: "7.24.7" },
			{ ecosystem: "npm", name: "js-tokens", version: "4.0.0" },
			{ ecosystem: "npm", name: "react", version: "18.3.1" },
			{ ecosystem: "npm", name: "react-dom", version: "18.3.1" },
		]);
	});

	it("reads the same packages from a lockfile checked out with Windows line endings", () => {
		expect(parsePnpmLock(PNPM_9.replaceAll("\n", "\r\n")).packages).toEqual(
			parsePnpmLock(PNPM_9).packages,
		);
	});

	it("reads version 6 keys, dropping peer suffixes and packages from git", () => {
		expect(parsePnpmLock(PNPM_6).packages).toEqual([
			{ ecosystem: "npm", name: "loose-envify", version: "1.4.0" },
			{ ecosystem: "npm", name: "react-dom", version: "18.2.0" },
		]);
	});

	it("reads a lockfile with no packages", () => {
		expect(
			parsePnpmLock("lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\npackages: {}\n").packages,
		).toEqual([]);
	});

	it("says which lockfile versions it reads", () => {
		expect(() => parsePnpmLock("lockfileVersion: 5.4\n\npackages:\n\n  /react/18.2.0:\n")).toThrow(
			UnsupportedLockfileError,
		);
		expect(() => parsePnpmLock("packages:\n")).toThrow(UnsupportedLockfileError);
	});
});

describe("npm lockfiles", () => {
	it("lists installed packages with their real names, leaving out workspaces, links and git", () => {
		const lockfile = parseNpmLock(NPM_3);
		expect(lockfile.version).toBe("3");
		expect(lockfile.packages).toEqual([
			{ ecosystem: "npm", name: "@scope/util", version: "1.0.0" },
			{ ecosystem: "npm", name: "lodash", version: "4.17.20" },
			{ ecosystem: "npm", name: "lodash", version: "4.17.21" },
			{ ecosystem: "npm", name: "react", version: "18.3.1" },
		]);
	});

	it("turns down version 1 lockfiles and files that are not lockfiles", () => {
		expect(() => parseNpmLock(JSON.stringify({ lockfileVersion: 1, dependencies: {} }))).toThrow(
			/version 1 is not supported/,
		);
		expect(() => parseNpmLock("{")).toThrow(UnsupportedLockfileError);
		expect(() => parseNpmLock('{"name":"app"}')).toThrow(UnsupportedLockfileError);
	});
});

describe("lockfileFormat", () => {
	it("knows lockfiles by their file name, wherever they are", () => {
		expect(lockfileFormat("pnpm-lock.yaml")).toBe("pnpm");
		expect(lockfileFormat("apps/web/package-lock.json")).toBe("npm");
		expect(lockfileFormat("npm-shrinkwrap.json")).toBe("npm");
		expect(lockfileFormat("yarn.lock")).toBeNull();
		expect(lockfileFormat("docs/pnpm-lock.yaml.md")).toBeNull();
		expect(lockfileFormat("constructor")).toBeNull();
	});

	it("parses by path", () => {
		expect(parseLockfile("apps/web/package-lock.json", NPM_3).format).toBe("npm");
		expect(() => parseLockfile("yarn.lock", "")).toThrow(UnsupportedLockfileError);
	});
});
