import { defineConfig } from "drizzle-kit";
import { loadEnv } from "./src/lib/env.js";

const env = loadEnv();

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: env.DATABASE_URL,
  },
});
