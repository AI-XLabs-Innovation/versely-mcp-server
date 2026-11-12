// Account and billing: subscription status, credit history, plans and credit
// packs, and the subscription lifecycle (checkout links from Dodo Payments,
// pause / resume / cancel / skip trial / switch plan).
//
// The ChatGPT plugin gets only the read-only account tools: OpenAI's app rules
// forbid selling or managing subscriptions and credits inside ChatGPT, so the
// plan list, checkout links and lifecycle actions are full-profile only
// (tools/_policy.ts). Contracts: controllers/billing.controller.ts and
// controllers/auth/user.controller.ts (purchase / credit history).

import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { jsonResult } from "./_helpers.js";

const Empty = z.object({});

/** The churn survey the backend requires before a cancel or pause (lib/subscriptionFeedback.ts). */
const Reason = z
  .enum([
    "too_expensive",
    "unused",
    "missing_features",
    "low_quality",
    "switched_service",
    "too_complex",
    "customer_service",
    "other",
  ])
  .describe("Why: too_expensive, unused, missing_features, low_quality, switched_service, too_complex, customer_service, other.");
const Improvement = z
  .enum(["lower_price", "more_credits", "specific_model", "better_quality", "faster_generations", "easier_to_use", "nothing"])
  .describe("What would have kept them: lower_price, more_credits, specific_model, better_quality, faster_generations, easier_to_use, nothing.");
const ReturnIntent = z
  .enum(["soon", "maybe_later", "unlikely", "unsure"])
  .describe("Would they come back: soon, maybe_later, unlikely, unsure.");

// The web trial as it is sold since 2026-11-12: the Weekly plan's first week
// for $3, then $9 a week (backend lib/trial.ts and lib/trialPlans.ts; before
// that it was free, 3 days, on Weekly or Monthly). GET /billing/trial returns
// the live terms (versely_list_plans); when they change, change this wording
// with them. Web trials started before that date were free and are still
// running, and the iPhone app's trial is a separate free App Store trial, so a
// trial that already EXISTS is only ever called "a trial" here, never "free"
// and never "$3".
const TRIAL_OFFER = "the first week for $3 (Weekly plan only)";
const TRIAL_CHARGED_NOW = "$3 (plus tax where it applies) is charged at checkout and is not refunded";
const TRIAL_CHARGED_NEXT = "$9 a week follows after 7 days unless they cancel first";
/** What an assistant must get a yes to before it creates a trial checkout link. */
const TRIAL_CONFIRM = `confirm with the user that ${TRIAL_CHARGED_NOW}, and that ${TRIAL_CHARGED_NEXT}`;

const SURVEY_NOTE =
  "Versely asks three short questions first: ask the user (don't guess) why, what would have kept them, and " +
  "whether they might come back, and pass their answers.";

type SubscriptionRow = Record<string, unknown> & {
  status?: string;
  plan_label?: string;
  plan_key?: string | null;
  provider?: string;
  cancel_at_period_end?: boolean;
  current_period_end?: string | null;
  is_trial?: boolean;
  scheduled_change?: unknown;
};

/** The subscription in plain terms; the raw row keeps its ids out of the answer. */
function describeSubscription(sub: SubscriptionRow | null | undefined): Record<string, unknown> {
  if (!sub) return { subscribed: false, note: "No subscription on this account." };
  const status = String(sub.status ?? "unknown");
  const live = ["active", "on_hold", "pending"].includes(status);
  return {
    subscribed: live || status === "paused",
    plan: sub.plan_label ?? null,
    plan_key: sub.plan_key ?? null,
    status,
    on_trial: sub.is_trial === true,
    // The old name of `on_trial`, kept for clients that read it. A web trial
    // started since 2026-11-12 has a fee, so the name no longer fits.
    on_free_trial: sub.is_trial === true,
    ...(sub.cancel_at_period_end ? { cancels_at_period_end: true } : {}),
    ...(sub.current_period_end
      ? { [sub.cancel_at_period_end ? "access_until" : live ? "renews_at" : "period_end"]: sub.current_period_end }
      : {}),
    // App-store subscriptions are managed in the store, not here.
    billed_through: sub.provider === "dodo" ? "web" : sub.provider ? "app store" : null,
    ...(sub.scheduled_change ? { scheduled_change: sub.scheduled_change } : {}),
  };
}

// --- Read-only (both profiles) ------------------------------------------------

const versely_get_subscription = defineTool({
  name: "versely_get_subscription",
  description:
    "The user's Versely subscription: plan, status (active, paused, cancelled...), whether it is on a trial " +
    "(`on_trial`), when it renews or ends, whether it is set to cancel, and any plan switch scheduled. Call it a " +
    "trial, not a free trial: a web trial can have a fee. `on_free_trial` is the old name of `on_trial` and always " +
    "has the same value.",
  inputSchema: Empty,
  handler: async (_input, ctx) => {
    const data = await ctx.client.get<{ subscription?: SubscriptionRow | null }>("/api/v1/billing/subscription");
    return jsonResult(describeSubscription(data?.subscription ?? null));
  },
});

const versely_list_credit_history = defineTool({
  name: "versely_list_credit_history",
  description:
    "The user's credit history, newest first: what each generation spent (with its model), refunds for failed " +
    "jobs, and credits added by purchases, with the balance after each.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).optional().describe("How many entries (default 50)."),
    offset: z.number().int().min(0).optional().describe("How many to skip, for paging."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get("/api/v1/user/credit-history", {
      query: { limit: input.limit, offset: input.offset },
    });
    return jsonResult(data);
  },
});

// --- Plans, checkout, lifecycle (full profile only) -----------------------------

const versely_list_plans = defineTool({
  name: "versely_list_plans",
  description:
    "Versely's subscription plans and credit packs: key, name, price (USD) and credits. Credit packs are add-ons " +
    "that top up a plan: they can only be bought while the account has an active subscription. `trial_offer` is the " +
    `web trial, ${TRIAL_OFFER}: \`fee\` is charged at checkout and is not refunded, and after \`days\` days the ` +
    "Weekly plan's price ($9 a week) is charged unless the user cancels first. It is once per account, for accounts " +
    "that never subscribed, while spots are open (`open`, `left`). It includes `includes.credits` credits in total " +
    "(`bonus_credits` are part of that number, not extra), post analytics, and auto-posts with no count when " +
    "`posts_unlimited` is true (ignore `posts`; fair use is up to 5 posts a day for each connected account, and " +
    "posts past that use credits). Monthly, Pro Monthly and the annual plans start without a trial. `free_trial` is " +
    "the old name of `trial_offer` and holds the same data; the web trial is not free. The iPhone app has its own " +
    "trial through the App Store (free, 3 days, 24 credits).",
  inputSchema: Empty,
  handler: async (_input, ctx) => {
    const [plans, trial] = await Promise.all([
      ctx.client.get<{ plans?: Array<Record<string, unknown>>; addonRequiresSubscription?: boolean }>("/api/v1/billing/plans"),
      ctx.client.get<Record<string, unknown>>("/api/v1/billing/trial").catch(() => null),
    ]);
    const list = Array.isArray(plans?.plans) ? plans.plans : [];
    const { success: _s, ...trialInfo } = (trial ?? {}) as Record<string, unknown>;
    return jsonResult({
      subscriptions: list.filter((p) => p.kind === "subscription"),
      credit_packs: list.filter((p) => p.kind !== "subscription"),
      credit_packs_need_active_subscription: plans?.addonRequiresSubscription !== false,
      // `free_trial` is the old name, kept for clients that read it.
      ...(trial ? { trial_offer: trialInfo, free_trial: trialInfo } : {}),
    });
  },
});

const versely_create_checkout_link = defineTool({
  name: "versely_create_checkout_link",
  description:
    "Create a Dodo Payments checkout link for a subscription plan or a credit pack (`plan_key` from " +
    "versely_list_plans), and give it to the user to open and pay. Nothing is charged until they pay there. A credit " +
    "pack needs an active subscription; an account that already has a plan switches with versely_change_plan " +
    `instead. \`trial: true\` starts the web trial, ${TRIAL_OFFER}: once per account, for accounts that never ` +
    `subscribed, while spots are open (versely_list_plans). Before creating a trial link, ${TRIAL_CONFIRM}. ` +
    `Every other plan starts without a trial.`,
  inputSchema: z.object({
    plan_key: z.string().min(1).describe("The plan or credit pack `key` from versely_list_plans."),
    trial: z
      .boolean()
      .optional()
      .describe(
        "Start the Weekly plan with the first week for $3 (`plan_key` must be `weekly`; no other plan has a trial). " +
          `First ${TRIAL_CONFIRM}.`,
      ),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.post<{ url?: string }>("/api/v1/billing/checkout", {
      plan_key: input.plan_key,
      ...(input.trial ? { trial: true } : {}),
    });
    if (typeof data?.url !== "string" || !data.url) return jsonResult(data);
    // A trial link charges the trial's fee, not the plan's price, and the
    // plan's own credits come when the trial ends: say so with the link.
    if (input.trial) {
      const terms =
        `This link starts the Weekly plan with the first week for $3: ${TRIAL_CHARGED_NOW}. ${TRIAL_CHARGED_NEXT}. ` +
        `The trial's credits are added to their Versely account as soon as the payment goes through; the plan's ` +
        `full credits come when the plan's price is charged.`;
      return {
        content: [
          { type: "text", text: `Checkout link: ${data.url}\n\nGive the user this link to pay with Dodo Payments. ${terms}` },
        ],
        structuredContent: { plan_key: input.plan_key, url: data.url, trial: true, terms },
      };
    }
    return {
      content: [
        {
          type: "text",
          text:
            `Checkout link: ${data.url}\n\nGive the user this link to pay with Dodo Payments. The plan or credits ` +
            `are added to their Versely account as soon as the payment goes through.`,
        },
      ],
      structuredContent: { plan_key: input.plan_key, url: data.url },
    };
  },
});

const versely_get_billing_portal_link = defineTool({
  name: "versely_get_billing_portal_link",
  description:
    "A link to the user's Dodo Payments billing portal, where they update their card and download invoices. " +
    "Only for accounts that have bought something on the web.",
  inputSchema: Empty,
  handler: async (_input, ctx) => {
    const data = await ctx.client.post<{ url?: string }>("/api/v1/billing/portal", {});
    if (typeof data?.url !== "string" || !data.url) return jsonResult(data);
    return {
      content: [{ type: "text", text: `Billing portal: ${data.url}\n\nGive the user this link.` }],
      structuredContent: { url: data.url },
    };
  },
});

const churnSchema = z.object({ reason: Reason, improvement: Improvement, return_intent: ReturnIntent });

const versely_cancel_subscription = defineTool({
  name: "versely_cancel_subscription",
  description:
    "Cancel the user's web subscription at the end of the current period: they keep the plan and its credits " +
    "until then (`access_until`), and it does not renew. Undo with versely_resume_subscription before it ends. " +
    `Confirm with the user first. ${SURVEY_NOTE} App-store subscriptions are cancelled in the store.`,
  inputSchema: churnSchema,
  handler: async (input, ctx) => {
    const data = await ctx.client.post<{ access_until?: string | null; subscription?: SubscriptionRow }>(
      "/api/v1/billing/subscription/cancel",
      input,
    );
    return jsonResult({
      cancelled: true,
      access_until: data?.access_until ?? null,
      subscription: describeSubscription(data?.subscription),
    });
  },
});

const versely_pause_subscription = defineTool({
  name: "versely_pause_subscription",
  description:
    "Pause the user's web subscription now: billing stops, and so do the plan's benefits, until it is resumed with " +
    `versely_resume_subscription. Confirm with the user first. ${SURVEY_NOTE}`,
  inputSchema: churnSchema,
  handler: async (input, ctx) => {
    const data = await ctx.client.post<{ subscription?: SubscriptionRow }>("/api/v1/billing/subscription/pause", input);
    return jsonResult({ paused: true, subscription: describeSubscription(data?.subscription) });
  },
});

const versely_resume_subscription = defineTool({
  name: "versely_resume_subscription",
  description:
    "Resume the user's paused web subscription, or undo a scheduled cancellation so it renews again.",
  inputSchema: Empty,
  handler: async (_input, ctx) => {
    const data = await ctx.client.post<{ subscription?: SubscriptionRow }>("/api/v1/billing/subscription/resume", {});
    return jsonResult({ resumed: true, subscription: describeSubscription(data?.subscription) });
  },
});

const versely_skip_trial = defineTool({
  name: "versely_skip_trial",
  description:
    "End the user's trial now and start the paid plan: their card is charged the plan's price now (instead of " +
    "when the trial ends) and the plan's full credits are added. Anything already paid for the trial is not " +
    "refunded. Web trials only. Confirm with the user first.",
  inputSchema: Empty,
  handler: async (_input, ctx) => {
    const data = await ctx.client.post<{ charge_at?: string }>("/api/v1/billing/subscription/skip-trial", {});
    return jsonResult({
      trial_ending: true,
      charge_at: data?.charge_at ?? null,
      note: "The card is charged in the next couple of minutes; the plan's credits arrive once the payment goes through.",
    });
  },
});

const versely_preview_plan_change = defineTool({
  name: "versely_preview_plan_change",
  description:
    "What switching the user's subscription to another plan would do, without changing anything: when it takes " +
    "effect (now or at the next renewal), what is charged today, the credits they get now, and the new renewal date. " +
    "Show this to the user before versely_change_plan.",
  inputSchema: z.object({ plan_key: z.string().min(1).describe("The target plan `key` from versely_list_plans.") }),
  handler: async (input, ctx) => {
    const data = await ctx.client.post("/api/v1/billing/subscription/change-plan/preview", { plan_key: input.plan_key });
    return jsonResult(data);
  },
});

const versely_change_plan = defineTool({
  name: "versely_change_plan",
  description:
    "Switch the user's web subscription to another plan (as versely_preview_plan_change describes: upgrades apply " +
    "now and may charge today, downgrades at the next renewal). Confirm with the user after showing the preview.",
  inputSchema: z.object({ plan_key: z.string().min(1).describe("The target plan `key` from versely_list_plans.") }),
  handler: async (input, ctx) => {
    const data = await ctx.client.post("/api/v1/billing/subscription/change-plan", { plan_key: input.plan_key });
    return jsonResult(data);
  },
});

const versely_cancel_plan_change = defineTool({
  name: "versely_cancel_plan_change",
  description: "Cancel a plan switch that is scheduled for the next renewal; the current plan simply continues.",
  inputSchema: Empty,
  handler: async (_input, ctx) => {
    const data = await ctx.client.post("/api/v1/billing/subscription/change-plan/cancel", {});
    return jsonResult({ ...(data as Record<string, unknown>), scheduled_change_cancelled: true });
  },
});

export const billingTools: Tool[] = [
  versely_get_subscription,
  versely_list_credit_history,
  versely_list_plans,
  versely_create_checkout_link,
  versely_get_billing_portal_link,
  versely_cancel_subscription,
  versely_pause_subscription,
  versely_resume_subscription,
  versely_skip_trial,
  versely_preview_plan_change,
  versely_change_plan,
  versely_cancel_plan_change,
];
