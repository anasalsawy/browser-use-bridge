import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = Number(process.env.PORT || 8800);
const EXEC_TOKEN = process.env.VM_EXEC_TOKEN;
const WORKDIR = process.env.VM_WORKDIR || "/home/azureuser";
const MAX_TIMEOUT_MS = Number(process.env.VM_MAX_TIMEOUT_MS || 120000);

if (!EXEC_TOKEN) {
  console.error("VM_EXEC_TOKEN is required");
  process.exit(1);
}

function authorized(req) {
  const h = req.get("authorization") || "";
  return h === `Bearer ${EXEC_TOKEN}`;
}

app.get("/health", (req, res) => res.json({ ok: true, service: "vm-shell-mcp", port: PORT }));

function makeServer() {
  const server = new McpServer({ name: "vm-shell", version: "1.0.0" });

  server.tool(
    "vm_exec",
    "Execute a shell command on the connected Linux VM. Returns stdout, stderr, exit code, and whether the command timed out.",
    {
      command: z.string().min(1).describe("Shell command to execute on the VM"),
      cwd: z.string().optional().describe("Working directory; defaults to VM_WORKDIR"),
      timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional().describe("Command timeout in milliseconds")
    },
    async ({ command, cwd, timeout_ms }) => {
      const timeout = timeout_ms ?? Math.min(60000, MAX_TIMEOUT_MS);
      try {
        const result = await execFileAsync("/bin/bash", ["-lc", command], {
          cwd: cwd || WORKDIR,
          timeout,
          maxBuffer: 4 * 1024 * 1024,
          env: process.env
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: true, exit_code: 0, stdout: result.stdout, stderr: result.stderr }, null, 2)
          }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              exit_code: typeof err.code === "number" ? err.code : null,
              signal: err.signal || null,
              timed_out: err.killed === true,
              stdout: err.stdout || "",
              stderr: err.stderr || String(err.message || err)
            }, null, 2)
          }]
        };
      }
    }
  );

  return server;
}

// MCP endpoint. Authentication is checked before handing the request to MCP.
app.all("/mcp", async (req, res) => {
  if (!authorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error?.message || error);
    if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`VM shell MCP listening on http://127.0.0.1:${PORT}/mcp`);
  console.log(`Health: http://127.0.0.1:${PORT}/health`);
});
