import { z } from "zod";
import { UpstreamError } from "./errors";
import { apiBase, type FetchOptions, readJson, send } from "./http";
import type { InstalledPackage } from "./lockfiles";
import { compareVersions, parseVersion, type Version } from "./semver";

// OSV (https://osv.dev) is Google's open vulnerability database. It needs no key, and it merges
// GitHub's advisories with the OpenSSF list of malicious packages. Guard sends it package names
// and versions only, never a repository's name or files.

const OSV_API = "https://api.osv.dev/v1";
/** OSV's documented ceiling on queries in one querybatch request. */
const QUERIES_PER_BATCH = 1000;
/** A package with more pages of advisories than this is not a real package. */
const MAX_PAGES = 10;
/** Advisories fetched at once. Workers allow six open connections per request. */
const ADVISORY_CONCURRENCY = 4;

export type Severity = "critical" | "high" | "moderate" | "low" | "unknown";

const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "moderate", "low", "unknown"];

export function compareSeverity(a: Severity, b: Severity): number {
	return SEVERITY_ORDER.indexOf(a) - SEVERITY_ORDER.indexOf(b);
}

export interface AdvisoryRef {
	readonly id: string;
	/** When OSV last changed the advisory; a cache of advisories can key on it. */
	readonly modified: string;
}

export type RangeEvent =
	| { readonly introduced: string }
	| { readonly fixed: string }
	| { readonly last_affected: string }
	| { readonly limit: string };

export interface AffectedRange {
	readonly type: string;
	readonly events: readonly RangeEvent[];
}

export interface AffectedPackage {
	readonly ecosystem: string;
	readonly name: string;
	readonly ranges: readonly AffectedRange[];
	readonly versions: readonly string[];
}

export interface Advisory {
	readonly id: string;
	/** Other names for the same problem, such as its CVE and GHSA ids. */
	readonly aliases: readonly string[];
	readonly summary: string;
	readonly severity: Severity;
	/** The CVSS vector, when the advisory has one, for people who want the detail. */
	readonly cvss: string | null;
	readonly published: string | null;
	readonly modified: string;
	/** Set when the advisory was taken back; a withdrawn advisory is not a finding. */
	readonly withdrawn: string | null;
	readonly url: string;
	readonly affected: readonly AffectedPackage[];
}

const batchResponse = z.object({
	results: z.array(
		z.object({
			vulns: z.array(z.object({ id: z.string(), modified: z.string() })).optional(),
			next_page_token: z.string().optional(),
		}),
	),
});

const event = z.union([
	z.object({ introduced: z.string() }),
	z.object({ fixed: z.string() }),
	z.object({ last_affected: z.string() }),
	z.object({ limit: z.string() }),
]);

const databaseSpecific = z.object({ severity: z.string().optional() }).optional().catch(undefined);

const vulnerability = z.object({
	id: z.string(),
	summary: z.string().optional(),
	details: z.string().optional(),
	aliases: z.array(z.string()).optional(),
	modified: z.string(),
	published: z.string().optional(),
	withdrawn: z.string().optional(),
	severity: z.array(z.object({ type: z.string(), score: z.string() })).optional(),
	affected: z
		.array(
			z.object({
				package: z.object({ ecosystem: z.string(), name: z.string() }).optional(),
				ranges: z
					.array(z.object({ type: z.string(), events: z.array(event.or(z.object({}))) }))
					.optional(),
				versions: z.array(z.string()).optional(),
				database_specific: databaseSpecific,
			}),
		)
		.optional(),
	database_specific: databaseSpecific,
});

function packageKey(item: InstalledPackage): string {
	return `${item.ecosystem}\u0000${item.name}\u0000${item.version}`;
}

/**
 * The advisories that affect each package, in the order the packages were given. Packages that
 * appear twice are asked about once.
 */
export async function queryAdvisories(
	packages: readonly InstalledPackage[],
	options: FetchOptions = {},
): Promise<AdvisoryRef[][]> {
	const unique = new Map<string, InstalledPackage>();
	for (const item of packages) unique.set(packageKey(item), item);
	const list = [...unique.values()];
	const found = new Map<string, AdvisoryRef[]>();

	for (let start = 0; start < list.length; start += QUERIES_PER_BATCH) {
		let pending = list.slice(start, start + QUERIES_PER_BATCH).map((item) => ({
			item,
			pageToken: undefined as string | undefined,
		}));
		for (let page = 0; pending.length > 0; page++) {
			if (page === MAX_PAGES) {
				throw new UpstreamError("osv", "invalid_response", "osv kept sending more pages");
			}
			const response = await send(
				"osv",
				`${apiBase(options, "osv", OSV_API)}/querybatch`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						queries: pending.map(({ item, pageToken }) => ({
							package: { ecosystem: item.ecosystem, name: item.name },
							version: item.version,
							...(pageToken === undefined ? {} : { page_token: pageToken }),
						})),
					}),
				},
				options,
			);
			const { results } = await readJson("osv", response, batchResponse);
			if (results.length !== pending.length) {
				throw new UpstreamError(
					"osv",
					"invalid_response",
					"osv answered a different number of queries",
				);
			}
			const next: typeof pending = [];
			results.forEach((result, index) => {
				const query = pending[index];
				if (query === undefined) return;
				const key = packageKey(query.item);
				const refs = found.get(key) ?? [];
				refs.push(...(result.vulns ?? []));
				found.set(key, refs);
				if (result.next_page_token)
					next.push({ item: query.item, pageToken: result.next_page_token });
			});
			pending = next;
		}
	}
	return packages.map((item) => found.get(packageKey(item)) ?? []);
}

/** The advisory's severity in GitHub's four levels, which OSV keeps from GitHub's database. */
function severityOf(id: string, data: z.infer<typeof vulnerability>): Severity {
	// The OpenSSF list of malicious packages: anything installed from one is compromised.
	if (id.startsWith("MAL-")) return "critical";
	const labels = [
		data.database_specific?.severity,
		...(data.affected ?? []).map((affected) => affected.database_specific?.severity),
	];
	for (const label of labels) {
		switch (label?.toUpperCase()) {
			case "CRITICAL":
				return "critical";
			case "HIGH":
				return "high";
			case "MODERATE":
			case "MEDIUM":
				return "moderate";
			case "LOW":
				return "low";
		}
	}
	return "unknown";
}

function toAdvisory(data: z.infer<typeof vulnerability>): Advisory {
	const firstLine = data.details?.trim().split("\n", 1)[0]?.trim();
	return {
		id: data.id,
		aliases: data.aliases ?? [],
		summary: data.summary?.trim() || firstLine || data.id,
		severity: severityOf(data.id, data),
		cvss: data.severity?.find((entry) => entry.type.startsWith("CVSS"))?.score ?? null,
		published: data.published ?? null,
		modified: data.modified,
		withdrawn: data.withdrawn ?? null,
		url: `https://osv.dev/vulnerability/${encodeURIComponent(data.id)}`,
		affected: (data.affected ?? []).flatMap((affected) =>
			affected.package
				? [
						{
							ecosystem: affected.package.ecosystem,
							name: affected.package.name,
							ranges: (affected.ranges ?? []).map((range) => ({
								type: range.type,
								// Events OSV adds later in a shape this code does not know are left out.
								events: range.events.filter(
									(item): item is RangeEvent => Object.keys(item).length > 0,
								),
							})),
							versions: affected.versions ?? [],
						},
					]
				: [],
		),
	};
}

const ADVISORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export async function getAdvisory(id: string, options: FetchOptions = {}): Promise<Advisory> {
	if (!ADVISORY_ID.test(id))
		throw new UpstreamError("osv", "invalid_response", "osv sent an invalid id");
	const response = await send(
		"osv",
		`${apiBase(options, "osv", OSV_API)}/vulns/${encodeURIComponent(id)}`,
		{ headers: { Accept: "application/json" } },
		options,
	);
	const data = await readJson("osv", response, vulnerability);
	if (data.id !== id)
		throw new UpstreamError("osv", "invalid_response", "osv sent another advisory");
	return toAdvisory(data);
}

function eventVersion(item: RangeEvent): string {
	if ("introduced" in item) return item.introduced;
	if ("fixed" in item) return item.fixed;
	if ("last_affected" in item) return item.last_affected;
	return item.limit;
}

/** "0" in an `introduced` event means every version since the first. */
const ZERO: Version = { major: 0, minor: 0, patch: 0, prerelease: [] };

function parseEventVersion(item: RangeEvent): Version | null {
	const text = eventVersion(item);
	return text === "0" && "introduced" in item ? ZERO : parseVersion(text);
}

/**
 * The first version that fixes the advisory for this package at this version, or null when no
 * fixed version is known or the version is not affected. It follows OSV's range evaluation over
 * the package's SEMVER and ECOSYSTEM ranges (the same for npm).
 */
export function fixedVersion(advisory: Advisory, item: InstalledPackage): string | null {
	const installed = parseVersion(item.version);
	if (installed === null) return null;
	let best: { text: string; version: Version } | null = null;
	for (const affected of advisory.affected) {
		if (affected.ecosystem !== item.ecosystem || affected.name !== item.name) continue;
		for (const range of affected.ranges) {
			if (range.type !== "SEMVER" && range.type !== "ECOSYSTEM") continue;
			const events = range.events.map((entry) => ({ entry, version: parseEventVersion(entry) }));
			if (events.some(({ version }) => version === null)) continue;
			const sorted = (events as { entry: RangeEvent; version: Version }[]).sort((a, b) =>
				compareVersions(a.version, b.version),
			);
			let affectedHere = false;
			for (const { entry, version } of sorted) {
				const order = compareVersions(installed, version);
				if ("introduced" in entry) {
					if (order < 0) break;
					affectedHere = true;
				} else if ("fixed" in entry) {
					if (order < 0) {
						if (affectedHere && (best === null || compareVersions(version, best.version) > 0)) {
							best = { text: entry.fixed, version };
						}
						break;
					}
					affectedHere = false;
				} else if ("last_affected" in entry) {
					// Affected up to and including this version; what fixes it is not recorded.
					if (order <= 0) break;
					affectedHere = false;
				}
			}
		}
	}
	return best?.text ?? null;
}

export interface VulnerablePackage {
	readonly ecosystem: InstalledPackage["ecosystem"];
	readonly name: string;
	readonly advisory: Advisory;
	/** Each installed version the advisory affects, with the version that fixes it if known. */
	readonly versions: readonly { readonly version: string; readonly fixed: string | null }[];
}

async function mapLimited<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await task(items[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/**
 * Looks up every package in OSV and returns one entry per package name and advisory, most
 * severe first. Withdrawn advisories are left out.
 */
export async function findVulnerablePackages(
	packages: readonly InstalledPackage[],
	options: FetchOptions = {},
): Promise<VulnerablePackage[]> {
	const refs = await queryAdvisories(packages, options);
	const ids = [...new Set(refs.flat().map((ref) => ref.id))].sort();
	const advisories = new Map(
		(await mapLimited(ids, ADVISORY_CONCURRENCY, (id) => getAdvisory(id, options))).map(
			(advisory) => [advisory.id, advisory],
		),
	);

	const grouped = new Map<
		string,
		{ item: InstalledPackage; advisory: Advisory; versions: Map<string, string | null> }
	>();
	packages.forEach((item, index) => {
		for (const ref of refs[index] ?? []) {
			const advisory = advisories.get(ref.id);
			if (advisory === undefined || advisory.withdrawn !== null) continue;
			const key = `${item.ecosystem}\u0000${item.name}\u0000${advisory.id}`;
			const group = grouped.get(key) ?? { item, advisory, versions: new Map() };
			group.versions.set(item.version, fixedVersion(advisory, item));
			grouped.set(key, group);
		}
	});

	return [...grouped.values()]
		.map(({ item, advisory, versions }) => ({
			ecosystem: item.ecosystem,
			name: item.name,
			advisory,
			versions: [...versions].map(([version, fixed]) => ({ version, fixed })),
		}))
		.sort(
			(a, b) =>
				compareSeverity(a.advisory.severity, b.advisory.severity) ||
				(a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
				(a.advisory.id < b.advisory.id ? -1 : 1),
		);
}
