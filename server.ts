import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

// Create the MCP server
const server = new McpServer({
  name: "hive-mcp-server",
  version: "1.0.0"
});

// Utility to get the Hive API token from the extra (context)
function getHiveToken(extra: any): string | null {
  const authHeader = extra?.headers?.authorization || extra?.headers?.Authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return process.env.HIVE_API_TOKEN || null;
}

const HIVE_API_BASE = "https://app.hive.com/api/v1";

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

// Handler map
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
    const resp = await axios.get(`${HIVE_API_BASE}/workspaces/${workspaceId}/actions`, {
      headers: { Authorization: `Bearer ${token}` },
      params: rest
    });
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

// Register the handlers with the MCP server
const exportedTools = [
  getActionTool,
  listActionsTool,
  createActionTool,
  updateActionTool,
  deleteActionTool
];

for (const tool of exportedTools) {
  server.tool(
    tool.name,
    tool.description,
    hiveToolHandlers[tool.name]
  );
}

// Only keep the plain object tool exports and the rest of the server logic

const app = express();
const port = process.env.PORT || 4100;

// Store active transport
let activeTransport: SSEServerTransport | null = null;

// Enhanced CORS setup
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(express.json());

// SSE endpoint for server-to-client communication
app.get("/sse", (req, res) => {
  console.log("SSE connection attempt");
  // Create transport
  const transport = new SSEServerTransport("/messages", res);
  activeTransport = transport;
  // Connect server to transport
  server.connect(transport);
  console.log("SSE connection established");
  // Handle connection close
  req.on('close', () => {
    console.log("SSE connection closed");
    if (activeTransport === transport) {
      activeTransport = null;
    }
  });
});

// Message endpoint for client-to-server communication
app.post("/messages", (req, res) => {
  if (!activeTransport) {
    return res.status(503).send("SSE connection not established");
  }
  console.log("Received message from client");
  try {
    activeTransport.handlePostMessage(req, res);
  } catch (error: any) {
    console.error(`Error handling message: ${error.message}`);
    res.status(500).send(error.message);
  }
});

// Health check endpoint
app.get("/health", (_req, res) => {
  res.status(200).send("OK");
});

app.get("/", (_req, res) => {
  res.send("MCP Hive Actions Server is running!");
});

app.listen(port, () => {
  console.log(`Hive MCP server running at http://localhost:${port}`);
}); 