import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { registerAgent } from "./registration.js";
import { checkSpend } from "./budget-check.js";
import { reportSpend } from "./spending.js";
import { getSpendingReport } from "./analytics.js";

interface Call {
  table: string;
  op: "select" | "insert" | "upsert";
  filters: Array<[string, unknown]>;
  payload?: unknown;
  options?: unknown;
}

/** A query-builder stand-in that records every table, filter and write. */
function fakeSupabase(rows: Record<string, unknown[]> = {}) {
  const calls: Call[] = [];
  const sb = {
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      calls.push(call);
      const result = () => ({ data: rows[table] ?? [], error: null });
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          call.filters.push([column, value]);
          return builder;
        },
        gte: () => builder,
        order: () => builder,
        limit: () => builder,
        insert: (payload: unknown) => {
          call.op = "insert";
          call.payload = payload;
          return Promise.resolve({ error: null });
        },
        upsert: (payload: unknown, options: unknown) => {
          call.op = "upsert";
          call.payload = payload;
          call.options = options;
          return Promise.resolve({ error: null });
        },
        single: () => {
          const data = (rows[table] ?? [])[0] ?? null;
          return Promise.resolve({ data, error: data ? null : { message: "no rows" } });
        },
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
  };
  return { sb: sb as unknown as SupabaseClient, calls };
}

const OWNER = "OwnerWallet1111111111111111111111111111111111";

/** Every read or write that names an agent must also name the owner wallet. */
function assertOwnerScoped(calls: Call[]): void {
  for (const call of calls) {
    const namesAgent =
      call.filters.some(([column]) => column === "agent_id") ||
      (call.op !== "select" && (call.payload as { agent_id?: unknown } | undefined)?.agent_id !== undefined);
    if (!namesAgent) continue;
    if (call.op === "select") {
      assert.ok(
        call.filters.some(([column, value]) => column === "owner_wallet" && value === OWNER),
        `${call.table} read by agent_id without owner_wallet`,
      );
    } else {
      assert.equal((call.payload as { owner_wallet?: unknown }).owner_wallet, OWNER, `${call.table} ${call.op} without owner_wallet`);
    }
  }
}

test("register_agent stores the paying wallet as owner and upserts per (owner, agent_id)", async () => {
  const { sb, calls } = fakeSupabase();
  const result = await registerAgent({ agent_id: "bot-1", daily_limit_usd: 1, weekly_limit_usd: 5 }, OWNER, sb);
  assert.equal(result.owner_wallet, OWNER);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, "upsert");
  assert.deepEqual(calls[0].options, { onConflict: "owner_wallet,agent_id" });
  assertOwnerScoped(calls);
});

test("check_spend reads only the paying wallet's agent and spending", async () => {
  const { sb, calls } = fakeSupabase({
    agent_budgets: [{ daily_limit_usd: 1, weekly_limit_usd: 5, category_limits: {} }],
    spending_history: [],
  });
  const result = await checkSpend({ agent_id: "bot-1", service_id: "svc", amount_usd: 0.01, category: "data" }, OWNER, sb);
  assert.equal(result.approved, true);
  assertOwnerScoped(calls);
  assert.ok(calls.filter((c) => c.filters.some(([column]) => column === "owner_wallet")).length >= 5);
});

test("check_spend for an agent this wallet never registered is not approved", async () => {
  const { sb } = fakeSupabase({ agent_budgets: [] });
  const result = await checkSpend({ agent_id: "someone-else", service_id: "svc", amount_usd: 0.01, category: "data" }, OWNER, sb);
  assert.equal(result.approved, false);
  assert.match(result.reason, /not registered for this wallet/);
});

test("report_spend records the owner wallet and scopes its reads", async () => {
  const { sb, calls } = fakeSupabase({ agent_budgets: [{ daily_limit_usd: 1, weekly_limit_usd: 5 }], spending_history: [] });
  await reportSpend({ agent_id: "bot-1", service_id: "svc", amount_usd: 0.01, category: "data" }, OWNER, sb);
  const insert = calls.find((c) => c.op === "insert");
  assert.ok(insert, "spend inserted");
  assert.equal((insert.payload as { owner_wallet: string }).owner_wallet, OWNER);
  assertOwnerScoped(calls);
});

test("get_spending_report reads only the paying wallet's agent", async () => {
  const { sb, calls } = fakeSupabase({ spending_history: [], agent_budgets: [] });
  await getSpendingReport({ agent_id: "bot-1", period: "week" }, OWNER, sb);
  assertOwnerScoped(calls);
  assert.ok(calls.length >= 2);
});
