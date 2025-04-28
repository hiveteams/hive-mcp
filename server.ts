// hive-mcp-server.ts
// Corrected version – fixes invalid Content-Type on the SSE endpoint.

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: "hive-mcp-server",
  version: "1.0.0"
});

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
function getHiveToken(extra: any): string | null {
  const authHeader =
    extra?.headers?.authorization || extra?.headers?.Authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return process.env.HIVE_API_TOKEN || null;
}

const HIVE_API_BASE = "https://app.hive.com/api/v1";

// ---------------------------------------------------------------------------
// Tool definitions
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
// Handler implementations
// ---------------------------------------------------------------------------
const hiveToolHandlers: Record<string, (extra: any) => Promise<any>> = {
  get_action: async (extra) => {
    const { actionId } = extra.args;
    const token = getHiveToken(extra);
    if (!token) throw new Error("No Hive API token provided");
    const resp = await axios.get(`${HIVE_API_BASE}/actions/${actionId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return resp.data;
  },
  list_actions: async (extra) => {
    const { workspaceId, ...rest } = extra.args;
    const token = getHiveToken(extra);
    if (!token) throw new Error("No Hive API token provided");
    const resp = await axios.get(
      `${HIVE_API_BASE}/workspaces/${workspaceId}/actions`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: rest
      }
    );
    return resp.data;
  },
  create_action: async (extra) => {
    const token = getHiveToken(extra);
    if (!token) throw new Error("No Hive API token provided");
    const resp = await axios.post(`${HIVE_API_BASE}/actions/create`, extra.args, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return resp.data;
  },
  update_action: async (extra) => {
    const { actionId, updates } = extra.args;
    const token = getHiveToken(extra);
    if (!token) throw new Error("No Hive API token provided");
    const resp = await axios.put(`${HIVE_API_BASE}/actions/${actionId}`, updates, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return resp.data;
  },
  delete_action: async (extra) => {
    const { actionId } = extra.args;
    const token = getHiveToken(extra);
    if (!token) throw new Error("No Hive API token provided");
    const resp = await axios.delete(`${HIVE_API_BASE}/actions/${actionId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return resp.data;
  }
};

// ---------------------------------------------------------------------------
// Register tools with the MCP server
// ---------------------------------------------------------------------------
const exportedTools = [
  getActionTool,
  listActionsTool,
  createActionTool,
  updateActionTool,
  deleteActionTool
];

for (const tool of exportedTools) {
  server.tool(tool.name, tool.description, hiveToolHandlers[tool.name]);
}

// ---------------------------------------------------------------------------
// Express app + transport management
// ---------------------------------------------------------------------------
const app = express();
const port = process.env.PORT || 4100;

// Store the currently active transport (one‑client assumption)
let activeTransport: SSEServerTransport | null = null;

// Enhanced CORS
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
  })
);
app.use(express.json());

// ---------------------------------------------------------------------------
// SSE endpoint – **async** and we await server.connect()
// ---------------------------------------------------------------------------
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  activeTransport = transport;

  // Hand the connection to the MCP server – this writes proper headers
  await server.connect(transport);

  // Cleanup on close
  req.on("close", () => {
    if (activeTransport === transport) {
      activeTransport = null;
    }
  });
});

// ---------------------------------------------------------------------------
// Message endpoint (client → server)
// ---------------------------------------------------------------------------
app.post("/messages", (req, res) => {
  if (!activeTransport) {
    return res.status(503).send("SSE connection not established");
  }

  try {
    // Forward the request to the transport. The helper will parse body as needed.
    activeTransport.handlePostMessage(req, res);
  } catch (error: any) {
    console.error(`Error handling message: ${error.message}`);
    res.status(500).send(error.message);
  }
});

// ---------------------------------------------------------------------------
// Misc endpoints
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => res.status(200).send("OK"));
app.get("/", (_req, res) => res.send("MCP Hive Actions Server is running!"));

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------
app.listen(port, () => {
  console.log(`Hive MCP server running at http://localhost:${port}`);
});
