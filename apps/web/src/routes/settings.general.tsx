import { createFileRoute, Link } from "@tanstack/react-router";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";

function SettingsGeneralRoute() {
  return (
    <>
      <GeneralSettingsPanel />
      <section className="mt-6 border-t pt-5">
        <h2 className="text-sm font-medium">Codebase analysis</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Set project analyzers and overview or detail overrides in{" "}
          <Link to="/codebase" className="text-primary underline">
            Codebase AI setup
          </Link>
          . Manage accounts in{" "}
          <Link to="/settings/providers" className="text-primary underline">
            Providers
          </Link>
          .
        </p>
      </section>
    </>
  );
}

export const Route = createFileRoute("/settings/general")({
  component: SettingsGeneralRoute,
});
