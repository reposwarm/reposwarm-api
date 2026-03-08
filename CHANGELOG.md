# Changelog

## 2026-03-08 — Workflow delete endpoint

### Changes

- **`src/services/temporal.ts`** — Added `deleteWorkflow()` function using the Temporal gRPC API (`client.workflowService.deleteWorkflowExecution()`). The Temporal TypeScript SDK v1.15.0 lacks `WorkflowHandle.delete()`, so the lower-level gRPC call is required.
- **`src/routes/workflows.ts`** — Added `DELETE /workflows/:id` endpoint. Returns `{ data: { deleted: true } }` on success. Used by the CLI's `workflows prune` command to actually remove terminated/completed/failed workflows from Temporal history.
