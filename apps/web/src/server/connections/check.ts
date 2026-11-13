import {
	branchHead,
	type FetchOptions,
	getRepository,
	listInsights,
	type RepositoryName,
	UpstreamError,
} from "@gateweave/guard-scan";

/**
 * Asking Cloudflare or GitHub whether a token works, before anything is kept. Each failure becomes
 * a sentence that says what to fix. Guard can't read a Cloudflare token's own permissions, so the
 * only proof is a call that needs the one it asks for, and a refusal then means that one is missing
 * (or the token is for another account).
 */

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const PASSES_WITH_TIME = (error: UpstreamError) =>
	error.failure === "rate_limited" || error.failure === "unavailable";

function trouble(service: "Cloudflare" | "GitHub", error: UpstreamError): string | null {
	if (PASSES_WITH_TIME(error)) {
		return `${service} could not be reached just now, or is limiting requests. Try again in a minute.`;
	}
	if (error.failure === "invalid_response") {
		return `${service} answered in a way Guard doesn't understand, so the token could not be checked.`;
	}
	return null;
}

export async function checkCloudflare(
	accountId: string,
	token: string,
	options: FetchOptions,
): Promise<Checked<null>> {
	try {
		await listInsights({ accountId, token }, options);
		return { ok: true, value: null };
	} catch (error) {
		if (!(error instanceof UpstreamError)) throw error;
		return {
			ok: false,
			error:
				trouble("Cloudflare", error) ??
				"Cloudflare did not accept this token for that account. It needs the permission Account › Security Center Insights › Read on the account with that id, and Zone › Security Center Insights › Read on its zones.",
		};
	}
}

export interface CheckedRepository {
	/** `owner/name` as GitHub writes it. */
	target: string;
	repositoryId: number;
}

export async function checkGithub(
	name: RepositoryName,
	token: string,
	options: FetchOptions,
): Promise<Checked<CheckedRepository>> {
	let repository: Awaited<ReturnType<typeof getRepository>>;
	try {
		repository = await getRepository(name, token, options);
	} catch (error) {
		if (!(error instanceof UpstreamError)) throw error;
		return {
			ok: false,
			error:
				trouble("GitHub", error) ??
				"GitHub did not let this token see that repository. Check the name, and that the token was made for this one repository.",
		};
	}
	try {
		// Reading a branch needs Contents: Read, which the repository's own page does not.
		await branchHead(repository, repository.defaultBranch, token, options);
	} catch (error) {
		if (!(error instanceof UpstreamError)) throw error;
		return {
			ok: false,
			error:
				trouble("GitHub", error) ??
				"The token can see the repository but cannot read its files. It needs the permission Contents: Read-only.",
		};
	}
	return {
		ok: true,
		value: { target: `${repository.owner}/${repository.name}`, repositoryId: repository.id },
	};
}
