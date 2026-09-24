import { Button } from "@cloudflare/kumo/components/button";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { OfficialCatalog } from "../../../components/official-catalog";
import {
  QueueConfigDialog,
  type QueueConfigInput,
} from "../../../components/queue-config-dialog";
import { useAuth } from "../../../features/auth/auth-atoms";
import { useMutationFeedback } from "../../../features/toast/use-mutation-feedback";

export const Route = createFileRoute("/_authenticated/queues/")({
  component: QueuesPage,
});

function QueuesPage() {
  const { client, instanceId } = useAuth();
  const queryClient = useQueryClient();
  const feedback = useMutationFeedback();
  const [createOpen, setCreateOpen] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async (input: QueueConfigInput) => {
      const queue = await client!.queues.create({
        account_id: instanceId!,
        queue_name: input.name!,
      });
      if (
        queue.queue_id &&
        (input.deliveryDelaySeconds !== undefined ||
          input.retentionSeconds !== undefined)
      ) {
        await client!.queues.update(queue.queue_id, {
          account_id: instanceId!,
          settings: {
            ...(input.deliveryDelaySeconds === undefined
              ? {}
              : { delivery_delay: input.deliveryDelaySeconds }),
            ...(input.retentionSeconds === undefined
              ? {}
              : { message_retention_period: input.retentionSeconds }),
          },
        });
      }
      return queue;
    },
    onSuccess: async () => {
      setCreateOpen(false);
      setMutationError(null);
      await queryClient.invalidateQueries({
        queryKey: ["cloudflare-v4", "Queues", instanceId],
      });
      feedback.success("Queue created.");
    },
    onError: (error) => {
      setMutationError(
        error instanceof Error ? error.message : "Unable to create the Queue.",
      );
      feedback.failure(error, "Unable to create the Queue.");
    },
  });
  return (
    <OfficialCatalog
      kind="Queues"
      description="Create and configure Queues through the official Queues API."
      load={async (management, instanceID, signal) => {
        const page = await management.queues.list(
          { account_id: instanceID },
          { signal },
        );
        return page.result.map((queue) => ({
          id: queue.queue_id ?? "unknown",
          name: queue.queue_name ?? "Unnamed queue",
          detail: queue.settings?.delivery_paused
            ? "Delivery paused"
            : "Delivery active",
          href: `/queues/${encodeURIComponent(queue.queue_id ?? "unknown")}`,
        }));
      }}
      rename={(management, instanceID, row, name) =>
        management.queues.update(row.id, {
          account_id: instanceID,
          queue_name: name,
        })
      }
      remove={(management, instanceID, row) =>
        management.queues.delete(row.id, { account_id: instanceID })
      }
      primaryAction={
        <>
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            Create Queue
          </Button>
          <QueueConfigDialog
            mode="create"
            open={createOpen}
            errorMessage={createOpen ? mutationError : null}
            isPending={create.isPending}
            onClose={() => {
              setCreateOpen(false);
              setMutationError(null);
            }}
            onSubmit={(input) => create.mutate(input)}
          />
        </>
      }
    />
  );
}
