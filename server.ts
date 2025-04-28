// hive-mcp-server.ts
// Fully‑typed TypeScript implementation

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import { z } from "zod";

dotenv.config();

//--------------------------------------------------------------------
// 1. MCP SERVER
//--------------------------------------------------------------------
const server = new McpServer({ name: "hive-mcp-server", version: "1.0.0" });

//--------------------------------------------------------------------
// 2. CONSTANTS, TOKEN & WORKSPACE CACHES, UTILITIES
//--------------------------------------------------------------------
const HIVE_API_BASE = "https://app.hive.com/api/v1";

// Cache token and workspace per SSE sessionId
const sessionTokens: Record<string, string> = {};
const sessionWorkspaces: Record<string, string> = {};

export interface Extra {
  headers?: Record<string, string>;
  sessionId?: string;
}

function getHiveToken(extra: Extra): string {
  // 1. Authorization header
  const header = extra?.headers?.authorization ?? extra?.headers?.Authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);

  // 2. x-token header fallback
  if (extra?.headers?.["x-token"]) return extra.headers["x-token"];

  // 3. Cached per‑session token
  if (extra.sessionId && sessionTokens[extra.sessionId]) return sessionTokens[extra.sessionId];

  // 4. Dev env var
  if (process.env.HIVE_API_TOKEN) return process.env.HIVE_API_TOKEN;

  throw new Error("No Hive API token provided");
}

function resolveWorkspace(extra: Extra): string | undefined {
  // 1. Header fallback
  if (extra.headers?.["x-workspace"]) return extra.headers["x-workspace"];
  // 2. Cached per‑session workspace
  if (extra.sessionId && sessionWorkspaces[extra.sessionId]) return sessionWorkspaces[extra.sessionId];
  return undefined;
}

//--------------------------------------------------------------------
// 3. TOOLS
//--------------------------------------------------------------------

// -------------------- ACTION: GET --------------------
server.tool(
  "get_action",
  { actionId: z.string() },
  async ({ actionId }: { actionId: string }, extra: Extra) => {
    const token = getHiveToken(extra);
    const resp = await axios.get(`${HIVE_API_BASE}/actions/${actionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return resp.data;
  },
);

// -------------------- ACTION: LIST --------------------
server.tool(
  "list_actions",
  {
    assigneeId: z.string().optional(),
    projectId: z.string().optional(),
    limit: z.number().int().optional(),
    cursor: z.string().nullable().optional(),
  },
  async (
    args: {
      assigneeId?: string;
      projectId?: string;
      limit?: number;
      cursor?: string | null;
    },
    extra: Extra,
  ) => {
    const workspace = resolveWorkspace(extra);
    if (!workspace) throw new Error("workspace required (query string in /sse)");
    const token = getHiveToken(extra);
    const { assigneeId, projectId, limit, cursor } = args;

    const resp = await axios.get(`${HIVE_API_BASE}/workspaces/${workspace}/actions`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { assigneeId, projectId, limit, cursor },
    });
    return resp.data;
  },
);

// -------------------- ACTION: CREATE --------------------
server.tool(
  "create_action",
  {
    title: z.string(),
    projectId: z.string().optional(),
    assigneeId: z.string().optional(),
    description: z.string().optional(),
  },
  async (
    args: {
      title: string;
      projectId?: string;
      assigneeId?: string;
      description?: string;
    },
    extra: Extra,
  ) => {
    const token = getHiveToken(extra);
    const workspace = resolveWorkspace(extra);
    if (!workspace) throw new Error("workspace required (query string in /sse)");

    const resp = await axios.post(
      `${HIVE_API_BASE}/actions/create`,
      { ...args, workspace: resolveWorkspace(extra) },
      { headers: { "api_key": token } },
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(resp.data)
        }
      ]
    };
  },
);

// -------------------- ACTION: UPDATE --------------------
server.tool(
  "update_action",
  {
    actionId: z.string(),
    status: z.string(),
    agileStoryPoints: z.number().int().optional().describe("An estimate for the effort in points"),
  },
  async (
    { actionId, status, agileStoryPoints }: { actionId: string; status: string; agileStoryPoints?: number },
    extra: Extra,
  ) => {
    const token = getHiveToken(extra);
    const workspace = resolveWorkspace(extra);
    if (!workspace) throw new Error("workspace required (query string in /sse)");

    // same pattern as create_action: POST, api_key header, workspace in body
    const resp = await axios.post(
      `${HIVE_API_BASE}/actions/${actionId}`,
      { status, workspace, ...(agileStoryPoints !== undefined ? { agileStoryPoints } : {}) },
      { headers: { "api_key": token } },
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(resp.data),
        },
      ],
    };
  },
);

// -------------------- ACTION: DELETE --------------------
server.tool(
  "delete_action",
  { actionId: z.string() },
  async ({ actionId }: { actionId: string }, extra: Extra) => {
    const token = getHiveToken(extra);
    const resp = await axios.delete(`${HIVE_API_BASE}/actions/${actionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return resp.data;
  },
);

//--------------------------------------------------------------------
// 4. EXPRESS & TRANSPORTS
//--------------------------------------------------------------------
const app = express();
const port = process.env.PORT || 4100;

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-workspace", "x-token"],
  }),
);
app.use(express.json());

const transports: {
  sse: Record<string, SSEServerTransport>;
} = {
  sse: {},
};

app.get("/sse", async (req, res) => {
  const apiKey = req.query.api_key as string | undefined;
  const workspace = req.query.workspace as string | undefined;

  const transport = new SSEServerTransport("/messages", res);

  if (apiKey) {
    sessionTokens[transport.sessionId] = apiKey.startsWith("Bearer ") ? apiKey.slice(7) : apiKey;
  }
  if (workspace) {
    sessionWorkspaces[transport.sessionId] = workspace;
  }

  transports.sse[transport.sessionId] = transport;

  res.on("close", () => {
    delete transports.sse[transport.sessionId];
    delete sessionTokens[transport.sessionId];
    delete sessionWorkspaces[transport.sessionId];
  });

  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.sse[sessionId];
  if (!transport) return res.status(400).send("No transport for sessionId");
  await transport.handlePostMessage(req, res, req.body);
});

app.get("/health", (_req, res) => res.send("OK"));
app.get("/", (_req, res) => res.send("MCP Hive Actions Server is running!"));

app.listen(port, () => console.log(`Hive MCP server running on port ${port}`));
