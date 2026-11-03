import { z } from "zod";

/**
 * All settings come from environment variables (see .env.example).
 * Ordering hours use 24h "HH:MM-HH:MM" per weekday, e.g. "mon=17:00-22:30,sat=11:00-22:30".
 * Days not listed are closed. Leave ORDERING_HOURS empty to use the Square location's business hours (none set = closed).
 */
const Env = z.object({
  PORT: z.coerce.number().default(3000),
  PUBLIC_BASE_URL: z.string().url(), // e.g. https://order.rainylaketech.ca  (used for webhook signature checks)
  DATABASE_URL: z.string().optional(), // postgres://... ; omit to use in-memory store (dev only)

  BUSINESS_NAME: z.string().default("Penalty Box Canteen"),
  TIMEZONE: z.string().default("America/Toronto"),
  ORDERING_HOURS: z.string().default(""),
  PICKUP_INSTRUCTIONS: z.string().default("Pick up at the canteen window."),
  MAX_ACTIVE_ORDERS: z.coerce.number().int().positive().default(15), // paid but not yet picked up
  ALLOW_TIPPING: z.string().default("false").transform((v) => v === "true"), // Square's checkout page auto-suggests a tip unless turned off
  CART_EXPIRY_MINUTES: z.coerce.number().int().positive().default(20),
  OWNER_PHONE: z.string(), // E.164, gets HELP handoffs and can text PAUSE / RESUME / STATUS

  SQUARE_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  SQUARE_ACCESS_TOKEN: z.string(),
  SQUARE_LOCATION_ID: z.string(),
  SQUARE_WEBHOOK_SIGNATURE_KEY: z.string(),
  SQUARE_API_VERSION: z.string().default("2026-09-16"),

  TWILIO_ACCOUNT_SID: z.string(),
  TWILIO_AUTH_TOKEN: z.string(),
  TWILIO_FROM_NUMBER: z.string(), // your Twilio number, E.164
  TWILIO_VALIDATE_SIGNATURE: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),

  ANTHROPIC_API_KEY: z.string(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),

  ADMIN_TOKEN: z.string().min(16), // bearer token for /admin endpoints
});

export type Config = z.infer<typeof Env> & { hours: OrderingHours };

export type Day = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export type OrderingHours = Partial<Record<Day, { open: number; close: number }>> | null; // minutes from midnight

export function parseHours(spec: string): OrderingHours {
  const s = spec.trim();
  if (!s) return null;
  const out: Partial<Record<Day, { open: number; close: number }>> = {};
  for (const part of s.split(",")) {
    const m = part.trim().match(/^(sun|mon|tue|wed|thu|fri|sat)=(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/i);
    if (!m) throw new Error(`ORDERING_HOURS: can't read "${part}". Use e.g. mon=17:00-22:30`);
    const day = m[1]!.toLowerCase() as Day;
    out[day] = { open: +m[2]! * 60 + +m[3]!, close: +m[4]! * 60 + +m[5]! };
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Missing or invalid settings:\n${lines.join("\n")}`);
  }
  return { ...parsed.data, hours: parseHours(parsed.data.ORDERING_HOURS) };
}
