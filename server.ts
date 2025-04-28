import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import axios, { Method } from "axios";
import * as http from "http";
import dotenv from "dotenv";

dotenv.config();

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: any;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string | null;
  result: any;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: any;
  };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------
const PORT = Number(process.env.PORT ?? 4100);
const FALLBACK_TOKEN = process.env.HIVE_API_TOKEN; // optional now
const HIVE_BASE_URL = "https://app.hive.com/api/v1";

// ------------------------------------------------------------------
// Capabilities object (static)
// ------------------------------------------------------------------
const capabilities = {
  capabilities: {
    tools: { listChanged: false },
  },
};

// ------------------------------------------------------------------
// Utility: extract Hive token from request headers
// ------------------------------------------------------------------
function extractToken(req: Request): string | null {
  const bearer = req.header("authorization");
  if (bearer?.toLowerCase().startsWith("bearer ")) {
    return bearer.slice(7).trim();
  }
  const legacy = req.header("x-hive-api-token");
  if (legacy) return legacy.trim();
  if (FALLBACK_TOKEN) return FALLBACK_TOKEN.trim();
  return null;
}

// ------------------------------------------------------------------
// Helper to call Hive REST API with a given token
// ------------------------------------------------------------------
async function hiveRequest<T>(token: string, method: Method, path: string, data?: any): Promise<T> {
  const res = await axios.request<T>({
    method,
    url: `${HIVE_BASE_URL}${path}`,
    data,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  return res.data;
}

// ------------------------------------------------------------------
// Tool definitions (unchanged)
// ------------------------------------------------------------------
const tools = [
  {
    name: "get_action",
    description: "Retrieve a single Hive action by its ID.",
    inputSchema: {
      type: "object",
      properties: { actionId: { type: "string" } },
      required: ["actionId"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "list_actions",
    description: "List actions in a workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        assigneeId: { type: "string" },
        projectId: { type: "string" },
        limit: { type: "integer" },
        cursor: { type: ["string", "null"] },
      },
      required: ["workspaceId"],
    },
    annotations: { readOnlyHint: true },
  },
  {
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
        dueDate: { type: "string", format: "date" },
      },
      required: ["title", "workspaceId"],
    },
    annotations: { destructiveHint: false },
  },
  {
    name: "update_action",
    description: "Update an action by ID.",
    inputSchema: {
      type: "object",
      properties: {
        actionId: { type: "string" },
        updates: { type: "object" },
      },
      required: ["actionId", "updates"],
    },
    annotations: { destructiveHint: false },
  },
  {
    name: "delete_action",
    description: "Delete an action.",
    inputSchema: {
      type: "object",
      properties: { actionId: { type: "string" } },
      required: ["actionId"],
    },
    annotations: { destructiveHint: true },
  },
] as const;

type ToolName = typeof tools[number]["name"];

// ------------------------------------------------------------------
// Tool execution implementation (now needs token param)
// ------------------------------------------------------------------
async function executeTool(token: string, name: ToolName, args: Record<string, any>): Promise<any> {
  switch (name) {
    case "get_action":
      return hiveRequest(token, "GET", `/actions/${args.actionId}`);

    case "list_actions": {
      const params = new URLSearchParams();
      params.append("workspaceId", args.workspaceId);
      if (args.assigneeId) params.append("assigneeId", args.assigneeId);
      if (args.projectId) params.append("projectId", args.projectId);
      if (args.limit) params.append("limit", String(args.limit));
      return hiveRequest(token, "GET", `/actions?${params.toString()}`);
    }

    case "create_action":
      return hiveRequest(token, "POST", "/actions", {
        title: args.title,
        workspaceId: args.workspaceId,
        projectId: args.projectId,
        assigneeId: args.assigneeId,
        description: args.description,
        startDate: args.startDate,
        dueDate: args.dueDate,
      });

    case "update_action":
      return hiveRequest(token, "PUT", `/actions/${args.actionId}`, args.updates);

    case "delete_action":
      return hiveRequest(token, "DELETE", `/actions/${args.actionId}`);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ------------------------------------------------------------------
// Express app
// ------------------------------------------------------------------
const app = express();
app.use(bodyParser.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.json({
  capabilities,
  tools
}));
app.get("/health", (_req, res) => res.send("ok"));
app.get("/mcp", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  res.flushHeaders();

  // Send an initial ping
  res.write("event: ping\ndata: ok\n\n");

  // Send a ping every 15 seconds to keep the connection alive
  const interval = setInterval(() => {
    res.write("event: ping\ndata: ok\n\n");
  }, 15000);

  // Clean up when the client closes the connection
  req.on("close", () => {
    clearInterval(interval);
    res.end();
  });
});

// Main MCP endpoint
app.post("/mcp", async (req: Request, res: Response) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: "Missing Hive token" });

  const messages: JsonRpcRequest[] = Array.isArray(req.body) ? req.body : [req.body];
  const responses: JsonRpcResponse[] = [];

  const processMessage = async (msg: JsonRpcRequest): Promise<void> => {
    const isNotification = msg.id === undefined || msg.id === null;

    try {
      if (msg.method === "tools/list") {
        if (!isNotification) {
          responses.push({ jsonrpc: "2.0", id: msg.id!, result: { tools, nextCursor: null } });
        }
        return;
      }

      if (msg.method === "tools/call") {
        const { name, arguments: args } = msg.params ?? {};
        if (!name) throw new Error("Missing tool name");
        const output = await executeTool(token, name, args || {});
        if (!isNotification) {
          responses.push({
            jsonrpc: "2.0",
            id: msg.id!,
            result: {
              isError: false,
              content: [{ type: "text", text: JSON.stringify(output) }],
            },
          });
        }
        return;
      }

      if (!isNotification) {
        responses.push({
          jsonrpc: "2.0",
          id: msg.id!,
          error: { code: -32601, message: `Method ${msg.method} not found` },
        });
      }
    } catch (err: any) {
      if (!isNotification) {
        responses.push({
          jsonrpc: "2.0",
          id: msg.id!,
          result: {
            isError: true,
            content: [{ type: "text", text: err.message }],
          },
        });
      }
    }
  };

  await Promise.all(messages.map(processMessage));

  if (responses.length === 0) return res.status(202).end();
  res.json(Array.isArray(req.body) ? responses : responses[0]);
});

// ------------------------------------------------------------------
// Start server
// ------------------------------------------------------------------
const server = http.createServer(app);
server.listen(PORT, () => console.log(`▶ MCP Hive server on :${PORT}`));
process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close()); 