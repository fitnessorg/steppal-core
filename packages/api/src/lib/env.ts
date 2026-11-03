import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),

  SMS_PROVIDER: z.enum(["console", "termii"]).default("console"),
  TERMII_API_KEY: z.string().optional(),
  TERMII_SENDER_ID: z.string().default("StepPal"),
  TERMII_BASE_URL: z.string().default("https://api.ng.termii.com"),
  PAYMENT_PROVIDER: z.enum(["mock", "paystack"]).default("mock"),

  DAILY_STEP_CAP: z.coerce.number().int().positive().default(25000),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cachedEnv) return cachedEnv;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}

export function resetEnvForTest(): void {
  cachedEnv = undefined;
}
