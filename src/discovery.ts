import type { Hono } from "hono";

/** Register all agent discovery routes on the Hono app */
export function registerDiscoveryRoutes(app: Hono): void {
  app.get("/llms.txt", (c) => {
    return c.text(LLMS_TXT, 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    });
  });

  const agentCardHandler = (c: any) =>
    c.json(AGENT_CARD, 200, {
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    });
  app.get("/.well-known/agent-card.json", agentCardHandler);
  app.get("/.well-known/agent.json", agentCardHandler);


  app.get("/.well-known/mcp.json", (c) => {
    return c.json(MCP_CARD, 200, {
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    });
  });

  app.get("/.well-known/mcp/server-card.json", (c) => {
    return c.json(MCP_CARD, 200, {
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    });
  });
}
// ── Static Content ────────────────────────────────────────────

const LLMS_TXT = `# Harvey Budget - Agent Spending Management MCP Server

> MCP server for AI agents. Budget tracking, spend approval, ROI analysis, and intelligent recommendations.
> Pure logic - no LLM dependency. Pay per call with USDC via x402 micropayments. No account needed.
> Built by MeltingPixels.

## Tools (6 total, 2 free + 4 paid)
- [list_tools](https://budget.rugslayer.com/mcp): List all tools with pricing (FREE)
- [health](https://budget.rugslayer.com/mcp): Server status and payment config (FREE)
- [register_agent](https://budget.rugslayer.com/mcp): Register agent with budget limits ($0.001; the agent_id belongs to the paying wallet)
- [check_spend](https://budget.rugslayer.com/mcp): Check if a spend is within budget ($0.001)
- [report_spend](https://budget.rugslayer.com/mcp): Record a spend with outcome ($0.001)
- [get_spending_report](https://budget.rugslayer.com/mcp): Spending analytics with ROI and recommendations ($0.005)

## Connection
- [MCP Endpoint](https://budget.rugslayer.com/mcp): Connect directly via MCP
- [npm](https://www.npmjs.com/package/@meltingpixels/harvey-budget): @meltingpixels/harvey-budget
- [Claude Code](https://budget.rugslayer.com/mcp): claude mcp add harvey-budget --transport http https://budget.rugslayer.com/mcp

## Authentication
- [x402 USDC](https://budget.rugslayer.com/mcp): Pay per call on Solana, no account needed. Each agent_id belongs to the wallet that registered it; only calls paid from that wallet can read or change it.

## Pricing
- register_agent: $0.001 USDC per call
- check_spend: $0.001 USDC per call
- report_spend: $0.001 USDC per call
- get_spending_report: $0.005 USDC per call
`;

const AGENT_CARD = {
  name: "Harvey Budget",
  description:
    "MCP server for AI agent spending management. Budget tracking, spend approval, ROI analysis, and intelligent recommendations. Pure logic with no LLM dependency. Pay per call with USDC via x402.",
  version: "1.0.0",
  supportedInterfaces: [
    {
      url: "https://budget.rugslayer.com/mcp",
      protocolBinding: "HTTP+JSON",
      protocolVersion: "0.3",
    },
  ],
  provider: {
    organization: "MeltingPixels",
    url: "https://rugslayer.com",
  },
  iconUrl: "https://rugslayer.com/icon.svg",
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  securitySchemes: {
    x402: {
      httpSecurityScheme: {
        scheme: "x402",
        bearerFormat: "USDC micropayment on Solana",
      },
    },
  },
  defaultInputModes: ["application/json"],
  defaultOutputModes: ["application/json"],
  skills: [
    {
      id: "budget-check",
      name: "Budget Check",
      description: "Pre-spend approval check - verifies daily/weekly/category limits before an agent pays for a service.",
      tags: ["budget", "approval", "limits", "spending"],
      examples: ["Can I afford this API call?", "Check my budget before spending"],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "spend-tracking",
      name: "Spend Tracking",
      description: "Record service spending with outcomes for ROI tracking.",
      tags: ["spending", "tracking", "outcomes", "roi"],
      examples: ["Record this spend", "Log that API call cost $0.01"],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "spending-analytics",
      name: "Spending Analytics",
      description: "Detailed spending reports with category breakdown, ROI by service, and optimization recommendations.",
      tags: ["analytics", "reporting", "roi", "optimization"],
      examples: ["Show my spending this week", "What's my ROI by service?"],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
  ],
};

const MCP_CARD = {
  mcp_version: "2025-11-25",
  name: "harvey-budget",
  display_name: "Harvey Budget - Agent Spending Management",
  description:
    "MCP server for AI agents. Budget tracking, spend approval, ROI analysis, and intelligent recommendations. Pure logic with no LLM dependency. Pay per call with USDC via x402.",
  version: "1.0.0",
  vendor: "MeltingPixels",
  homepage: "https://budget.rugslayer.com",
  endpoints: {
    streamable_http: "https://budget.rugslayer.com/mcp",
  },
  pricing: {
    model: "paid",
    free_tools: ["list_tools", "health"],
    paid_tools: {
      register_agent: "$0.001",
      check_spend: "$0.001",
      report_spend: "$0.001",
      get_spending_report: "$0.005",
    },
    payment_methods: ["x402_usdc_solana"],
  },
  rate_limits: {
    x402: "unlimited (pay per call)",
  },
  tools: [
    {
      name: "list_tools",
      description: "List all available tools with pricing and input requirements.",
      price: "FREE",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "health",
      description: "Server status, uptime, and payment network configuration.",
      price: "FREE",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "register_agent",
      description: "Register an agent with daily/weekly budget limits and optional per-category limits. The agent_id belongs to the paying wallet.",
      price: "$0.001 USDC",
      input_schema: {
        type: "object",
        required: ["agent_id", "daily_limit_usd", "weekly_limit_usd"],
        properties: {
          agent_id: { type: "string", description: "Agent name, owned by the paying wallet" },
          daily_limit_usd: { type: "number", description: "Maximum daily spending in USD" },
          weekly_limit_usd: { type: "number", description: "Maximum weekly spending in USD" },
          category_limits: { type: "object", description: "Per-category weekly spending limits" },
        },
      },
    },
    {
      name: "check_spend",
      description: "Pre-spend approval check. Verifies budget, returns ROI estimate and cheaper alternatives.",
      price: "$0.001 USDC",
      input_schema: {
        type: "object",
        required: ["agent_id", "service_id", "amount_usd", "category"],
        properties: {
          agent_id: { type: "string", description: "Agent identifier" },
          service_id: { type: "string", description: "Service to pay for" },
          amount_usd: { type: "number", description: "Amount in USD" },
          category: { type: "string", description: "Spending category: security, trading, social, content, data, infrastructure, other" },
        },
      },
    },
    {
      name: "report_spend",
      description: "Record a completed spend with optional outcome tracking.",
      price: "$0.001 USDC",
      input_schema: {
        type: "object",
        required: ["agent_id", "service_id", "amount_usd", "category"],
        properties: {
          agent_id: { type: "string", description: "Agent identifier" },
          service_id: { type: "string", description: "Service that was used" },
          amount_usd: { type: "number", description: "Amount spent in USD" },
          category: { type: "string", description: "Spending category" },
          outcome_success: { type: "boolean", description: "Whether the service call succeeded" },
          value_received: { type: "string", description: "Description of value received" },
        },
      },
    },
    {
      name: "get_spending_report",
      description: "Detailed spending analytics with category breakdown, service ROI, and optimization recommendations.",
      price: "$0.005 USDC",
      input_schema: {
        type: "object",
        required: ["agent_id", "period"],
        properties: {
          agent_id: { type: "string", description: "Agent identifier" },
          period: { type: "string", description: "Report period: day, week, or month" },
        },
      },
    },
  ],
  install: {
    npm: "npx -y @meltingpixels/harvey-budget",
    claude_code: "claude mcp add harvey-budget --transport http https://budget.rugslayer.com/mcp",
    claude_desktop: {
      command: "npx",
      args: ["-y", "@meltingpixels/harvey-budget"],
      env: {},
    },
  },
  categories: ["budget-management", "spending-analytics", "agent-infrastructure"],
  tags: ["budget", "spending", "roi", "analytics", "x402", "usdc", "agent-commerce"],
};
