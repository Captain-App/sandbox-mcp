import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
	resolve: {
		alias: {
			"cloudflare:workers": path.resolve(__dirname, "./src/test-utils/cloudflare-workers-mock.ts"),
		},
	},
	test: {
		globals: true,
		environment: "node",
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/*.integration.test.ts",
		],
	},
});
