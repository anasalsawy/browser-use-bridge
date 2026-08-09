import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateRunInput } from "./schemas.js";

export type ShoppingRunRecord = {
  id: string;
  user_id: string;
  list_id: string;
  merchant_url: string;
  status: string;
  payment_mode: "saved_merchant" | "secure_handoff";
  browserbase_context_id: string | null;
  browserbase_session_id: string | null;
  live_view_url: string | null;
  cart_total: number | null;
  currency: string;
  approved_maximum: number | null;
  error_message: string | null;
  result: Record<string, unknown>;
};

function assertData<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message);
  if (data === null) throw new Error("Supabase returned no data");
  return data;
}

export async function createRun(
  supabase: SupabaseClient,
  userId: string,
  input: CreateRunInput,
): Promise<ShoppingRunRecord> {
  const { data, error } = await supabase
    .from("shopping_runs")
    .insert({
      user_id: userId,
      list_id: input.listId,
      merchant_url: input.merchantUrl,
      status: "queued",
      payment_mode: input.paymentMode,
      browserbase_context_id: input.browserbaseContextId ?? null,
      currency: input.currency,
      requested_budget: input.budget,
      request_payload: { items: input.items },
    })
    .select("*")
    .single();

  return assertData(data as ShoppingRunRecord | null, error);
}

export async function getRun(
  supabase: SupabaseClient,
  runId: string,
): Promise<ShoppingRunRecord | null> {
  const { data, error } = await supabase
    .from("shopping_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as ShoppingRunRecord | null;
}

export async function updateRun(
  supabase: SupabaseClient,
  runId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from("shopping_runs").update(patch).eq("id", runId);
  if (error) throw new Error(error.message);
}

export async function recordEvent(
  supabase: SupabaseClient,
  userId: string,
  runId: string,
  eventType: string,
  message: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabase.from("shopping_events").insert({
    user_id: userId,
    run_id: runId,
    event_type: eventType,
    message,
    metadata,
  });
  if (error) throw new Error(error.message);
}

export async function approveRun(
  supabase: SupabaseClient,
  userId: string,
  run: ShoppingRunRecord,
  approvedMaximum: number,
  currency: string,
): Promise<void> {
  if (run.currency !== currency) throw new Error("Approval currency does not match the run");
  if (run.cart_total === null) throw new Error("The cart total is not ready");
  if (approvedMaximum < run.cart_total) throw new Error("Approved maximum is below the cart total");

  const { error: approvalError } = await supabase.from("shopping_approvals").insert({
    user_id: userId,
    run_id: run.id,
    approved_maximum: approvedMaximum,
    currency,
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  if (approvalError) throw new Error(approvalError.message);

  await updateRun(supabase, run.id, {
    approved_maximum: approvedMaximum,
    approved_at: new Date().toISOString(),
    status: "approved",
  });
}
