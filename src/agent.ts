import { z } from "zod";
import type { OrderService } from "./orders.js";
import { formatMoney, menuForModel, type MenuService } from "./square/menu.js";
import type { CartLine, Conversation, OrderRecord, Store, StoredMessage } from "./store/types.js";

/* ---------- minimal model interface (the real one wraps @anthropic-ai/sdk; tests use a fake) ---------- */

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface ModelResponse {
  content: ContentBlock[];
  stop_reason: string | null;
}

export interface ModelRequest {
  model: string;
  max_tokens: number;
  system: string;
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[];
  messages: StoredMessage[];
}

export interface ModelClient {
  create(req: ModelRequest): Promise<ModelResponse>;
}

/* ---------- tools ---------- */

const SetCartInput = z.object({
  lines: z
    .array(
      z.object({
        variation_id: z.string(),
        quantity: z.number().int(),
        modifier_ids: z.array(z.string()).default([]),
        note: z.string().max(200).optional(),
      }),
    )
    .max(30),
});

const PickupInput = z.object({
  customer_name: z.string().max(60).optional(),
  pickup_note: z.string().max(200).optional(),
});

const HandoffInput = z.object({ reason: z.string().max(300) });

export const TOOLS: ModelRequest["tools"] = [
  {
    name: "set_cart",
    description:
      "Replace the customer's whole cart. Always send every line, not just the change. Use only variation and option ids from the menu. Returns Square's calculated prices and tax, or a list of problems to fix or explain.",
    input_schema: {
      type: "object",
      properties: {
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              variation_id: { type: "string", description: "Menu variation id" },
              quantity: { type: "integer", minimum: 1 },
              modifier_ids: { type: "array", items: { type: "string" }, description: "Option ids for this line" },
              note: { type: "string", description: "Short kitchen note, only for requests the options don't cover (e.g. 'no salt')" },
            },
            required: ["variation_id", "quantity"],
          },
        },
      },
      required: ["lines"],
    },
  },
  {
    name: "set_pickup_details",
    description: "Save the customer's name and/or when they want to pick up (e.g. 'after 2nd period', '7:30').",
    input_schema: {
      type: "object",
      properties: { customer_name: { type: "string" }, pickup_note: { type: "string" } },
    },
  },
  {
    name: "send_checkout_link",
    description:
      "Create the Square payment link for the current cart once the customer has confirmed it. The order summary, total and link are added to your reply automatically; do not repeat prices or the link yourself.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "cancel_order",
    description: "Empty the cart and cancel any unpaid payment link. Paid orders can't be canceled by text; use handoff_to_human for those.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "order_status",
    description: "Look up this customer's recent text orders and their status.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "handoff_to_human",
    description:
      "Pass the conversation to staff. Use when the customer asks for a person, has a complaint, a refund or allergy question, or anything you can't handle with the tools.",
    input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
  },
];

/* ---------- agent ---------- */

export interface AgentDeps {
  model: ModelClient;
  modelName: string;
  menus: MenuService;
  orders: OrderService;
  store: Store;
  businessName: string;
  pickupInstructions: string;
  orderingStatus: () => Promise<{ open: boolean; message: string }>;
  hoursText: string;
  handoff: (conv: Conversation, reason: string) => Promise<void>;
  now?: () => Date;
  timeZone: string;
}

export interface AgentTurnResult {
  reply: string;
  checkout?: OrderRecord;
}

const MAX_TOOL_ROUNDS = 8;
const MAX_HISTORY = 40;

const STATUS_WORDS: Record<OrderRecord["status"], string> = {
  awaiting_payment: "waiting for payment",
  paid: "paid, being made",
  ready: "ready for pickup",
  picked_up: "picked up",
  expired: "link expired (not paid)",
  replaced: "replaced by a newer link",
  canceled: "canceled",
};

async function recentOrdersText(store: Store, phone: string): Promise<string> {
  const recent = (await store.listOrders(200)).filter((o) => o.phone === phone).slice(0, 5);
  if (recent.length === 0) return "No text orders found for this customer.";
  return recent
    .map((o) => `#${o.orderNumber} · ${formatMoney(o.totalCents, o.currency)} · ${STATUS_WORDS[o.status]} · ${o.createdAt.toISOString()}`)
    .join("\n");
}

function cartText(conv: Conversation, svc: { name: (id: string) => string }): string {
  if (conv.cart.length === 0) return "(empty)";
  return conv.cart
    .map((l, i) => `${i + 1}. ${l.quantity} × ${svc.name(l.variationId)} [${l.variationId}]${l.modifierIds.length ? ` options=[${l.modifierIds.join(", ")}]` : ""}${l.note ? ` note="${l.note}"` : ""}`)
    .join("\n");
}

export async function buildSystemPrompt(deps: AgentDeps, conv: Conversation): Promise<string> {
  const menu = await deps.menus.getMenu();
  const stock = await deps.menus.getStock(menu);
  const status = await deps.orderingStatus();
  const now = (deps.now ?? (() => new Date()))();
  const localNow = now.toLocaleString("en-CA", { timeZone: deps.timeZone, weekday: "long", hour: "numeric", minute: "2-digit" });
  const recentOrders = await recentOrdersText(deps.store, conv.phone);
  const nameOf = (id: string) => {
    const hit = menu.byVariation.get(id);
    return hit ? (hit.item.variations.length > 1 ? `${hit.item.name} (${hit.variation.name})` : hit.item.name) : id;
  };

  return `You take food and drink orders by text message for ${deps.businessName}. Customers text in plain language; you build their order with the tools and send a payment link.

How to write:
- This is SMS. Short, friendly, plain text. No markdown, no bullet symbols, no headings. One emoji at most, and usually none.
- Never state a price, tax or total that didn't come from a tool result. If unsure, call set_cart to get Square's numbers.
- Never ask for or accept card details by text. Payment only happens through the link.
- If something is sold out or not on the menu, say so and suggest something close that is available.
- If you mention cancelling, tell them to text "cancel my order". Never suggest texting just "CANCEL" or "STOP"; carriers treat those as unsubscribing.
- Ask one short question at a time when an order is unclear (size, required option). Don't invent sizes or options that aren't on the menu.
- If they ask what you have, keep it to one short text: item names grouped by category, with prices only when an item has one price. Skip option lists and extra charges unless asked. Leave out anything sold out or not orderable by text.
- Keep the number of back-and-forth texts low. Every text costs the customer time.

How to take an order:
1. As soon as you understand items, call set_cart with the full cart (it replaces the old cart). Fix any problems it returns.
2. Once the items are settled, send ONE message that reads the order back with Square's total and asks for whatever is still missing, together: their name (if you don't have it) and pickup time (if they haven't said; "right away" is the default). Example: "Got it: a croissant and a small latte, $8.75. What name should I put on it, and is right away OK for pickup?" Save answers with set_pickup_details.
3. When they answer with a name, a time or "yes" and don't change the items, that is their confirmation: call send_checkout_link in the same turn. Don't ask "want me to send the link?" again. The summary and link are appended for you; just add a short line like "Thanks Riley, here's your order."
4. Changes after a link was sent: call set_cart again, then send_checkout_link again. The old link stops working automatically.
5. The kitchen starts only after payment. You'll never confirm an order as placed yourself; the system texts them when payment lands.
6. For questions about an existing order, go by the order status list below, not your memory of the chat. If an order is "ready for pickup", say so. Only say it's being made if it says "paid, being made". If they say they already picked it up, take their word for it.
7. Something new after an order is paid is a separate order with its own link. Say that once, briefly.

Pickup: ${deps.pickupInstructions}
Text ordering hours: ${deps.hoursText}
Right now: ${localNow}. ${status.message}

Customer: ${conv.customerName ?? "(name not given yet)"} · phone ${conv.phone}
Pickup note: ${conv.pickupNote ?? "(none)"}
This customer's text orders, current status (trust this over anything said earlier in the chat):
${recentOrders}
Current cart:
${cartText(conv, { name: nameOf })}

MENU (live from Square; [SOLD OUT] items can't be ordered):
${menuForModel(menu, stock)}`;
}

function trimHistory(messages: StoredMessage[]): StoredMessage[] {
  if (messages.length <= MAX_HISTORY) return messages;
  // Start at a plain user text message so tool_use / tool_result pairs are never split.
  let start = messages.length - MAX_HISTORY;
  const isPlainUser = (m: StoredMessage) =>
    m.role === "user" && (typeof m.content === "string" || (m.content as { type?: string }[]).every((b) => b.type === "text"));
  while (start < messages.length && !isPlainUser(messages[start]!)) start++;
  return messages.slice(start);
}

/** Every dollar amount in a string, in cents. */
export function dollarAmounts(text: string): number[] {
  return [...text.matchAll(/\$\s?(\d{1,4}(?:,\d{3})*)(?:\.(\d{1,2}))?/g)].map(
    (m) => Number(m[1]!.replace(/,/g, "")) * 100 + Number((m[2] ?? "0").padEnd(2, "0")),
  );
}

/** Drops tool_use blocks that never got a result (e.g. the reply was cut off) and empty assistant turns, so the history stays valid. */
function repairTail(messages: StoredMessage[]) {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return;
  const kept = (last.content as ContentBlock[]).filter((b) => b.type !== "tool_use" && !(b.type === "text" && !b.text.trim()));
  if (kept.length) last.content = kept;
  else messages.pop();
}

/** Adds the customer's text, merging into a trailing user turn (e.g. leftover tool results) so roles keep alternating. */
function appendUserText(messages: StoredMessage[], text: string) {
  const last = messages.at(-1);
  if (last?.role === "user") {
    const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : (last.content as unknown[]);
    last.content = [...blocks, { type: "text", text }];
  } else {
    messages.push({ role: "user", content: text });
  }
}

export async function runAgentTurn(deps: AgentDeps, conv: Conversation, customerText: string): Promise<AgentTurnResult> {
  repairTail(conv.messages);
  appendUserText(conv.messages, customerText);
  conv.messages = trimHistory(conv.messages);
  let checkout: OrderRecord | undefined;
  let checkoutQuote: string | undefined;
  const texts: string[] = [];
  const sourceText: string[] = []; // where verified prices can come from: the live menu and tool results

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const system = await buildSystemPrompt(deps, conv);
    sourceText.push(system);
    const res = await deps.model.create({
      model: deps.modelName,
      max_tokens: 2048,
      system,
      tools: TOOLS,
      messages: conv.messages,
    });
    if (res.content.length) conv.messages.push({ role: "assistant", content: res.content });
    const roundText = res.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text.trim()).filter(Boolean);
    texts.splice(0, texts.length, ...roundText); // only the final round's words go to the customer

    const toolUses = res.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || toolUses.length === 0) break;

    const results: { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }[] = [];
    for (const tu of toolUses) {
      try {
        const out = await runTool(deps, conv, tu.name, tu.input);
        if (out.checkout) {
          checkout = out.checkout.order;
          checkoutQuote = out.checkout.summary;
        }
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out.result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: `Error: ${msg}`, is_error: true });
      }
    }
    conv.messages.push({ role: "user", content: results });
    if (round === MAX_TOOL_ROUNDS - 1) texts.splice(0, texts.length, "Sorry, I got stuck on that one. Could you say it another way?");
  }
  repairTail(conv.messages);

  let reply = texts.join("\n\n").replace(/\*\*|__|^#+\s/gm, "").trim();

  // Price guard: the AI may repeat prices it saw (menu, Square's quotes) but not do its own math.
  for (const m of conv.messages) {
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const b of m.content as { type?: string; content?: unknown }[]) if (b.type === "tool_result") sourceText.push(String(b.content));
    }
  }
  const verified = new Set(sourceText.flatMap(dollarAmounts));
  const invented = dollarAmounts(reply).filter((c) => !verified.has(c));
  if (invented.length) {
    const q = conv.cart.length ? await deps.orders.quote(conv).catch(() => null) : null;
    reply =
      q && q.ok
        ? `Here's your order so far, priced by our register:\n${q.quote.text}\n\nWant me to send the payment link?`
        : "Sorry, let me get that price right. What would you like to order?";
    appendUserText(conv.messages, "(system: your last reply had a price that didn't come from the menu or Square, so it was replaced with Square's own summary. Only repeat prices you were given.)");
    conv.messages.push({ role: "assistant", content: [{ type: "text", text: reply }] });
  }

  if (checkout && checkoutQuote) {
    reply = `${reply ? reply + "\n\n" : ""}${checkoutQuote}\n\nPay here (Apple Pay, Google Pay or card):\n${checkout.paymentLinkUrl}`;
  }
  if (!reply) reply = "Sorry, I missed that. What can I get you?";
  return { reply, checkout };
}

async function runTool(
  deps: AgentDeps,
  conv: Conversation,
  name: string,
  input: unknown,
): Promise<{ result: string; checkout?: { order: OrderRecord; summary: string } }> {
  switch (name) {
    case "set_cart": {
      const parsed = SetCartInput.parse(input);
      conv.cart = parsed.lines.map<CartLine>((l) => ({
        variationId: l.variation_id,
        quantity: l.quantity,
        modifierIds: l.modifier_ids,
        ...(l.note ? { note: l.note } : {}),
      }));
      if (conv.cart.length === 0) return { result: "Cart is now empty." };
      const q = await deps.orders.quote(conv);
      if (!q.ok) return { result: `Cart saved but has problems. Fix or ask the customer:\n${q.problems.join("\n")}` };
      return { result: `Cart saved. Square's pricing:\n${q.quote.text}` };
    }
    case "set_pickup_details": {
      const p = PickupInput.parse(input);
      if (p.customer_name) conv.customerName = p.customer_name.trim();
      if (p.pickup_note) conv.pickupNote = p.pickup_note.trim();
      return { result: "Saved." };
    }
    case "send_checkout_link": {
      if (conv.cart.length === 0) return { result: "Can't send a link: the cart is empty." };
      const r = await deps.orders.checkout(conv);
      if (!r.ok) return { result: `Link not created. Tell the customer: ${r.reason}` };
      return {
        result: `Link created for order #${r.order.orderNumber}, total ${formatMoney(r.order.totalCents, r.order.currency)}. The summary and link will be appended to your reply automatically.`,
        checkout: { order: r.order, summary: r.quote.text },
      };
    }
    case "cancel_order": {
      conv.cart = [];
      const retired = await deps.orders.retireAwaiting(conv.phone, "canceled");
      return { result: retired ? `Canceled unpaid order #${retired.orderNumber}; its link no longer works.` : "Cart cleared. There was no unpaid link." };
    }
    case "order_status":
      return { result: await recentOrdersText(deps.store, conv.phone) };
    case "handoff_to_human": {
      const { reason } = HandoffInput.parse(input);
      await deps.handoff(conv, reason);
      return { result: "Staff have been notified and will reply by text. Tell the customer someone will get back to them shortly." };
    }
    default:
      return { result: `Unknown tool ${name}` };
  }
}
