import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/connections/$workspace")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const { readConnections } = await import("#/server/connections/gateway");
				return readConnections(params.workspace);
			},
			POST: async ({ request, params }) => {
				const { changeConnections } = await import("#/server/connections/gateway");
				return changeConnections(request, params.workspace);
			},
		},
	},
});
