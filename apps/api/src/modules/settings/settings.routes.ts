/**
 * Settings routes - mounted at /api/settings in app.ts.
 *
 * All routes require authentication. Manages user platform preferences
 * (build mode, etc.) that sync across devices and to Openship Cloud.
 *
 * System-level settings (SSH creds, server connection) are stored locally
 * in Electron's ConfigStore - they never touch this API.
 */
import { Hono } from "hono";
import { authMiddleware } from "../../middleware/auth";
import * as ctrl from "./settings.controller";

export const settingsRoutes = new Hono();

settingsRoutes.use("*", authMiddleware);

/** GET  /            - get current user's workspace settings */
settingsRoutes.get("/", ctrl.get);

/** PUT  /            - create or update workspace settings */
settingsRoutes.put("/", ctrl.upsert);

/** PATCH /build-mode - update only build mode preference */
settingsRoutes.patch("/build-mode", ctrl.updateBuildMode);

/** PATCH /deploy-defaults - set/clear the default deploy target + server */
settingsRoutes.patch("/deploy-defaults", ctrl.updateDeployDefaults);

/** PATCH /clone-credentials - set/clear the user-global git clone token */
settingsRoutes.patch("/clone-credentials", ctrl.updateCloneCredentials);

/** PATCH /clone-strategy-preference - save the first-time deploy nudge choice */
settingsRoutes.patch("/clone-strategy-preference", ctrl.updateCloneStrategyPreference);
