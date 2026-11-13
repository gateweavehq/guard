import { createFileRoute } from "@tanstack/react-router";
import { Notice } from "#/components/workspace/notice";
import { useDocumentTitle } from "#/lib/title";

/** Everything this screen says, in one place, so it can be translated without hunting for it. */
const TEXT = {
	title: "Findings",
	empty: "No findings yet.",
	hint: "Connect a Cloudflare account or a GitHub repository to start.",
};

export const Route = createFileRoute("/$workspace/findings")({
	component: FindingsPage,
});

// Nothing produces findings yet, so this says so rather than show an example.
function FindingsPage() {
	useDocumentTitle(TEXT.title);
	return (
		<div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
			<h1 className="text-xl font-semibold tracking-tight">{TEXT.title}</h1>
			<Notice title={TEXT.empty}>{TEXT.hint}</Notice>
		</div>
	);
}
