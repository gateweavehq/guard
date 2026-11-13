import { env } from "cloudflare:workers";

// "Where the data lives" in docs/architecture.md.

/** The jurisdictions Cloudflare can keep a Durable Object in. */
const JURISDICTIONS: readonly DurableObjectJurisdiction[] = ["eu", "us", "fedramp", "fedramp-high"];

function isJurisdiction(value: string): value is DurableObjectJurisdiction {
	return (JURISDICTIONS as readonly string[]).includes(value);
}

/**
 * The jurisdiction a deployment keeps its Durable Objects in, from `DURABLE_OBJECT_JURISDICTION`,
 * or null for none. A value Cloudflare doesn't know is an error, not none: the operator asked for
 * their data to stay somewhere.
 */
export function configuredJurisdiction(
	value: string | undefined,
): DurableObjectJurisdiction | null {
	const name = value?.trim().toLowerCase();
	if (!name) return null;
	if (!isJurisdiction(name)) {
		throw new Error(
			`DURABLE_OBJECT_JURISDICTION is "${name}", which is none of ${JURISDICTIONS.join(", ")}`,
		);
	}
	return name;
}

/**
 * A namespace's objects in a jurisdiction, or outside any for null. The same name is another
 * object in each.
 */
export function objectsIn<T extends Rpc.DurableObjectBranded | undefined>(
	namespace: DurableObjectNamespace<T>,
	jurisdiction: DurableObjectJurisdiction | null,
): DurableObjectNamespace<T> {
	return jurisdiction ? namespace.jurisdiction(jurisdiction) : namespace;
}

/** The jurisdiction this deployment keeps its Durable Objects in, or null for none. */
export function deploymentJurisdiction(): DurableObjectJurisdiction | null {
	return configuredJurisdiction(env.DURABLE_OBJECT_JURISDICTION);
}
