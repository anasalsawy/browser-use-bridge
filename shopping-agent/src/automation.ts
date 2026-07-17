import { Browserbase } from "@browserbasehq/sdk";
import { Stagehand } from "@browserbasehq/stagehand";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { isSameMerchant, merchantOrigin, type CreateRunInput } from "./schemas.js";
import {
  getRun,
  recordEvent,
  updateRun,
  type ShoppingRunRecord,
} from "./repository.js";

const cartReviewSchema = z.object({
  total: z.number().nonnegative(),
  currency: z.string().length(3),
  itemCount: z.number().int().nonnegative(),
  readyForCheckout: z.boolean(),
  notes: z.string().default(""),
});

const confirmationSchema = z.object({
  orderPlaced: z.boolean(),
  orderNumber: z.string().nullable(),
  chargedTotal: z.number().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
  requiresUserAction: z.boolean(),
  message: z.string().default(""),
});

type RunContext = {
  config: AppConfig;
  supabase: SupabaseClient;
  userId: string;
};

function createStagehand(
  config: AppConfig,
  run: Pick<ShoppingRunRecord, "id" | "browserbase_context_id" | "browserbase_session_id">,
  keepAlive: boolean,
): Stagehand {
  if (run.browserbase_session_id) {
    return new Stagehand({
      env: "BROWSERBASE",
      apiKey: config.BROWSERBASE_API_KEY,
      model: config.STAGEHAND_MODEL,
      browserbaseSessionID: run.browserbase_session_id,
      keepAlive,
      verbose: 0,
      logInferenceToFile: false,
      systemPrompt: "Never expose, request, copy, extract, or log payment credentials.",
    });
  }

  const browserSettings: Record<string, unknown> = {
    blockAds: true,
    solveCaptchas: true,
    viewport: { width: 1440, height: 1000 },
  };
  if (run.browserbase_context_id) {
    browserSettings.context = { id: run.browserbase_context_id, persist: true };
  }

  return new Stagehand({
    env: "BROWSERBASE",
    apiKey: config.BROWSERBASE_API_KEY,
    model: config.STAGEHAND_MODEL,
    keepAlive,
    verbose: 0,
    logInferenceToFile: false,
    systemPrompt: "Never expose, request, copy, extract, or log payment credentials.",
    browserbaseSessionCreateParams: {
      keepAlive,
      browserSettings,
      userMetadata: { shoppingRunId: run.id },
    },
  });
}

async function liveViewUrl(config: AppConfig, sessionId: string): Promise<string> {
  const browserbase = new Browserbase({ apiKey: config.BROWSERBASE_API_KEY });
  const links = await browserbase.sessions.debug(sessionId);
  return links.debuggerFullscreenUrl;
}

function shoppingInstruction(input: CreateRunInput): string {
  const items = input.items.map((item, index) => ({
    item: index + 1,
    query: item.query,
    quantity: item.quantity,
    maxUnitPrice: item.maxUnitPrice ?? null,
    preferences: item.preferences,
    allowSubstitutions: item.allowSubstitutions,
  }));

  return [
    `Shop only on ${merchantOrigin(input.merchantUrl)}.`,
    `Add the requested products to the cart while keeping the estimated total at or below ${input.budget} ${input.currency}.`,
    `Requested items: ${JSON.stringify(items)}.`,
    "Do not purchase anything. Do not click Place order, Buy now, Submit order, or any equivalent final-purchase control.",
    "Do not type, reveal, request, copy, or inspect card details, passwords, security codes, or one-time codes.",
    "Avoid memberships, subscriptions, warranties, donations, tips, and add-ons unless explicitly requested.",
    "Stop at the final cart or checkout review page, before payment confirmation.",
  ].join("\n");
}

export async function prepareShoppingRun(
  context: RunContext,
  run: ShoppingRunRecord,
  input: CreateRunInput,
): Promise<void> {
  const stagehand = createStagehand(context.config, run, true);
  try {
    await updateRun(context.supabase, run.id, { status: "shopping", error_message: null });
    await recordEvent(context.supabase, context.userId, run.id, "shopping_started", "Shopping session started");

    await stagehand.init();
    const sessionId = stagehand.browserbaseSessionID;
    if (!sessionId) throw new Error("Browserbase did not return a session ID");

    const liveView = await liveViewUrl(context.config, sessionId);
    await updateRun(context.supabase, run.id, {
      browserbase_session_id: sessionId,
      live_view_url: liveView,
    });

    const page = stagehand.context.pages()[0];
    if (!page) throw new Error("Browserbase session has no page");
    await page.goto(input.merchantUrl);

    const agent = stagehand.agent({
      systemPrompt: "You are a constrained shopping assistant. You may search and add items to a cart, but you must stop before submitting an order or handling payment credentials.",
    });
    await agent.execute(shoppingInstruction(input));

    const currentUrl = await page.url();
    if (!isSameMerchant(currentUrl, input.merchantUrl)) {
      throw new Error("Automation left the approved merchant domain");
    }

    const review = await stagehand.extract(
      "Extract the cart or order-review total, ISO 4217 currency code, item count, and whether the cart is ready for checkout. Never extract payment credentials.",
      cartReviewSchema,
    );

    if (review.currency.toUpperCase() !== input.currency) {
      throw new Error(`Merchant currency ${review.currency} does not match requested currency ${input.currency}`);
    }
    if (review.total > input.budget) {
      throw new Error(`Cart total ${review.total} exceeds budget ${input.budget}`);
    }

    await updateRun(context.supabase, run.id, {
      status: "awaiting_approval",
      cart_total: review.total,
      result: { cartReview: review },
    });
    await recordEvent(
      context.supabase,
      context.userId,
      run.id,
      "approval_requested",
      "Cart is ready for final approval",
      { total: review.total, currency: review.currency, itemCount: review.itemCount },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown automation error";
    await updateRun(context.supabase, run.id, { status: "failed", error_message: message });
    await recordEvent(context.supabase, context.userId, run.id, "run_failed", message);
  } finally {
    await stagehand.close().catch(() => undefined);
  }
}

function finalPurchaseAction(actions: Awaited<ReturnType<Stagehand["observe"]>>) {
  const purchaseWords = /(place|submit|complete|confirm)\s+(my\s+)?order|buy\s+now/i;
  const candidates = actions.filter((action) =>
    action.method === "click" && purchaseWords.test(action.description),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

export async function continueApprovedRun(
  context: RunContext,
  runId: string,
): Promise<void> {
  const run = await getRun(context.supabase, runId);
  if (!run) throw new Error("Run not found");
  if (!run.browserbase_session_id) throw new Error("Run has no resumable Browserbase session");

  const stagehand = createStagehand(context.config, run, run.payment_mode === "secure_handoff");
  try {
    await stagehand.init();
    const page = stagehand.context.activePage();
    if (!page) throw new Error("Browserbase session has no active page");
    const currentUrl = await page.url();
    if (!isSameMerchant(currentUrl, run.merchant_url)) {
      throw new Error("Checkout is no longer on the approved merchant domain");
    }

    const review = await stagehand.extract(
      "Re-extract the final order total, ISO 4217 currency code, item count, and checkout readiness. Never extract payment credentials.",
      cartReviewSchema,
    );
    if (run.approved_maximum === null || review.total > run.approved_maximum) {
      await updateRun(context.supabase, run.id, {
        status: "awaiting_approval",
        cart_total: review.total,
        approved_maximum: null,
        approved_at: null,
      });
      await recordEvent(context.supabase, context.userId, run.id, "reapproval_required", "Cart total changed after approval", {
        total: review.total,
        currency: review.currency,
      });
      return;
    }

    if (run.payment_mode === "secure_handoff") {
      const liveView = await liveViewUrl(context.config, run.browserbase_session_id);
      await updateRun(context.supabase, run.id, {
        status: "payment_handoff_required",
        live_view_url: liveView,
        cart_total: review.total,
      });
      await recordEvent(
        context.supabase,
        context.userId,
        run.id,
        "payment_handoff_required",
        "User must enter payment or complete 3-D Secure in Browserbase Live View",
      );
      return;
    }

    const actions = await stagehand.observe(
      "Find only the single final button that submits the already-reviewed order. Do not find payment fields or account controls.",
      { serverCache: false },
    );
    const purchaseAction = finalPurchaseAction(actions);
    if (!purchaseAction) {
      const liveView = await liveViewUrl(context.config, run.browserbase_session_id);
      await updateRun(context.supabase, run.id, {
        status: "payment_handoff_required",
        live_view_url: liveView,
      });
      await recordEvent(context.supabase, context.userId, run.id, "payment_handoff_required", "Final purchase control was ambiguous or unavailable");
      return;
    }

    await stagehand.act(purchaseAction);
    const confirmation = await stagehand.extract(
      "Determine whether the order was placed, its order number and charged total, and whether 3-D Secure, an OTP, or other user action is still required. Never extract payment credentials or codes.",
      confirmationSchema,
    );

    if (!confirmation.orderPlaced || confirmation.requiresUserAction) {
      const liveView = await liveViewUrl(context.config, run.browserbase_session_id);
      await updateRun(context.supabase, run.id, {
        status: "payment_handoff_required",
        live_view_url: liveView,
        result: { confirmation },
      });
      return;
    }

    await updateRun(context.supabase, run.id, {
      status: "completed",
      completed_at: new Date().toISOString(),
      result: { confirmation },
    });
    await recordEvent(context.supabase, context.userId, run.id, "order_completed", "Merchant confirmed the order", {
      orderNumber: confirmation.orderNumber,
      chargedTotal: confirmation.chargedTotal,
      currency: confirmation.currency,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown checkout error";
    await updateRun(context.supabase, run.id, { status: "failed", error_message: message });
    await recordEvent(context.supabase, context.userId, run.id, "run_failed", message);
  } finally {
    await stagehand.close().catch(() => undefined);
  }
}
