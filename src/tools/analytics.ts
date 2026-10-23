import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../lib/supabase-client.js";

interface SpendingReportInput {
  agent_id: string;
  period: "day" | "week" | "month";
}

interface CategoryBreakdown {
  category: string;
  total_usd: number;
  count: number;
  success_rate: number;
}

interface ServiceBreakdown {
  service_id: string;
  total_usd: number;
  count: number;
  success_rate: number;
  avg_cost: number;
}

interface SpendingReport {
  agent_id: string;
  period: string;
  total_spent_usd: number;
  total_transactions: number;
  overall_success_rate: number;
  by_category: CategoryBreakdown[];
  top_services: ServiceBreakdown[];
  recommendations: string[];
}

/** Generate a spending analytics report for `ownerWallet`'s agent */
export async function getSpendingReport(
  input: SpendingReportInput,
  ownerWallet: string,
  sb: SupabaseClient = getSupabase()
): Promise<SpendingReport> {

  // Calculate period start
  const now = new Date();
  let since: Date;
  if (input.period === "day") {
    since = new Date(now);
    since.setUTCHours(0, 0, 0, 0);
  } else if (input.period === "week") {
    since = new Date(now);
    since.setUTCDate(since.getUTCDate() - since.getUTCDay());
    since.setUTCHours(0, 0, 0, 0);
  } else {
    since = new Date(now);
    since.setUTCDate(1);
    since.setUTCHours(0, 0, 0, 0);
  }

  const { data: spending, error } = await sb
    .from("spending_history")
    .select("service_id, amount_usd, category, outcome_success, value_received, created_at")
    .eq("owner_wallet", ownerWallet)
    .eq("agent_id", input.agent_id)
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Spending query failed: ${error.message}`);

  const records = spending ?? [];
  const totalSpent = records.reduce((s, r) => s + Number(r.amount_usd), 0);
  const successes = records.filter((r) => r.outcome_success === true).length;
  const withOutcome = records.filter((r) => r.outcome_success !== null).length;
  const overallSuccessRate = withOutcome > 0 ? Math.round((successes / withOutcome) * 100) : 0;

  // Category breakdown
  const catMap = new Map<string, { total: number; count: number; successes: number; withOutcome: number }>();
  for (const r of records) {
    const cat = r.category || "other";
    const existing = catMap.get(cat) || { total: 0, count: 0, successes: 0, withOutcome: 0 };
    existing.total += Number(r.amount_usd);
    existing.count++;
    if (r.outcome_success !== null) {
      existing.withOutcome++;
      if (r.outcome_success) existing.successes++;
    }
    catMap.set(cat, existing);
  }

  const byCategory: CategoryBreakdown[] = Array.from(catMap.entries())
    .map(([category, stats]) => ({
      category,
      total_usd: Math.round(stats.total * 10000) / 10000,
      count: stats.count,
      success_rate: stats.withOutcome > 0 ? Math.round((stats.successes / stats.withOutcome) * 100) : 0,
    }))
    .sort((a, b) => b.total_usd - a.total_usd);

  // Service breakdown
  const svcMap = new Map<string, { total: number; count: number; successes: number; withOutcome: number }>();
  for (const r of records) {
    const existing = svcMap.get(r.service_id) || { total: 0, count: 0, successes: 0, withOutcome: 0 };
    existing.total += Number(r.amount_usd);
    existing.count++;
    if (r.outcome_success !== null) {
      existing.withOutcome++;
      if (r.outcome_success) existing.successes++;
    }
    svcMap.set(r.service_id, existing);
  }

  const topServices: ServiceBreakdown[] = Array.from(svcMap.entries())
    .map(([service_id, stats]) => ({
      service_id,
      total_usd: Math.round(stats.total * 10000) / 10000,
      count: stats.count,
      success_rate: stats.withOutcome > 0 ? Math.round((stats.successes / stats.withOutcome) * 100) : 0,
      avg_cost: Math.round((stats.total / stats.count) * 10000) / 10000,
    }))
    .sort((a, b) => b.total_usd - a.total_usd)
    .slice(0, 10);

  // Generate recommendations
  const recommendations: string[] = [];

  // Flag low-ROI services. service_id is caller-supplied stored text, so the
  // advice points at the top_services entry (where service_id is returned as
  // data) instead of interpolating that text into this server-authored prose.
  for (const [index, svc] of topServices.entries()) {
    if (svc.count >= 3 && svc.success_rate < 50) {
      recommendations.push(`Consider replacing the service at top_services[${index}] - only ${svc.success_rate}% success rate over ${svc.count} calls`);
    }
  }

  // Flag overspending categories
  const { data: budget } = await sb
    .from("agent_budgets")
    .select("daily_limit_usd, weekly_limit_usd, category_limits")
    .eq("owner_wallet", ownerWallet)
    .eq("agent_id", input.agent_id)
    .single();

  if (budget) {
    const categoryLimits = (budget.category_limits || {}) as Record<string, number>;
    for (const cat of byCategory) {
      const limit = categoryLimits[cat.category];
      if (limit && cat.total_usd > limit * 0.8) {
        recommendations.push(`Category '${cat.category}' at ${Math.round((cat.total_usd / limit) * 100)}% of weekly limit`);
      }
    }

    if (input.period === "day" && totalSpent > budget.daily_limit_usd * 0.8) {
      recommendations.push(`Daily spending at ${Math.round((totalSpent / budget.daily_limit_usd) * 100)}% of limit`);
    }
  }

  if (recommendations.length === 0) {
    recommendations.push("Spending looks healthy - no issues detected");
  }

  return {
    agent_id: input.agent_id,
    period: input.period,
    total_spent_usd: Math.round(totalSpent * 10000) / 10000,
    total_transactions: records.length,
    overall_success_rate: overallSuccessRate,
    by_category: byCategory,
    top_services: topServices,
    recommendations,
  };
}
