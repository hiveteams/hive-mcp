"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const body_parser_1 = __importDefault(require("body-parser"));
const axios_1 = __importDefault(require("axios"));
const http = __importStar(require("http"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
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
function extractToken(req) {
    const bearer = req.header("authorization");
    if (bearer?.toLowerCase().startsWith("bearer ")) {
        return bearer.slice(7).trim();
    }
    const legacy = req.header("x-hive-api-token");
    if (legacy)
        return legacy.trim();
    if (FALLBACK_TOKEN)
        return FALLBACK_TOKEN.trim();
    return null;
}
// ------------------------------------------------------------------
// Helper to call Hive REST API with a given token
// ------------------------------------------------------------------
async function hiveRequest(token, method, path, data) {
    const res = await axios_1.default.request({
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
];
// ------------------------------------------------------------------
// Tool execution implementation (now needs token param)
// ------------------------------------------------------------------
async function executeTool(token, name, args) {
    switch (name) {
        case "get_action":
            return hiveRequest(token, "GET", `/actions/${args.actionId}`);
        case "list_actions": {
            const params = new URLSearchParams();
            params.append("workspaceId", args.workspaceId);
            if (args.assigneeId)
                params.append("assigneeId", args.assigneeId);
            if (args.projectId)
                params.append("projectId", args.projectId);
            if (args.limit)
                params.append("limit", String(args.limit));
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
const app = (0, express_1.default)();
app.use(body_parser_1.default.json({ limit: "2mb" }));
app.get("/", (_req, res) => res.json(capabilities));
app.get("/health", (_req, res) => res.send("ok"));
app.get("/mcp", (_req, res) => res.status(405).set("Allow", "POST").send("Use POST /mcp"));
// Main MCP endpoint
app.post("/mcp", async (req, res) => {
    const token = extractToken(req);
    if (!token)
        return res.status(401).json({ error: "Missing Hive token" });
    const messages = Array.isArray(req.body) ? req.body : [req.body];
    const responses = [];
    const processMessage = async (msg) => {
        const isNotification = msg.id === undefined || msg.id === null;
        try {
            if (msg.method === "tools/list") {
                if (!isNotification) {
                    responses.push({ jsonrpc: "2.0", id: msg.id, result: { tools, nextCursor: null } });
                }
                return;
            }
            if (msg.method === "tools/call") {
                const { name, arguments: args } = msg.params ?? {};
                if (!name)
                    throw new Error("Missing tool name");
                const output = await executeTool(token, name, args || {});
                if (!isNotification) {
                    responses.push({
                        jsonrpc: "2.0",
                        id: msg.id,
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
                    id: msg.id,
                    error: { code: -32601, message: `Method ${msg.method} not found` },
                });
            }
        }
        catch (err) {
            if (!isNotification) {
                responses.push({
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                        isError: true,
                        content: [{ type: "text", text: err.message }],
                    },
                });
            }
        }
    };
    await Promise.all(messages.map(processMessage));
    if (responses.length === 0)
        return res.status(202).end();
    res.json(Array.isArray(req.body) ? responses : responses[0]);
});
// ------------------------------------------------------------------
// Start server
// ------------------------------------------------------------------
const server = http.createServer(app);
server.listen(PORT, () => console.log(`▶ MCP Hive server on :${PORT}`));
process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
