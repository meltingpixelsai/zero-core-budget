import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createMcpPaidHandler } from "mcpay/handler";
import { z } from "zod";
import { config } from "./config.js";
import { registerDiscoveryRoutes } from "./discovery.js";
import { landingHtml, devHtml } from "./landing.js";
import { registerAgent } from "./tools/registration.js";
import { checkSpend } from "./tools/budget-check.js";
import { reportSpend } from "./tools/spending.js";
import { getSpendingReport } from "./tools/analytics.js";
import { createSettleFirstPaidTools, type SettleFirstConfig, type X402Settlement } from "./lib/x402-settle-first.js";
import { mcpRequestProblem } from "./lib/request-guard.js";

// ── Shared tool callback helpers ─────────────────────────────

function toolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function toolError(err: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true as const,
  };
}

/**
 * The wallet whose payment settled for this call. Every agent_id belongs to the
 * wallet that registered it, so this wallet is the only one whose agents a call
 * can read or change.
 */
function payingWallet(extra: unknown): string | null {
  const payer = (extra as { x402Settlement?: X402Settlement } | undefined)?.x402Settlement?.payer;
  return typeof payer === "string" && payer.length > 0 ? payer : null;
}

const NO_PAYER = "The payment settled without naming the paying wallet, so the agent cannot be identified";

const AGENT_ID_DESCRIPTION =
  "Your agent's name. It belongs to the wallet you pay from: only calls paid from that wallet can read or change it";

// ── Free tool data ───────────────────────────────────────────

function listTools() {
  return {
    server: "harvey-budget",
    version: "1.0.0",
    payment: { network: config.payment.network, currency: config.payment.currency, method: "x402" },
    tools: [
      { name: "list_tools", description: "List all tools with pricing", price: "FREE" },
      { name: "health", description: "Server status and payment config", price: "FREE" },
      { name: "register_agent", description: "Register agent with budget limits (owned by the paying wallet)", price: "$0.001" },
      { name: "check_spend", description: "Pre-spend budget approval check", price: "$0.001" },
      { name: "report_spend", description: "Record a spend with outcome", price: "$0.001" },
      { name: "get_spending_report", description: "Spending analytics with ROI", price: "$0.005" },
    ],
  };
}

function health() {
  return {
    status: "ok",
    server: "harvey-budget",
    version: "1.0.0",
    uptime: Math.floor(process.uptime()),
    payment: {
      network: config.payment.network,
      currency: config.payment.currency,
      wallet: config.payment.wallet,
      facilitator: config.payment.facilitator,
      method: "x402",
    },
    capabilities: ["budget-check", "spend-tracking", "spending-analytics"],
  };
}

// ── Tool registration ────────────────────────────────────────
// Server typed as `any` because mcpay bundles its own @modelcontextprotocol/sdk
// version, making its McpServer type incompatible at compile time.

/* eslint-disable @typescript-eslint/no-explicit-any */

function registerFreeTools(server: any): void {
  server.tool(
    "list_tools",
    "List all available Harvey Budget tools with pricing and input requirements. Use this for discovery.",
    {},
    async () => toolResult(listTools())
  );

  server.tool(
    "health",
    "Check Harvey Budget server status, uptime, and payment network configuration.",
    {},
    async () => toolResult(health())
  );
}

// ── x402 Paid Handler ────────────────────────────────────────

const x402Config: SettleFirstConfig = {
  facilitator: {
    url: config.payment.facilitator as `${string}://${string}`,
  },
  recipient: {
    svm: {
      address: config.payment.wallet,
      isTestnet: false,
    },
  },
};

// Paid tools take the payment (claim once, verify, settle) before they run.
// mcpay's own paidTool runs the tool first and settles after, which gives
// unsettled payments the tool for free. See src/lib/x402-settle-first.ts.
const settleFirst = createSettleFirstPaidTools(x402Config);

const paidHandler = createMcpPaidHandler(
  (server) => {
    registerFreeTools(server);
    const paidTool = settleFirst(server);

    paidTool(
      "register_agent",
      "Register an agent with daily and weekly budget limits, or update them. The agent_id belongs to the wallet that pays for this call: call check_spend, report_spend and get_spending_report from the same wallet.",
      "$0.001",
      {
        agent_id: z.string().describe(AGENT_ID_DESCRIPTION),
        daily_limit_usd: z.number().min(0.001).max(10000).describe("Maximum daily spending in USD"),
        weekly_limit_usd: z.number().min(0.001).max(100000).describe("Maximum weekly spending in USD"),
        category_limits: z.record(z.number()).optional().describe("Optional per-category weekly limits (e.g. {security: 1.0, content: 2.0})"),
      },
      {},
      async ({ agent_id, daily_limit_usd, weekly_limit_usd, category_limits }: {
        agent_id: string;
        daily_limit_usd: number;
        weekly_limit_usd: number;
        category_limits?: Record<string, number>;
      }, extra: unknown) => {
        const owner = payingWallet(extra);
        if (!owner) return toolError(NO_PAYER);
        try {
          return toolResult(await registerAgent({ agent_id, daily_limit_usd, weekly_limit_usd, category_limits }, owner));
        } catch (err) {
          return toolError(err);
        }
      }
    );

    paidTool(
      "check_spend",
      "Pre-spend budget approval check. Verifies daily/weekly/category limits, estimates ROI from your own past spends with this service, and suggests cheaper alternatives you have used. Call this BEFORE paying for any service.",
      "$0.001",
      {
        agent_id: z.string().describe(AGENT_ID_DESCRIPTION + " (register it first)"),
        service_id: z.string().describe("Service you want to pay for (e.g. 'harvey-tools/scrape_url')"),
        amount_usd: z.number().min(0).describe("Amount you're about to spend in USD"),
        category: z.enum(["security", "trading", "social", "content", "data", "infrastructure", "other"]).describe("Spending category"),
      },
      {},
      async ({ agent_id, service_id, amount_usd, category }: {
        agent_id: string;
        service_id: string;
        amount_usd: number;
        category: string;
      }, extra: unknown) => {
        const owner = payingWallet(extra);
        if (!owner) return toolError(NO_PAYER);
        try {
          return toolResult(await checkSpend({ agent_id, service_id, amount_usd, category }, owner));
        } catch (err) {
          return toolError(err);
        }
      }
    );

    paidTool(
      "report_spend",
      "Record a completed spend with optional outcome tracking. Call this AFTER paying for a service to track spending and build ROI history.",
      "$0.001",
      {
        agent_id: z.string().describe(AGENT_ID_DESCRIPTION),
        service_id: z.string().describe("Service that was used"),
        amount_usd: z.number().min(0).describe("Amount spent in USD"),
        category: z.enum(["security", "trading", "social", "content", "data", "infrastructure", "other"]).describe("Spending category"),
        outcome_success: z.boolean().optional().describe("Whether the service call succeeded"),
        value_received: z.string().optional().describe("Description of value received"),
      },
      {},
      async ({ agent_id, service_id, amount_usd, category, outcome_success, value_received }: {
        agent_id: string;
        service_id: string;
        amount_usd: number;
        category: string;
        outcome_success?: boolean;
        value_received?: string;
      }, extra: unknown) => {
        const owner = payingWallet(extra);
        if (!owner) return toolError(NO_PAYER);
        try {
          return toolResult(await reportSpend({ agent_id, service_id, amount_usd, category, outcome_success, value_received }, owner));
        } catch (err) {
          return toolError(err);
        }
      }
    );

    paidTool(
      "get_spending_report",
      "Detailed spending analytics report. Returns total spent, category breakdown, top services with ROI, and optimization recommendations. Use to understand spending patterns and find inefficiencies.",
      "$0.005",
      {
        agent_id: z.string().describe(AGENT_ID_DESCRIPTION),
        period: z.enum(["day", "week", "month"]).describe("Report period"),
      },
      {},
      async ({ agent_id, period }: { agent_id: string; period: "day" | "week" | "month" }, extra: unknown) => {
        const owner = payingWallet(extra);
        if (!owner) return toolError(NO_PAYER);
        try {
          return toolResult(await getSpendingReport({ agent_id, period }, owner));
        } catch (err) {
          return toolError(err);
        }
      }
    );
  },
  x402Config,
  {
    serverInfo: { name: "harvey-budget", version: "1.0.0" },
  },
  {
    maxDuration: 300,
    verboseLogs: process.env.NODE_ENV !== "production",
    // No Redis here: without this, an anonymous GET /sse or POST /message
    // throws "redisUrl is required" in an unawaited promise and kills the process.
    disableSse: true,
  }
);

// ── Hono HTTP Server ─────────────────────────────────────────

// A rejected promise inside the MCP transport must not stop the process and every
// in-flight call with it (a paid call cut off after settlement is charged).
process.on("unhandledRejection", (reason) => {
  console.error("[mcp] unhandled rejection, process kept alive:", reason);
});

const app = new Hono();

// Health + pricing endpoints (outside MCP, for monitoring/discovery)
app.get("/health", (c) => c.json(health()));
app.get("/pricing", (c) => c.json(listTools()));

// Agent discovery routes
registerDiscoveryRoutes(app);

// Landing pages for human visitors
app.get("/", (c) => c.html(landingHtml()));
app.get("/dev", (c) => c.html(devHtml()));

// MCP handler - x402 only
// Requests mcp-handler would throw on in a promise nobody awaits (a body that is
// not JSON, or JSON too deep to re-serialize) or never answer (PUT, PATCH, HEAD)
// get a JSON-RPC error here instead. See src/lib/request-guard.ts.
app.all("*", async (c) => {
  const problem = mcpRequestProblem(c.req.method, c.req.method === "POST" ? await c.req.raw.clone().text() : null);
  if (problem) {
    return c.json({ jsonrpc: "2.0", error: { code: problem.code, message: problem.message }, id: null }, problem.status);
  }
  return paidHandler(c.req.raw);
});

// ── Start ────────────────────────────────────────────────────

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`Harvey Budget MCP server running on port ${config.port}`);
  console.log(`  MCP endpoint: http://localhost:${config.port}/`);
  console.log(`  Health: http://localhost:${config.port}/health`);
  console.log(`  Pricing: http://localhost:${config.port}/pricing`);
  console.log(`  Auth: x402 USDC only`);
  console.log(`  Payment wallet: ${config.payment.wallet}`);
  console.log(`  Facilitator: ${config.payment.facilitator}`);
  console.log(`  Network: ${config.payment.network} (${config.payment.currency})`);
});
