/**
 * Service routes - mounted as sub-routes of /api/projects/:id/services
 *
 * Body-bearing routes are guarded by `@hono/typebox-validator` against
 * the schemas in service.schema.ts. Without the validator, a request
 * could ship arbitrary keys (or wrong types) straight into the DB layer.
 */

import { Hono } from "hono";
import { tbValidator } from "@hono/typebox-validator";
import { authMiddleware } from "../../middleware";
import * as ctrl from "./service.controller";
import {
  CreateServiceBody,
  SetServiceEnvVarsBody,
  UpdateServiceBody,
} from "./service.schema";

export const serviceRoutes = new Hono();

/* All service routes require authentication */
serviceRoutes.use("*", authMiddleware);

/* ─── Service CRUD ─────────────────────────────────────────────────────── */
serviceRoutes.get("/", ctrl.list);
serviceRoutes.post("/", tbValidator("json", CreateServiceBody), ctrl.create);
serviceRoutes.get("/containers", ctrl.activeContainers);
serviceRoutes.post("/sync", ctrl.syncFromCompose);
serviceRoutes.get("/:serviceId", ctrl.getById);
serviceRoutes.get("/:serviceId/logs", ctrl.runtimeLogs);
serviceRoutes.get("/:serviceId/logs/stream", ctrl.runtimeLogStream);
serviceRoutes.patch("/:serviceId", tbValidator("json", UpdateServiceBody), ctrl.update);
serviceRoutes.delete("/:serviceId", ctrl.remove);

/* ─── Per-service container actions ─────────────────────────────────────── */
serviceRoutes.post("/:serviceId/start", ctrl.startContainer);
serviceRoutes.post("/:serviceId/stop", ctrl.stopContainer);
serviceRoutes.post("/:serviceId/restart", ctrl.restartContainer);

/* ─── Service environment variables ─────────────────────────────────────── */
serviceRoutes.get("/:serviceId/env", ctrl.listEnvVars);
serviceRoutes.put(
  "/:serviceId/env",
  tbValidator("json", SetServiceEnvVarsBody),
  ctrl.setEnvVars,
);
