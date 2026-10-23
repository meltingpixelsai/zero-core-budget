import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../lib/supabase-client.js";
import { randomUUID } from "crypto";

interface ReportSpendInput {
  agent_id: string;
  service_id: string;
  amount_usd: number;
  category: string;
  outcome_success?: boolean;
  value_received?: string;
}

interface ReportSpendResult {
  report_id: string;
  agent_id: string;
  remaining_daily: number;
  remaining_weekly: number;
}

/** Record a spend for `ownerWallet`'s agent and return its remaining budget */
export async function reportSpend(
  input: ReportSpendInput,
  ownerWallet: string,
  sb: SupabaseClient = getSupabase()
): Promise<ReportSpendResult> {
  const reportId = `spd_${randomUUID().slice(0, 12)}`;

  // Insert spending record
  const { error } = await sb.from("spending_history").insert({
    owner_wallet: ownerWallet,
    agent_id: input.agent_id,
    service_id: input.service_id,
    amount_usd: input.amount_usd,
    category: input.category,
    outcome_success: input.outcome_success ?? null,
    value_received: input.value_received ?? null,
  });

  if (error) throw new Error(`Failed to record spend: ${error.message}`);

  // Get remaining budgets
  const { data: budget } = await sb
    .from("agent_budgets")
    .select("daily_limit_usd, weekly_limit_usd")
    .eq("owner_wallet", ownerWallet)
    .eq("agent_id", input.agent_id)
    .single();

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const weekStart = new Date();
  weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
  weekStart.setUTCHours(0, 0, 0, 0);

  const [dailyRes, weeklyRes] = await Promise.all([
    sb
      .from("spending_history")
      .select("amount_usd")
      .eq("owner_wallet", ownerWallet)
      .eq("agent_id", input.agent_id)
      .gte("created_at", todayStart.toISOString()),
    sb
      .from("spending_history")
      .select("amount_usd")
      .eq("owner_wallet", ownerWallet)
      .eq("agent_id", input.agent_id)
      .gte("created_at", weekStart.toISOString()),
  ]);

  const dailySpent = (dailyRes.data ?? []).reduce((s, r) => s + Number(r.amount_usd), 0);
  const weeklySpent = (weeklyRes.data ?? []).reduce((s, r) => s + Number(r.amount_usd), 0);

  return {
    report_id: reportId,
    agent_id: input.agent_id,
    remaining_daily: Math.max(0, (budget?.daily_limit_usd ?? 0) - dailySpent),
    remaining_weekly: Math.max(0, (budget?.weekly_limit_usd ?? 0) - weeklySpent),
  };
}
