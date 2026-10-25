import type { ScopedThreadRef } from "@t3tools/contracts";
import { useThreadDetail, useThreadStatus } from "../../state/entities";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";

/** Analysis has a normal durable thread but no chat composer or conversation-list entry. */
export function AnalysisTranscript({
  threadRef,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  onClose: () => void;
}) {
  const thread = useThreadDetail(threadRef);
  const status = useThreadStatus(threadRef);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogTitle>Analysis transcript</DialogTitle>
        <p className="text-sm text-muted-foreground">
          {thread?.analysis?.status ?? status} · {thread?.modelSelection.model}
        </p>
        {thread?.analysis?.detail && (
          <p role="alert" className="text-sm">
            {thread.analysis.detail}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          This inspection attempt is read-only. Start another pass from Codebase to retry.
        </p>
        {thread?.messages.map((message) => (
          <details
            key={message.id}
            open={message.role === "assistant"}
            className="rounded-lg border p-3"
          >
            <summary className="cursor-pointer text-sm font-medium">
              {message.role === "user" ? "Analysis scope and source bundle" : "Assistant result"}
              {message.streaming ? " · Receiving" : ""}
            </summary>
            <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs leading-5">
              {message.text}
            </pre>
          </details>
        ))}
        {thread?.activities.length ? (
          <details>
            <summary className="text-sm">Provider activity</summary>
            <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
              {thread.activities.map((activity) => (
                <li key={activity.id}>
                  {activity.kind} · {activity.summary}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
