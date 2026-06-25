import type { ViewKey } from "../../store/nav.js";
import { WorkbenchView } from "./WorkbenchView.js";
import { AgentMatrixView } from "./AgentMatrixView.js";
import { ConnectorHubView } from "./ConnectorHubView.js";
import { PluginMarketplaceView } from "./PluginMarketplaceView.js";
import { ScheduleTasksView } from "./ScheduleTasksView.js";
import { ConnectPhoneView } from "./ConnectPhoneView.js";
import { SettingsView } from "./SettingsView.js";

// The Goal/Plan, Changes and Todo panels are not registered here: they dock as
// the workbench right rail (see WorkbenchView, WorkbenchPanel), not as full-stage
// routes.
export const VIEWS: Record<ViewKey, () => JSX.Element> = {
  workbench: WorkbenchView,
  agents: AgentMatrixView,
  connectors: ConnectorHubView,
  plugins: PluginMarketplaceView,
  schedule: ScheduleTasksView,
  phone: ConnectPhoneView,
  settings: SettingsView,
};
