import { UnsupportedLockfileError } from "./errors";
import {
	branchHead,
	getRepository,
	type LockfileEntry,
	listLockfiles,
	type Repository,
	type RepositoryName,
	readBlob,
} from "./github";
import type { FetchOptions } from "./http";
import { type InstalledPackage, parseLockfile } from "./lockfiles";
import { findVulnerablePackages, type VulnerablePackage } from "./osv";

export type LockfileScan =
	| {
			readonly path: string;
			readonly format: LockfileEntry["format"];
			readonly packages: number;
			readonly vulnerable: readonly VulnerablePackage[];
	  }
	| {
			readonly path: string;
			readonly format: LockfileEntry["format"];
			readonly unreadable: string;
	  };

export interface RepositoryScan {
	readonly repository: Repository;
	/** The commit of the default branch that was read. */
	readonly commit: string;
	readonly lockfiles: readonly LockfileScan[];
	/** Lockfiles skipped for their size. */
	readonly tooLarge: readonly string[];
	/** GitHub listed only part of the repository's files. */
	readonly truncated: boolean;
}

/**
 * Reads every lockfile on a repository's default branch and checks its packages against OSV.
 * Packages shared by several lockfiles are looked up once. A lockfile Guard cannot read is
 * reported as such instead of failing the scan; a failure to reach GitHub or OSV throws.
 */
export async function scanRepository(
	name: RepositoryName,
	token: string,
	options: FetchOptions = {},
): Promise<RepositoryScan> {
	const repository = await getRepository(name, token, options);
	const commit = await branchHead(repository, repository.defaultBranch, token, options);
	const list = await listLockfiles(repository, commit, token, options);

	const parsed: {
		entry: LockfileEntry;
		packages?: readonly InstalledPackage[];
		unreadable?: string;
	}[] = [];
	for (const entry of list.lockfiles) {
		const text = await readBlob(repository, entry.sha, token, options);
		try {
			parsed.push({ entry, packages: parseLockfile(entry.path, text).packages });
		} catch (error) {
			if (!(error instanceof UnsupportedLockfileError)) throw error;
			parsed.push({ entry, unreadable: error.message });
		}
	}

	const all = parsed.flatMap(({ packages }) => packages ?? []);
	const vulnerable = all.length > 0 ? await findVulnerablePackages(all, options) : [];

	const lockfiles = parsed.map(({ entry, packages, unreadable }): LockfileScan => {
		if (packages === undefined) {
			return { path: entry.path, format: entry.format, unreadable: unreadable ?? "" };
		}
		const installed = new Set(packages.map((item) => `${item.name}@${item.version}`));
		return {
			path: entry.path,
			format: entry.format,
			packages: packages.length,
			vulnerable: vulnerable.flatMap((found) => {
				const versions = found.versions.filter(({ version }) =>
					installed.has(`${found.name}@${version}`),
				);
				return versions.length > 0 ? [{ ...found, versions }] : [];
			}),
		};
	});

	return {
		repository,
		commit,
		lockfiles,
		tooLarge: list.tooLarge.map((entry) => entry.path),
		truncated: list.truncated,
	};
}
