import { createServer } from "node:net";
import { concurrently } from "concurrently";
import { config } from "../server/config/env.js";

function claimAvailablePort(port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.once("error", reject);
		server.listen({ port, exclusive: true }, () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("Failed to resolve the selected backend port."));
				return;
			}

			server.close((error) => {
				if (error) reject(error);
				else resolve(address.port);
			});
		});
	});
}

async function selectBackendPort(preferredPort: number): Promise<number> {
	try {
		return await claimAvailablePort(preferredPort);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) {
			throw error;
		}
		return claimAvailablePort(0);
	}
}

if (import.meta.main) {
	const backendPort = await selectBackendPort(config.port);
	const backendUrl = `http://localhost:${backendPort}`;

	if (backendPort !== config.port) {
		process.stdout.write(`[Dev] Backend port ${config.port} is occupied; using ${backendPort}.\n`);
	}

	const { result } = concurrently(
		[
			{
				command: "bun --bun vite",
				name: "Client",
				env: { VITE_BACKEND_URL: backendUrl },
			},
			{
				command: "bun --watch server/server.ts",
				name: "Server",
				env: { PORT: String(backendPort) },
			},
		],
		{
			killOthersOn: ["failure", "success"],
			killSignal: "SIGTERM",
			killTimeout: 5_000,
			prefix: "name",
		},
	);

	try {
		await result;
	} catch {
		process.exitCode = 1;
	}
}
