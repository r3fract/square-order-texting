import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import type { TextOrderService } from "./service.js";
import { EMPTY_TWIML, verifyTwilioSignature } from "./sms.js";
import { verifySquareSignature } from "./square/webhook.js";
import type { Store } from "./store/types.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export const TWILIO_PATH = "/webhooks/twilio/sms";
export const SQUARE_PATH = "/webhooks/square";

export function buildApp(deps: { config: Config; service: TextOrderService; store: Store; logger?: boolean }): FastifyInstance {
  const { config, service, store } = deps;
  const app = Fastify({ logger: deps.logger ?? true, trustProxy: true });

  // Keep raw bodies: both Twilio and Square signatures are computed over the exact bytes sent.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.get("/health", async () => ({ ok: true }));

  app.post(TWILIO_PATH, async (req, reply) => {
    const params = (req.body ?? {}) as Record<string, string>;
    if (config.TWILIO_VALIDATE_SIGNATURE) {
      const ok = verifyTwilioSignature({
        authToken: config.TWILIO_AUTH_TOKEN,
        signature: req.headers["x-twilio-signature"] as string | undefined,
        url: config.PUBLIC_BASE_URL.replace(/\/$/, "") + TWILIO_PATH,
        params,
      });
      if (!ok) return reply.code(403).send("bad signature");
    }
    // Answer Twilio right away; the AI reply goes out through the REST API when it's ready.
    void service
      .handleInboundSms({ from: params.From ?? "", body: params.Body ?? "", messageSid: params.MessageSid ?? `${Date.now()}` })
      .catch((err) => req.log.error({ err }, "inbound sms failed"));
    return reply.type("text/xml").send(EMPTY_TWIML);
  });

  app.post(SQUARE_PATH, async (req, reply) => {
    const ok = verifySquareSignature({
      signatureKey: config.SQUARE_WEBHOOK_SIGNATURE_KEY,
      notificationUrl: config.PUBLIC_BASE_URL.replace(/\/$/, "") + SQUARE_PATH,
      rawBody: req.rawBody ?? "",
      signature: req.headers["x-square-hmacsha256-signature"] as string | undefined,
    });
    if (!ok) return reply.code(403).send("bad signature");
    try {
      await service.handleSquareEvent(req.body as any);
    } catch (err) {
      req.log.error({ err }, "square event failed");
      return reply.code(500).send("error"); // Square will retry
    }
    return reply.send({ ok: true });
  });

  /* ---- small admin API (Authorization: Bearer ADMIN_TOKEN) ---- */
  app.register(async (admin) => {
    admin.addHook("onRequest", async (req, reply) => {
      const got = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
      const want = Buffer.from(config.ADMIN_TOKEN);
      if (got.length !== want.length || !timingSafeEqual(got, want)) return reply.code(401).send("unauthorized");
    });
    admin.get("/admin/status", async () => ({ ...(await service.orderingStatus()), activeOrders: await store.countActiveOrders() }));
    admin.get("/admin/orders", async () => store.listOrders(100));
    admin.get("/admin/conversations", async () =>
      (await store.listConversations(50)).map((c) => ({
        phone: c.phone,
        name: c.customerName,
        updatedAt: c.updatedAt,
        humanUntil: c.humanUntil,
        optedOut: c.optedOut,
        cart: c.cart,
        transcript: c.messages
          .map((m) =>
            typeof m.content === "string"
              ? `customer: ${m.content}`
              : Array.isArray(m.content)
                ? (m.content as any[]).filter((b) => b.type === "text").map((b) => `bot: ${b.text}`).join("\n")
                : "",
          )
          .filter(Boolean),
      })),
    );
    admin.post("/admin/pause", async () => {
      await store.setSetting("paused", "true");
      return service.orderingStatus();
    });
    admin.post("/admin/resume", async () => {
      await store.setSetting("paused", "false");
      return service.orderingStatus();
    });
    admin.post("/admin/refresh-menu", async () => {
      const menu = await service.menus.getMenu(true);
      return { items: menu.items.length };
    });
  });

  return app;
}
