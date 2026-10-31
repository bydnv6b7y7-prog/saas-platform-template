import { operationalSettingsDefinition } from "../operational-settings";
import { createSettingsRouter } from "./settings";

/** Operational controls remain available while Market AI tuning is paused. */
export const operationsRouter = createSettingsRouter(operationalSettingsDefinition);
