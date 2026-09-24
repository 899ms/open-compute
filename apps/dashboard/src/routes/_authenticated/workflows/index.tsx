import { Button } from "@cloudflare/kumo/components/button";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { OfficialCatalog } from "../../../components/official-catalog";
import { WorkflowDefinitionDialog } from "../../../components/workflow-definition-dialog";
import { useAuth } from "../../../features/auth/auth-atoms";
import { useMutationFeedback } from "../../../features/toast/use-mutation-feedback";

export const Route = createFileRoute("/_authenticated/workflows/")({
  component: WorkflowsPage,
});

function WorkflowsPage() {
  const { client, instanceId } = useAuth();
  const queryClient = useQueryClient();
  const feedback = useMutationFeedback();
  const [createOpen, setCreateOpen] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (input: {
      name?: string;
      scriptName: string;
      className: string;
    }) => {
      if (!input.name) throw new Error("Workflow name is required.");
      return client!.workflows.update(input.name, {
        account_id: instanceId!,
        script_name: input.scriptName,
        class_name: input.className,
      });
    },
    onSuccess: async () => {
      setCreateOpen(false);
      setMutationError(null);
      await queryClient.invalidateQueries({
        queryKey: ["cloudflare-v4", "Workflows", instanceId],
      });
      feedback.success("Workflow created.");
    },
    onError: (error) => {
      setMutationError(
        error instanceof Error
          ? error.message
          : "Unable to create the Workflow.",
      );
      feedback.failure(error, "Unable to create the Workflow.");
    },
  });
  return (
    <OfficialCatalog
      kind="Workflows"
      description="Create definitions and manage Workflows through the official Workflows API."
      load={async (management, instanceID, signal) => {
        const page = await management.workflows.list(
          { account_id: instanceID },
          { signal },
        );
        return page.result.map((workflow) => ({
          id: workflow.name,
          name: workflow.name,
          detail: `${workflow.script_name} / ${workflow.class_name}`,
          href: `/workflows/${encodeURIComponent(workflow.name)}`,
        }));
      }}
      remove={(management, instanceID, row) =>
        management.workflows.delete(row.id, {
          account_id: instanceID,
        })
      }
      primaryAction={
        <>
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            Create Workflow
          </Button>
          <WorkflowDefinitionDialog
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
