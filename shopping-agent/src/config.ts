import { z } from "zod";

const configSchema = z.object({
  BROWSERBASE_API_KEY: z.string().min(1),
  STAGEHAND_MODEL: z.string().min(1).default("google/gemini-3-flash-preview"),
  SUPABASE_URL: z.url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(8001),
  CORS_ORIGIN: z.string().min(1).default("http://localhost:3000"),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(env);
}
