import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { authenticate, type AuthContext } from "./auth.js";
import { continueApprovedRun, prepareShoppingRun } from "./automation.js";
import { loadConfig } from "./config.js";
import { approvalSchema, createRunSchema } from "./schemas.js";
import { approveRun, createRun, getRun } from "./repository.js";

const config = loadConfig();
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "128kb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", config.CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

type AuthenticatedRequest = Request & { auth: AuthContext };

function routeParam(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = await authenticate(req.header("authorization"), config);
  if (!auth) return res.status(401).json({ error: "Unauthorized" });
  (req as AuthenticatedRequest).auth = auth;
  next();
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", modelGateway: true, paymentCredentialsStored: false });
});

app.post("/v1/shopping/runs", requireAuth, async (req, res) => {
  const input = createRunSchema.parse(req.body);
  const { auth } = req as AuthenticatedRequest;
  const run = await createRun(auth.supabase, auth.user.id, input);

  void prepareShoppingRun(
    { config, supabase: auth.supabase, userId: auth.user.id },
    run,
    input,
  );

  res.status(202).json({ run });
});

app.get("/v1/shopping/runs/:runId", requireAuth, async (req, res) => {
  const { auth } = req as AuthenticatedRequest;
  const runId = routeParam(req.params.runId);
  if (!runId) return res.status(400).json({ error: "Invalid run ID" });
  const run = await getRun(auth.supabase, runId);
  if (!run) return res.status(404).json({ error: "Run not found" });
  res.json({ run });
});

app.post("/v1/shopping/runs/:runId/approve", requireAuth, async (req, res) => {
  const approval = approvalSchema.parse(req.body);
  const { auth } = req as AuthenticatedRequest;
  const runId = routeParam(req.params.runId);
  if (!runId) return res.status(400).json({ error: "Invalid run ID" });
  const run = await getRun(auth.supabase, runId);
  if (!run) return res.status(404).json({ error: "Run not found" });
  if (run.status !== "awaiting_approval") {
    return res.status(409).json({ error: `Run cannot be approved from status ${run.status}` });
  }

  await approveRun(
    auth.supabase,
    auth.user.id,
    run,
    approval.approvedMaximum,
    approval.currency,
  );
  void continueApprovedRun(
    { config, supabase: auth.supabase, userId: auth.user.id },
    run.id,
  );
  res.status(202).json({ runId: run.id, status: "approved" });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof ZodError) {
    return res.status(400).json({ error: "Invalid request", issues: error.issues });
  }
  const message = error instanceof Error ? error.message : "Internal server error";
  return res.status(500).json({ error: message });
});

app.listen(config.PORT, () => {
  console.log(`Secure shopping agent listening on port ${config.PORT}`);
});
