// hive-mcp-server.ts – fully corrected version

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

// ---------------------------------------------------------------------------
// 1. MCP SERVER SET‑UP
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "hive-mcp-server",
  version: "1.0.0"
});

// Utility: extract Hive API token from the incoming request context
type Extra = { headers?: Record<string, string>; args: any };
function getHiveToken(extra: Extra): string {
  const hdr = extra?.headers?.authorization || extra?.headers?.Authorization;
  if (hdr?.startsWith("Bearer ")) return hdr.slice(7);
  const token = process.env.HIVE_API_TOKEN;
  if (!token) throw new Error("No Hive API token provided");
  return token;
}

const HIVE_API_BASE = "https://app.hive.com/api/v1";

// ---------------------------------------------------------------------------
// 2. TOOL DEFINITIONS (plain objects exported for the inspector)
// ---------------------------------------------------------------------------

export const getActionTool = {
  name: "get_action",
  description: "Retrieve a single Hive action by its ID.",
  inputSchema: {
    type: "object",
    properties: { actionId: { type: "string" } },
    required: ["actionId"]
  },
  annotations: { readOnlyHint: true, idempotentHint: true }
};

export const listActionsTool = {
  name: "list_actions",
  description: "List actions in a workspace.",
  inputSchema: {
    type: "object",
    properties: {
      workspaceId: { type: "string" },
      assigneeId: { type: "string" },
      projectId: { type: "string" },
      limit: { type: "integer" },
      cursor: { type: ["string", "null"] }
    },
    required: ["workspaceId"]
  },
  annotations: { readOnlyHint: true }
};

export const createActionTool = {
  name: "create_action",
  description: "Create a new action.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      workspaceId: { type: "string" },
      projectId: { type: "string" },
      assigneeId: { type: "string" },
      description: { type: "string" },
      startDate: { type: "string", format: "date" },
      dueDate: { type: "string", format: "date" }
    },
    required: ["title", "workspaceId"]
  },
  annotations: { destructiveHint: false }
};

export const updateActionTool = {
  name: "update_action",
  description: "Update an action by ID.",
  inputSchema: {
    type: "object",
    properties: {
      actionId: { type: "string" },
      updates: { type: "object" }
    },
    required: ["actionId", "updates"]
  },
  annotations: { destructiveHint: false }
};

export const deleteActionTool = {
  name: "delete_action",
  description: "Delete an action.",
  inputSchema: {
    type: "object",
    properties: { actionId: { type: "string" } },
    required: ["actionId"]
  },
  annotations: { destructiveHint: true }
};

// ---------------------------------------------------------------------------
// 3. TOOL IMPLEMENTATIONS
// ---------------------------------------------------------------------------

const hiveToolHandlers: Record<string, (extra: Extra) => Promise<any>> = {
  get_action: async (extra) => {
    const { actionId } = extra.args;
    const token = getHiveToken(extra);
    const resp = await axios.get(`${HIVE_API_BASE}/actions/${actionId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return resp.data;
  },
  list_actions: async (extra) => {
    const { workspaceId, ...params } = extra.args;
    const token = getHiveToken(extra);
    const resp = await axios.get(`${HIVE_API_BASE}/workspaces/${workspaceId}/actions`, {
      headers: { Authorization: `Bearer ${token}` },
      params
    });
    return resp.data;
  },
  create_action: async (extra) => {
    const token = getHiveToken(extra);
    const resp = await axios.post(`${HIVE_API_BASE}/actions/create`, extra.args, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return resp.data;
  },
  update_action: async (extra) => {
    const { actionId, updates } = extra.args;
    const token = getHiveToken(extra);
    const resp = await axios.put(`${HIVE_API_BASE}/actions/${actionId}`, updates, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return resp.data;
  },
  delete_action: async (extra) => {
    const { actionId } = extra.args;
    const token = getHiveToken(extra);
    const resp = await axios.delete(`${HIVE_API_BASE}/actions/${actionId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return resp.data;
  }
};

// Register tools
const tools = [
  getActionTool,
  listActionsTool,
  createActionTool,
  updateActionTool,
  deleteActionTool
];

tools.forEach((tool) => {
  server.tool(tool.name, tool.description, hiveToolHandlers[tool.name]);
});

// ---------------------------------------------------------------------------
// 4. EXPRESS SERVER & TRANSPORT WIRING
// ---------------------------------------------------------------------------

const app = express();
const port = process.env.PORT || 4100;

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));
app.use(express.json());

// In‑memory map of active SSE transports
const transports = new Map<string, SSEServerTransport>();

// --- SSE endpoint ----------------------------------------------------------
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);

  res.on("close", () => transports.delete(transport.sessionId));
  await server.connect(transport); // sets correct headers & starts streaming
});

// --- Messages endpoint (client → server) -----------------------------------
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);
  if (!transport) return res.status(400).send("No transport found for sessionId");

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (err: any) {
    console.error(`Error handling message (${sessionId}): ${err.message}`);
    // handlePostMessage already finished the response
  }
});

// --- misc routes -----------------------------------------------------------
app.get("/health", (_req, res) => res.status(200).send("OK"));
app.get("/", (_req, res) => res.send("MCP Hive Actions Server is running!"));

app.listen(port, () => {
  console.log(`Hive MCP server ready on http://localhost:${port}`);
});
