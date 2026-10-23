import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../lib/supabase-client.js";

interface RegisterInput {
  agent_id: string;
  daily_limit_usd: number;
  weekly_limit_usd: number;
  category_limits?: Record<string, number>;
}

interface RegisterResult {
  agent_id: string;
  owner_wallet: string;
  daily_limit_usd: number;
  weekly_limit_usd: number;
  category_limits: Record<string, number>;
  registered: boolean;
}

/**
 * Register an agent with budget limits, or update them. The agent_id belongs to
 * `ownerWallet`, the wallet whose payment settled for this call, so another
 * wallet can never read or change it.
 */
export async function registerAgent(
  input: RegisterInput,
  ownerWallet: string,
  sb: SupabaseClient = getSupabase()
): Promise<RegisterResult> {
  const { error } = await sb.from("agent_budgets").upsert(
    {
      owner_wallet: ownerWallet,
      agent_id: input.agent_id,
      daily_limit_usd: input.daily_limit_usd,
      weekly_limit_usd: input.weekly_limit_usd,
      category_limits: input.category_limits || {},
      updated_at: new Date().toISOString(),
    },
    { onConflict: "owner_wallet,agent_id" }
  );

  if (error) throw new Error(`Registration failed: ${error.message}`);

  return {
    agent_id: input.agent_id,
    owner_wallet: ownerWallet,
    daily_limit_usd: input.daily_limit_usd,
    weekly_limit_usd: input.weekly_limit_usd,
    category_limits: input.category_limits || {},
    registered: true,
  };
}
