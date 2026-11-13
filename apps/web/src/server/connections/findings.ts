import {
	compareSeverity,
	compareVersions,
	dependencyFingerprint,
	type Insight,
	insightFingerprint,
	parseVersion,
	type RepositoryScan,
	type Severity,
} from "@gateweave/guard-scan";
import { insightTitle } from "./titles";

/** A problem a scan saw, before it is matched with what Guard already knows. */
export interface PresentFinding {
	fingerprint: string;
	source: "cloudflare" | "dependency";
	severity: Severity;
	kind: string;
	subject: string;
	title: string;
	url: string;
	fixedVersion: string | null;
}

const MAX_TITLE = 300;
const MAX_SUBJECT = 500;

const cut = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** One finding per fingerprint, the most severe when a scan names the same problem twice. */
function dedupe(findings: readonly PresentFinding[]): PresentFinding[] {
	const byFingerprint = new Map<string, PresentFinding>();
	for (const found of findings) {
		const known = byFingerprint.get(found.fingerprint);
		if (!known || compareSeverity(found.severity, known.severity) < 0) {
			byFingerprint.set(found.fingerprint, found);
		}
	}
	return [...byFingerprint.values()];
}

/**
 * An insight that is active and that nobody dismissed in Cloudflare's dashboard is a problem now.
 * One that is resolved or dismissed there is not, which closes its finding.
 */
export async function insightFindings(
	accountId: string,
	insights: readonly Insight[],
): Promise<PresentFinding[]> {
	const present = insights.filter((insight) => insight.status === "active" && !insight.dismissed);
	return dedupe(
		await Promise.all(
			present.map(
				async (insight): Promise<PresentFinding> => ({
					fingerprint: await insightFingerprint(accountId, insight),
					source: "cloudflare",
					severity: insight.severity,
					kind: insight.issueClass,
					subject: cut(insight.subject || accountId, MAX_SUBJECT),
					title: insightTitle(insight.issueClass),
					url: insight.resolveUrl,
					fixedVersion: null,
				}),
			),
		),
	);
}

/**
 * The highest of the versions that fix an advisory, or null when any version installed has no
 * known fix: upgrading to the highest one does not help the version that has none.
 */
export function highestFix(fixes: readonly (string | null)[]): string | null {
	let best: { text: string; version: NonNullable<ReturnType<typeof parseVersion>> } | null = null;
	for (const text of fixes) {
		if (text === null) return null;
		const version = parseVersion(text);
		if (version === null) return null;
		if (best === null || compareVersions(version, best.version) > 0) best = { text, version };
	}
	return best?.text ?? null;
}

export interface RepositoryFindings {
	findings: PresentFinding[];
	/**
	 * Lockfiles this scan could not judge: unreadable, or too large. Findings an earlier scan made
	 * in them stay as they are rather than close because nothing was seen.
	 */
	unjudged: string[];
	/** GitHub listed only part of the repository, so no finding can be called gone. */
	partial: boolean;
}

/** One finding per lockfile, package and advisory, as `dependencyFingerprint` names them. */
export async function dependencyFindings(scan: RepositoryScan): Promise<RepositoryFindings> {
	const found: PresentFinding[] = [];
	const unjudged = [...scan.tooLarge];
	for (const lockfile of scan.lockfiles) {
		if ("unreadable" in lockfile) {
			unjudged.push(lockfile.path);
			continue;
		}
		for (const item of lockfile.vulnerable) {
			const versions = item.versions.map(({ version }) => version).join(", ");
			found.push({
				fingerprint: await dependencyFingerprint(
					scan.repository.id,
					lockfile.path,
					item,
					item.advisory.id,
				),
				source: "dependency",
				severity: item.advisory.severity,
				kind: item.advisory.id,
				// The lockfile's path stays whole at the end: a scan that can't read the lockfile goes by
				// it to keep these findings open (`apply` in scan.ts).
				subject: `${cut(`${item.name}@${versions}`, MAX_SUBJECT)} in ${lockfile.path}`,
				title: cut(item.advisory.summary, MAX_TITLE),
				url: item.advisory.url,
				fixedVersion: highestFix(item.versions.map(({ fixed }) => fixed)),
			});
		}
	}
	return { findings: dedupe(found), unjudged, partial: scan.truncated };
}
