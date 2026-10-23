import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../lib/supabase-client.js";

interface CheckSpendInput {
  agent_id: string;
  service_id: string;
  amount_usd: number;
  category: string;
}

interface CheckSpendResult {
  approved: boolean;
  reason: string;
  remaining_daily: number;
  remaining_weekly: number;
  remaining_category: number | null;
  roi_estimate: number | null;
  cheaper_alternative: string | null;
}

/** Check if a spend is within budget. Pure math, no LLM. Reads only `ownerWallet`'s agent. */
export async function checkSpend(
  input: CheckSpendInput,
  ownerWallet: string,
  sb: SupabaseClient = getSupabase()
): Promise<CheckSpendResult> {

  // Get agent budget
  const { data: budget, error: budgetErr } = await sb
    .from("agent_budgets")
    .select("daily_limit_usd, weekly_limit_usd, category_limits")
    .eq("owner_wallet", ownerWallet)
    .eq("agent_id", input.agent_id)
    .single();

  if (budgetErr || !budget) {
    return {
      approved: false,
      reason: "Agent not registered for this wallet. Call register_agent first, paying from the same wallet.",
      remaining_daily: 0,
      remaining_weekly: 0,
      remaining_category: null,
      roi_estimate: null,
      cheaper_alternative: null,
    };
  }

  // Sum spending today
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const weekStart = new Date();
  weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
  weekStart.setUTCHours(0, 0, 0, 0);

  const [dailyRes, weeklyRes, categoryRes] = await Promise.all([
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
    sb
      .from("spending_history")
      .select("amount_usd")
      .eq("owner_wallet", ownerWallet)
      .eq("agent_id", input.agent_id)
      .eq("category", input.category)
      .gte("created_at", weekStart.toISOString()),
  ]);

  const dailySpent = (dailyRes.data ?? []).reduce((s, r) => s + Number(r.amount_usd), 0);
  const weeklySpent = (weeklyRes.data ?? []).reduce((s, r) => s + Number(r.amount_usd), 0);
  const categorySpent = (categoryRes.data ?? []).reduce((s, r) => s + Number(r.amount_usd), 0);

  const remainingDaily = budget.daily_limit_usd - dailySpent;
  const remainingWeekly = budget.weekly_limit_usd - weeklySpent;

  // Check category limit if set
  const categoryLimits = (budget.category_limits || {}) as Record<string, number>;
  const categoryLimit = categoryLimits[input.category];
  const remainingCategory = categoryLimit != null ? categoryLimit - categorySpent : null;

  // Determine approval
  const reasons: string[] = [];
  if (input.amount_usd > remainingDaily) {
    reasons.push(`Daily budget exceeded (remaining: $${remainingDaily.toFixed(4)})`);
  }
  if (input.amount_usd > remainingWeekly) {
    reasons.push(`Weekly budget exceeded (remaining: $${remainingWeekly.toFixed(4)})`);
  }
  if (remainingCategory !== null && input.amount_usd > remainingCategory) {
    reasons.push(`Category '${input.category}' budget exceeded (remaining: $${remainingCategory.toFixed(4)})`);
  }

  const approved = reasons.length === 0;

  // ROI from this wallet's own history with the service. Pooling every wallet's
  // rows let anyone poison the estimate with cheap failing reports.
  let roiEstimate: number | null = null;
  const { data: serviceHistory } = await sb
    .from("spending_history")
    .select("outcome_success, amount_usd")
    .eq("owner_wallet", ownerWallet)
    .eq("service_id", input.service_id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (serviceHistory && serviceHistory.length >= 3) {
    const successes = serviceHistory.filter((r) => r.outcome_success === true).length;
    roiEstimate = Math.round((successes / serviceHistory.length) * 100);
  }

  // Find cheaper alternative in same category
  let cheaperAlternative: string | null = null;
  const { data: alternatives } = await sb
    .from("spending_history")
    .select("service_id, amount_usd, outcome_success")
    .eq("owner_wallet", ownerWallet)
    .eq("agent_id", input.agent_id)
    .eq("category", input.category)
    .order("created_at", { ascending: false })
    .limit(100);

  if (alternatives && alternatives.length > 0) {
    const serviceAvgs = new Map<string, { total: number; count: number; successes: number }>();
    for (const alt of alternatives) {
      const existing = serviceAvgs.get(alt.service_id) || { total: 0, count: 0, successes: 0 };
      existing.total += Number(alt.amount_usd);
      existing.count++;
      if (alt.outcome_success) existing.successes++;
      serviceAvgs.set(alt.service_id, existing);
    }

    for (const [sid, stats] of serviceAvgs) {
      if (sid === input.service_id) continue;
      const avgCost = stats.total / stats.count;
      const successRate = stats.count >= 3 ? stats.successes / stats.count : 0;
      if (avgCost < input.amount_usd && successRate >= 0.7) {
        cheaperAlternative = `${sid} (avg $${avgCost.toFixed(4)}, ${Math.round(successRate * 100)}% success)`;
        break;
      }
    }
  }

  return {
    approved,
    reason: approved ? "Within budget" : reasons.join("; "),
    remaining_daily: Math.max(0, remainingDaily - (approved ? input.amount_usd : 0)),
    remaining_weekly: Math.max(0, remainingWeekly - (approved ? input.amount_usd : 0)),
    remaining_category: remainingCategory !== null
      ? Math.max(0, remainingCategory - (approved ? input.amount_usd : 0))
      : null,
    roi_estimate: roiEstimate,
    cheaper_alternative: cheaperAlternative,
  };
}
