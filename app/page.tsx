import { loadConfig } from "../lib/config";
import { getStore } from "../lib/store";
import { MirrorDashboard } from "./mirror-dashboard";

export const dynamic = "force-dynamic";

export default function Home(): React.ReactNode {
  const config = loadConfig();
  const initialSnapshot = getStore(config.dataDir).getDashboardSnapshot(
    new Date(),
    30_000,
  );

  return (
    <MirrorDashboard
      organization={config.organization}
      initialSnapshot={initialSnapshot}
    />
  );
}
