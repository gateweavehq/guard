import { createFileRoute, redirect } from "@tanstack/react-router";

// A workspace opens on its findings.
export const Route = createFileRoute("/$workspace/")({
	beforeLoad: ({ params }) => {
		throw redirect({ to: "/$workspace/findings", params, replace: true });
	},
});
