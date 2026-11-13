import { createFileRoute, notFound } from "@tanstack/react-router";
import { ServerSettings } from "#/components/settings/server-settings";
import { Notice } from "#/components/workspace/notice";
import { getAccount } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";

/** Everything this screen says, in one place, so it can be translated without hunting for it. */
const TEXT = {
	title: "Server",
	missing: "Page not found",
	missingHint: "Check the address, or go back to your workspace.",
};

export const Route = createFileRoute("/$workspace/server")({
	// Only whoever runs the server has this page. The paths behind it refuse everyone else too.
	loader: async () => {
		const found = await getAccount();
		if (!found.account?.ownsServer) throw notFound();
		return { provider: found.provider ?? null };
	},
	component: ServerPage,
	notFoundComponent: () => <Notice title={TEXT.missing}>{TEXT.missingHint}</Notice>,
});

function ServerPage() {
	const { provider } = Route.useLoaderData();
	useDocumentTitle(TEXT.title);
	return (
		<div className="mx-auto max-w-3xl space-y-6 px-4 py-10 sm:px-6">
			<h1 className="text-xl font-semibold tracking-tight">{TEXT.title}</h1>
			<ServerSettings provider={provider} />
		</div>
	);
}
