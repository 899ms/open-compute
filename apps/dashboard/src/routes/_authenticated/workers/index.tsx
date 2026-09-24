import { createFileRoute } from "@tanstack/react-router";
import { OfficialCatalog } from "../../../components/official-catalog";

export const Route = createFileRoute("/_authenticated/workers/")({
  component: WorkersPage,
});

function WorkersPage() {
  return (
    <OfficialCatalog
      kind="Workers"
      description="Scripts returned by the official Workers API."
      load={async (client, instanceID, signal) => {
        const page = await client.workers.scripts.list(
          { account_id: instanceID },
          { signal },
        );
        return page.result.map((script) => ({
          id: script.id ?? "unknown",
          name: script.id ?? "Unnamed Worker",
          detail: script.compatibility_date ?? "No compatibility date",
          href: `/workers/${encodeURIComponent(script.id ?? "unknown")}`,
        }));
      }}
      remove={(client, instanceID, row) =>
        client.workers.scripts.delete(row.id, {
          account_id: instanceID,
        })
      }
    />
  );
}
