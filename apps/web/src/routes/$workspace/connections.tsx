import { createFileRoute } from "@tanstack/react-router";
import { Notice } from "#/components/workspace/notice";
import { useDocumentTitle } from "#/lib/title";

/** Everything this screen says, in one place, so it can be translated without hunting for it. */
const TEXT = {
	title: "Connections",
	empty: "Nothing connected yet.",
};

export const Route = createFileRoute("/$workspace/connections")({
	component: ConnectionsPage,
});

// Nothing can be connected yet, so there is nothing to list and nothing to offer.
function ConnectionsPage() {
	useDocumentTitle(TEXT.title);
	return (
		<div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
			<h1 className="text-xl font-semibold tracking-tight">{TEXT.title}</h1>
			<Notice title={TEXT.empty} />
		</div>
	);
}
