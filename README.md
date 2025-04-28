# MCP Hive Actions Server (Multi-Tenant Token Edition)

This server acts as a multi-tenant proxy for Hive's API, supporting per-request API tokens. It allows multiple end-users to interact with Hive via a single server instance.

## Features
- Per-request Hive API token via HTTP headers:
  - `Authorization: Bearer <token>` (preferred)
  - `X-Hive-Api-Token: <token>` (legacy fallback)
- Falls back to `HIVE_API_TOKEN` from environment for single-tenant scenarios.
- Returns HTTP 401 if no valid token is provided.
- Implements JSON-RPC 2.0 for tool calls.

## Endpoints
- `GET /` — Capabilities
- `GET /health` — Health check
- `POST /mcp` — Main JSON-RPC endpoint

## Environment Variables
- `PORT` — Port to run the server (default: 4100)
- `HIVE_API_TOKEN` — Fallback Hive API token (optional)

## Setup

```sh
cd mcp-hive-actions-server
npm install
```

## Development

```sh
npm run dev
```

## Production

```sh
npm run build
npm start
```

## Example Request

```sh
curl -X POST http://localhost:4100/mcp \
  -H 'Authorization: Bearer <your-hive-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list"
  }'
``` 