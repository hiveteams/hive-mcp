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

// Utility to get the Hive API token from the request or environment
function getHiveToken(context: any): string | null {
  // Try to get from context (MCP SDK context may pass headers)
  const authHeader = context?.headers?.authorization || context?.headers?.Authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  // Fallback to env
  return process.env.HIVE_API_TOKEN || null;
}

const HIVE_API_BASE = "https://app.hive.com/api/v1";

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

app.listen(port, () => {
  console.log(`Hive MCP server running at http://localhost:${port}`);
});

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