import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { loadEnv } from "../lib/env.js";
import * as schema from "./schema.js";

const env = loadEnv();

export const queryClient = postgres(env.DATABASE_URL);
export const db = drizzle(queryClient, { schema });
