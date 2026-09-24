import { createFileRoute } from "@tanstack/react-router";
import { OfficialCatalog } from "../../../components/official-catalog";

export const Route = createFileRoute("/_authenticated/kv/")({
  component: KvPage,
});

function KvPage() {
  return (
    <OfficialCatalog
      kind="KV namespaces"
      description="Namespaces returned by the official Workers KV API."
      load={async (client, instanceID, signal) => {
        const page = await client.kv.namespaces.list(
          { account_id: instanceID },
          { signal },
        );
        return page.result.map((namespace) => ({
          id: namespace.id,
          name: namespace.title,
          href: `/kv/${encodeURIComponent(namespace.id)}`,
        }));
      }}
      create={(client, instanceID, name) =>
        client.kv.namespaces.create({
          account_id: instanceID,
          title: name,
        })
      }
      rename={(client, instanceID, row, name) =>
        client.kv.namespaces.update(row.id, {
          account_id: instanceID,
          title: name,
        })
      }
      remove={(client, instanceID, row) =>
        client.kv.namespaces.delete(row.id, {
          account_id: instanceID,
        })
      }
    />
  );
}
