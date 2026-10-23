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
import { createSettleFirstPaidTools, type SettleFirstConfig } from "./lib/x402-settle-first.js";

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

// ── Free tool data ───────────────────────────────────────────

function listTools() {
  return {
    server: "harvey-budget",
    version: "1.0.0",
    payment: { network: config.payment.network, currency: config.payment.currency, method: "x402" },
    tools: [
      { name: "list_tools", description: "List all tools with pricing", price: "FREE" },
      { name: "health", description: "Server status and payment config", price: "FREE" },
      { name: "register_agent", description: "Register agent with budget limits", price: "FREE" },
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

  server.tool(
    "register_agent",
    "Register an agent with daily and weekly budget limits. Free tool - call this before using check_spend or report_spend. Upserts if agent already exists.",
    {
      agent_id: z.string().describe("Unique agent identifier (e.g. your wallet address or agent name)"),
      daily_limit_usd: z.number().min(0.001).max(10000).describe("Maximum daily spending in USD"),
      weekly_limit_usd: z.number().min(0.001).max(100000).describe("Maximum weekly spending in USD"),
      category_limits: z.record(z.number()).optional().describe("Optional per-category weekly limits (e.g. {security: 1.0, content: 2.0})"),
    },
    async ({ agent_id, daily_limit_usd, weekly_limit_usd, category_limits }: {
      agent_id: string;
      daily_limit_usd: number;
      weekly_limit_usd: number;
      category_limits?: Record<string, number>;
    }) => {
      try {
        return toolResult(await registerAgent({ agent_id, daily_limit_usd, weekly_limit_usd, category_limits }));
      } catch (err) {
        return toolError(err);
      }
    }
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
      "check_spend",
      "Pre-spend budget approval check. Verifies daily/weekly/category limits, estimates ROI from historical data, and suggests cheaper alternatives. Call this BEFORE paying for any service.",
      "$0.001",
      {
        agent_id: z.string().describe("Your agent identifier (must be registered first)"),
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
      }) => {
        try {
          return toolResult(await checkSpend({ agent_id, service_id, amount_usd, category }));
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
        agent_id: z.string().describe("Your agent identifier"),
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
      }) => {
        try {
          return toolResult(await reportSpend({ agent_id, service_id, amount_usd, category, outcome_success, value_received }));
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
        agent_id: z.string().describe("Your agent identifier"),
        period: z.enum(["day", "week", "month"]).describe("Report period"),
      },
      {},
      async ({ agent_id, period }: { agent_id: string; period: "day" | "week" | "month" }) => {
        try {
          return toolResult(await getSpendingReport({ agent_id, period }));
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
  }
);

// ── Hono HTTP Server ─────────────────────────────────────────

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
app.all("*", async (c) => {
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
