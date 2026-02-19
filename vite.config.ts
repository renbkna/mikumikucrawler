import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	build: {
		rollupOptions: {
			output: {
				manualChunks: {
					vendor: ["react", "react-dom"],
				},
			},
		},
	},
	esbuild: {
		target: "es2022",
		format: "esm",
	},
});
