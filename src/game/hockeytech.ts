/**
 * HockeyTech "lscluster" feed: the SIJHL's own site (sijhlhockey.com/stats/schedule) loads its scores from here.
 * The key and client code are the public ones that page uses. Ask the league before relying on it in production.
 */

export type FeedStatus = "scheduled" | "in_progress" | "intermission" | "final" | "unknown";

export interface FeedGame {
  id: string;
  homeId: string;
  visitorId: string;
  visitorCode: string;
  startsAt: Date;
  status: FeedStatus;
  period: number;
  clockSeconds: number | null;
  venue: string;
}

type RawGame = Record<string, string | undefined>;

function status(g: RawGame): FeedStatus {
  const s = g.GameStatus;
  if (s === "1") return "scheduled";
  if (s === "4") return "final";
  // In-progress codes seen on other HockeyTech leagues. Confirm on the first live Lakers game (fixture TODO in plan Task 11).
  if (s === "2" || s === "3") return g.Intermission === "1" ? "intermission" : "in_progress";
  return "unknown";
}

function clock(v: string | undefined): number | null {
  const m = v?.match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function parseScorebar(json: unknown): FeedGame[] {
  const root = (json as { SiteKit?: { Scorebar?: RawGame[] } })?.SiteKit?.Scorebar ?? [];
  return root
    .filter((g) => g.ID && g.GameDateISO8601)
    .map((g) => ({
      id: g.ID!,
      homeId: g.HomeID ?? "",
      visitorId: g.VisitorID ?? "",
      visitorCode: g.VisitorCode ?? "",
      startsAt: new Date(g.GameDateISO8601!),
      status: status(g),
      period: Number(g.Period ?? 0) || 0,
      clockSeconds: clock(g.GameClock),
      venue: g.venue_name ?? "",
    }));
}

export async function fetchScorebar(o: { key: string; clientCode: string; fetchImpl?: typeof fetch }): Promise<FeedGame[]> {
  const q = new URLSearchParams({
    feed: "modulekit",
    view: "scorebar",
    numberofdaysahead: "1",
    numberofdaysback: "0",
    limit: "50",
    fmt: "json",
    site_id: "1",
    lang: "en",
    league_id: "1",
    key: o.key,
    client_code: o.clientCode,
  });
  const res = await (o.fetchImpl ?? fetch)(`https://lscluster.hockeytech.com/feed/index.php?${q}`, {
    headers: { "User-Agent": "text-to-order/1.0 (Fort Frances canteen ordering)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HockeyTech feed ${res.status}`);
  const text = (await res.text()).trim().replace(/^\(([\s\S]*)\);?$/, "$1");
  return parseScorebar(JSON.parse(text));
}
