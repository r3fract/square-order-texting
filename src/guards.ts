import type { Day, OrderingHours } from "./config.js";

const DAYS: Day[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES: Record<Day, string> = {
  sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday",
};

/** Day of week and minutes after midnight in the business's time zone. */
export function localTime(now: Date, timeZone: string): { day: Day; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = get("weekday").slice(0, 3).toLowerCase() as Day;
  return { day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

function fmtTime(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, "0")}${ampm}`;
}

/** Windows may run past midnight (e.g. 18:00-01:00). No hours set means closed. */
export function isOpen(hours: OrderingHours, now: Date, timeZone: string): boolean {
  if (!hours) return false;
  const { day, minutes } = localTime(now, timeZone);
  const today = hours[day];
  if (today) {
    if (today.close > today.open && minutes >= today.open && minutes < today.close) return true;
    if (today.close <= today.open && minutes >= today.open) return true;
  }
  const prev = hours[DAYS[(DAYS.indexOf(day) + 6) % 7]!];
  if (prev && prev.close <= prev.open && minutes < prev.close) return true;
  return false;
}

export function nextOpeningText(hours: OrderingHours, now: Date, timeZone: string): string {
  if (!hours) return "";
  const { day, minutes } = localTime(now, timeZone);
  const idx = DAYS.indexOf(day);
  for (let i = 0; i < 8; i++) {
    const d = DAYS[(idx + i) % 7]!;
    const w = hours[d];
    if (!w) continue;
    if (i === 0 && w.open <= minutes) continue;
    const when = i === 0 ? "today" : i === 1 ? "tomorrow" : DAY_NAMES[d];
    return `Text ordering opens ${when} at ${fmtTime(w.open)}.`;
  }
  return "";
}

export function describeHours(hours: OrderingHours): string {
  if (!hours) return "not set";
  return DAYS.filter((d) => hours[d])
    .map((d) => `${DAY_NAMES[d]} ${fmtTime(hours[d]!.open)}-${fmtTime(hours[d]!.close)}`)
    .join(", ");
}

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Removes anything that looks like a payment card number so it never reaches the AI, logs, or the database. */
export function redactCardNumbers(text: string): { text: string; found: boolean } {
  let found = false;
  const out = text.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      found = true;
      return "[card number removed]";
    }
    return m;
  });
  return { text: out, found };
}

export type Keyword = "stop" | "start" | "human" | null;

/** Carrier opt-out words (Twilio also handles these itself) plus our "talk to a person" words. */
export function keyword(body: string): Keyword {
  const w = body.trim().toUpperCase().replace(/[.!]+$/, "");
  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "ARRET", "ARRÊT"].includes(w)) return "stop";
  if (["START", "UNSTOP", "YES"].includes(w)) return "start";
  if (["HUMAN", "PERSON", "AGENT", "OPERATOR", "REAL PERSON"].includes(w)) return "human";
  return null;
}

export function normalizePhone(p: string): string {
  return p.replace(/[^\d+]/g, "");
}
