import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["src/**/*.test.ts"],
        testTimeout: 15000,
        hookTimeout: 10000,
        pool: "forks",
        poolOptions: {
            forks: {
                singleFork: true,
            },
        },
    },
});
