// hive-mcp-server.ts
// Fully‑typed TypeScript implementation

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import cors from "cors";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

//--------------------------------------------------------------------
// 1. MCP SERVER
//--------------------------------------------------------------------
const server = new McpServer({ name: "hive-mcp-server", version: "1.0.0" });

//--------------------------------------------------------------------
// 2. CONSTANTS, TOKEN & WORKSPACE CACHES, UTILITIES
//--------------------------------------------------------------------
const HIVE_API_BASE = "https://beta.hive.com/api/v1";

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

    const resp = await fetch(`${HIVE_API_BASE}/actions/${actionId}`, { 
      headers: { "api_key": token } 
    }).then(res => res.json());

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(resp),
        },
      ],
    };
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

    // Building URL with query parameters
    const url = new URL(`${HIVE_API_BASE}/workspaces/${workspace}/actions`);
    if (assigneeId) url.searchParams.append("assigneeId", assigneeId);
    if (projectId) url.searchParams.append("projectId", projectId);
    if (limit) url.searchParams.append("limit", limit.toString());
    if (cursor) url.searchParams.append("cursor", cursor);

    const resp = await fetch(url.toString(), {
      headers: { api_key: token }
    });
    const data = await resp.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data),
        },
      ],
    };
  },
);

// -------------------- ACTION: CREATE --------------------
server.tool(
  "create_action",
  {
    title: z.string(),
    projectId: z.string().optional(),
    assignees: z.array(z.string()),
    description: z.string().optional(),
  },
  async (
    args: {
      title: string;
      projectId?: string;
      assignees?: string[];
      description?: string;
    },
    extra: Extra,
  ) => {
    const token = getHiveToken(extra);
    const workspace = resolveWorkspace(extra);
    if (!workspace) throw new Error("workspace required (query string in /sse)");

    const resp = await fetch(
      `${HIVE_API_BASE}/actions/create`,
      {
        method: 'POST',
        headers: { 
          "api_key": token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ ...args, workspace })
      }
    );

    const data = await resp.json();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data),
        },
      ],
    };
  },
);

// -------------------- ACTION: UPDATE --------------------
server.tool(
  "update_action",
  {
    actionId: z.string(),
    status: z.string().optional(),           // allowed update field
    agileStoryPoints: z.number().int().optional(), // new allowed field
    githubBranchNames: z.array(z.string()).optional(), // array of github branch names
  },
  async (
    {
      actionId,
      status,
      agileStoryPoints,
      githubBranchNames,
    }: {
      actionId: string;
      status?: string;
      agileStoryPoints?: number;
      githubBranchNames?: string[];
    },
    extra: Extra,
  ) => {
    const token = getHiveToken(extra);

    // Build payload containing only the permitted fields actually supplied
    const updates: Record<string, unknown> = {};
    if (status !== undefined) updates.status = status;
    if (agileStoryPoints !== undefined) updates.agileStoryPoints = agileStoryPoints;
    if (githubBranchNames !== undefined) updates.githubBranchNames = githubBranchNames;

    // PUT to the correct endpoint (no actionId in body)
    const resp = await fetch(
      `${HIVE_API_BASE}/actions/${actionId}`,
      {
        method: 'PUT',
        headers: { 
          "api_key": token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(updates)
      }
    );

    const data = await resp.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data),
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
    const resp = await fetch(`${HIVE_API_BASE}/actions/${actionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await resp.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data),
        },
      ],
    };
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

//------------------------------------------------------
// 4.1  SSE ENDPOINT WITH HEARTBEAT
//------------------------------------------------------
app.get("/sse", async (req, res) => {
  const apiKey = req.query.api_key as string | undefined;
  const workspace = req.query.workspace as string | undefined;

  const transport = new SSEServerTransport("/messages", res);

  if (apiKey) sessionTokens[transport.sessionId] = apiKey;
  if (workspace) sessionWorkspaces[transport.sessionId] = workspace;

  transports.sse[transport.sessionId] = transport;

  // ----- heartbeat every 25 s to keep connection alive -----
  const ping = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": keepalive\n\n"); // SSE comment
    } else {
      clearInterval(ping);
    }
  }, 25_000);

  res.on("close", () => {
    clearInterval(ping);
    delete transports.sse[transport.sessionId];
    delete sessionTokens[transport.sessionId];
    delete sessionWorkspaces[transport.sessionId];
  });

  await server.connect(transport);
});

//------------------------------------------------------
// 4.2  POST FOR CLIENT MESSAGES
//------------------------------------------------------
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.sse[sessionId];
  if (!transport) return res.status(400).send("No transport for sessionId");
  await transport.handlePostMessage(req, res, req.body);
});

//------------------------------------------------------
// 4.3  HEALTH & ROOT
//------------------------------------------------------
app.get("/health", (_req, res) => res.send("OK"));
app.get("/", (_req, res) => res.send("MCP Hive Actions Server is running!"));

//--------------------------------------------------------------------
// 5. START SERVER WITH UNLIMITED TIMEOUT
//--------------------------------------------------------------------
const httpServer = app.listen(port, () => console.log(`Hive MCP server running on port ${port}`));

// Disable default 2‑minute idle timeout (important for SSE)
(httpServer as any).timeout = 0; // eslint-disable-line @typescript-eslint/no-explicit-any
