import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { registerAgent } from "./registration.js";
import { checkSpend } from "./budget-check.js";
import { reportSpend } from "./spending.js";
import { getSpendingReport } from "./analytics.js";

type Row = Record<string, unknown>;

interface Call {
  table: string;
  op: "select" | "insert" | "upsert";
  filters: Array<[string, unknown]>;
  payload?: unknown;
  options?: unknown;
}

/**
 * A query-builder stand-in over in-memory rows. `eq` filters are applied, so a
 * query that forgets the owner filter really does see other wallets' rows.
 * Date ranges, ordering and limits are not modelled (all rows count as recent).
 */
function fakeSupabase(rows: Record<string, Row[]> = {}) {
  const calls: Call[] = [];
  const sb = {
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      calls.push(call);
      const matching = () => (rows[table] ?? []).filter((row) => call.filters.every(([column, value]) => row[column] === value));
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          call.filters.push([column, value]);
          return builder;
        },
        gte: () => builder,
        order: () => builder,
        limit: () => builder,
        insert: (payload: Row) => {
          call.op = "insert";
          call.payload = payload;
          (rows[table] ??= []).push({ created_at: new Date().toISOString(), ...payload });
          return Promise.resolve({ error: null });
        },
        upsert: (payload: unknown, options: unknown) => {
          call.op = "upsert";
          call.payload = payload;
          call.options = options;
          return Promise.resolve({ error: null });
        },
        single: () => {
          const data = matching()[0] ?? null;
          return Promise.resolve({ data, error: data ? null : { message: "no rows" } });
        },
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: matching(), error: null }).then(resolve, reject),
      };
      return builder;
    },
  };
  return { sb: sb as unknown as SupabaseClient, calls };
}

const A = "WalletA111111111111111111111111111111111111";
const B = "WalletB111111111111111111111111111111111111";

/** Every read of the two Budget tables names the owner wallet. */
function assertEveryReadOwnerScoped(calls: Call[], owner: string): void {
  for (const call of calls.filter((c) => c.op === "select" && (c.table === "agent_budgets" || c.table === "spending_history"))) {
    assert.ok(
      call.filters.some(([column, value]) => column === "owner_wallet" && value === owner),
      `${call.table} read without owner_wallet=${owner}: ${JSON.stringify(call.filters)}`,
    );
  }
}

function spend(owner: string | null, agent: string, service: string, amount: number, ok: boolean | null, category = "data"): Row {
  return { owner_wallet: owner, agent_id: agent, service_id: service, amount_usd: amount, category, outcome_success: ok };
}

test("register_agent stores the paying wallet as owner and upserts per (owner, agent_id)", async () => {
  const { sb, calls } = fakeSupabase();
  const result = await registerAgent({ agent_id: "bot-1", daily_limit_usd: 1, weekly_limit_usd: 5 }, A, sb);
  assert.equal(result.owner_wallet, A);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, "upsert");
  assert.deepEqual(calls[0].options, { onConflict: "owner_wallet,agent_id" });
  assert.equal((calls[0].payload as Row).owner_wallet, A);
});

test("two wallets with the same agent_id have separate budgets", async () => {
  const fixture = () => ({
    agent_budgets: [
      { owner_wallet: A, agent_id: "bot", daily_limit_usd: 1, weekly_limit_usd: 5, category_limits: {} },
      { owner_wallet: B, agent_id: "bot", daily_limit_usd: 100, weekly_limit_usd: 500, category_limits: {} },
      { owner_wallet: null, agent_id: "bot", daily_limit_usd: 1000, weekly_limit_usd: 5000, category_limits: {} },
    ],
    spending_history: [spend(A, "bot", "svc", 0.9, true)],
  });
  const forA = fakeSupabase(fixture());
  const a = await checkSpend({ agent_id: "bot", service_id: "svc", amount_usd: 0.2, category: "data" }, A, forA.sb);
  assert.equal(a.approved, false, "A has 0.10 left today");
  assertEveryReadOwnerScoped(forA.calls, A);
  const forB = fakeSupabase(fixture());
  const b = await checkSpend({ agent_id: "bot", service_id: "svc", amount_usd: 0.2, category: "data" }, B, forB.sb);
  assert.equal(b.approved, true, "B's limits and spending are its own");
  assertEveryReadOwnerScoped(forB.calls, B);
});

test("a legacy registration without a wallet is invisible to every payer", async () => {
  const { sb } = fakeSupabase({ agent_budgets: [{ owner_wallet: null, agent_id: "old-bot", daily_limit_usd: 1, weekly_limit_usd: 5 }] });
  const result = await checkSpend({ agent_id: "old-bot", service_id: "svc", amount_usd: 0.01, category: "data" }, A, sb);
  assert.equal(result.approved, false);
  assert.match(result.reason, /not registered for this wallet/);
});

test("another wallet's failing reports cannot move this wallet's ROI estimate", async () => {
  const spends = [
    ...Array.from({ length: 50 }, () => spend(B, "spam", "svc", 0.001, false)),
    spend(A, "bot", "svc", 0.01, true),
    spend(A, "bot", "svc", 0.01, true),
    spend(A, "bot", "svc", 0.01, true),
  ];
  const { sb, calls } = fakeSupabase({
    agent_budgets: [{ owner_wallet: A, agent_id: "bot", daily_limit_usd: 10, weekly_limit_usd: 50, category_limits: {} }],
    spending_history: spends,
  });
  const result = await checkSpend({ agent_id: "bot", service_id: "svc", amount_usd: 0.01, category: "data" }, A, sb);
  assert.equal(result.roi_estimate, 100);
  assertEveryReadOwnerScoped(calls, A);
});

test("report_spend records the owner wallet and counts only that wallet's spending", async () => {
  const { sb, calls } = fakeSupabase({
    agent_budgets: [{ owner_wallet: A, agent_id: "bot", daily_limit_usd: 1, weekly_limit_usd: 5 }],
    spending_history: [spend(B, "bot", "svc", 0.9, true)],
  });
  const result = await reportSpend({ agent_id: "bot", service_id: "svc", amount_usd: 0.1, category: "data" }, A, sb);
  const insert = calls.find((c) => c.op === "insert");
  assert.equal((insert?.payload as Row).owner_wallet, A);
  assert.equal(result.remaining_daily, 0.9, "B's 0.90 does not count against A");
  assertEveryReadOwnerScoped(calls, A);
});

test("get_spending_report covers only the paying wallet's agent", async () => {
  const { sb, calls } = fakeSupabase({
    agent_budgets: [{ owner_wallet: A, agent_id: "bot", daily_limit_usd: 1, weekly_limit_usd: 5, category_limits: {} }],
    spending_history: [spend(A, "bot", "svc", 0.25, true), spend(B, "bot", "svc", 9, false)],
  });
  const report = await getSpendingReport({ agent_id: "bot", period: "week" }, A, sb);
  assert.equal(report.total_spent_usd, 0.25);
  assert.equal(report.total_transactions, 1);
  assertEveryReadOwnerScoped(calls, A);
});
