import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { finishTrackConnect } from "#/lib/track";

const TEXT = {
	wait: "Connecting Track…",
	refused: "Track was not connected",
	back: "Track settings",
	connected: (workspace: string, team: string) => `Track connected to ${team} in ${workspace}.`,
};
// An expired session must still reach the page that clears the callback URL.
export const Route = createFileRoute("/$workspace_/settings/track/connected")({
	headers: () => ({ "Referrer-Policy": "no-referrer" }),
	component: Connected,
});
function Connected() {
	const { workspace: slug } = Route.useParams();
	const [message, setMessage] = useState(TEXT.wait);
	const posted = useRef(false);
	useEffect(() => {
		if (posted.current) return;
		posted.current = true;
		const url = new URL(window.location.href);
		const state = url.searchParams.get("state") ?? "";
		const code = url.searchParams.get("code") ?? undefined;
		const error = url.searchParams.get("error") ?? undefined;
		window.history.replaceState(window.history.state, "", url.pathname);
		void finishTrackConnect({ data: { slug, state, code, error } })
			.then((result) => {
				setMessage(result.ok ? TEXT.connected(result.workspace, result.team) : TEXT.refused);
			})
			.catch(() => setMessage(TEXT.refused));
	}, [slug]);
	return (
		<main className="mx-auto max-w-lg space-y-3 p-6">
			<p role="status">{message}</p>
			<Link to="/$workspace/settings/track" params={{ workspace: slug }}>
				{TEXT.back}
			</Link>
		</main>
	);
}
