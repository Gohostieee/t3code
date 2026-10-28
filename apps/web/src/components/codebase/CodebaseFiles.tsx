import { useEffect, useRef, useState } from "react";
import type { CodebaseCheckoutInput, EnvironmentId } from "@t3tools/contracts";
import { codebaseEnvironment } from "../../state/codebase";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";

export function CodebaseFiles({
  environmentId,
  input,
  revision,
  onOpenScope,
}: {
  environmentId: EnvironmentId;
  input: CodebaseCheckoutInput;
  revision: string;
  onOpenScope: (id: string, title: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [changedOnly, setChangedOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const map = useEnvironmentQuery(
    codebaseEnvironment.read({
      environmentId,
      input: {
        ...input,
        scopeId: "overview",
        fileQuery: query,
        fileOffset: offset,
        changedFilesOnly: changedOnly,
      },
    }),
  );
  const refresh = useRef(map.refresh);
  refresh.current = map.refresh;
  useEffect(() => {
    refresh.current();
  }, [revision]);
  const index = map.data?.index;
  return (
    <div className="space-y-4">
      <p className="text-xs leading-5 text-muted-foreground">
        SHA-256 records file bytes. Impact follows literal JavaScript and TypeScript imports,
        workspace packages, and saved source references. Computed imports, runtime behavior, and
        other languages may have additional dependencies.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(search);
          setOffset(0);
        }}
      >
        <input
          aria-label="Search codebase files"
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
          placeholder="Find a file…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button type="submit" variant="outline" size="sm">
          Search
        </Button>
      </form>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={changedOnly}
          onChange={(event) => {
            setChangedOnly(event.target.checked);
            setOffset(0);
          }}
        />
        Changed or unindexed files only
      </label>
      {map.error && (
        <p role="alert" className="text-sm text-destructive">
          {map.error}
        </p>
      )}
      {index && (
        <p className="text-xs text-muted-foreground">
          {index.inspectedFiles} of {index.totalFiles} files fully supplied · {index.changedFiles}{" "}
          changed · {index.staleScopes} maps need review · {index.excludedFiles} excluded from
          source analysis
        </p>
      )}
      {map.isPending && (
        <p role="status" className="text-sm">
          Reading file hashes…
        </p>
      )}
      {index?.files.map((file) => (
        <details
          key={file.path}
          className="border-b pb-3"
          open={expanded === file.path}
          onToggle={(event) => {
            const open = event.currentTarget.open;
            setExpanded((value) => (open ? file.path : value === file.path ? null : value));
          }}
        >
          <summary className="cursor-pointer break-all py-2 text-sm">
            <span className="font-medium">{file.path}</span>
            <span className="ml-2 text-xs text-muted-foreground">
              {file.change} ·{" "}
              {file.inspected ? "fully supplied" : (file.exclusion ?? "analysis pending")} · affects{" "}
              {file.affectedFileCount} files and {file.affectedScopeCount} maps
            </span>
          </summary>
          {expanded === file.path && (
            <div className="space-y-3 pt-2 text-xs">
              <p className="break-all">
                <span className="text-muted-foreground">Current SHA-256: </span>
                <code>{file.sha256 ?? "No regular file"}</code>
              </p>
              {file.previousSha256 !== file.sha256 && (
                <p className="break-all">
                  <span className="text-muted-foreground">Saved SHA-256: </span>
                  <code>{file.previousSha256 ?? "Not indexed"}</code>
                </p>
              )}
              <p className="break-all text-muted-foreground">
                Imports: {file.dependsOn.join(", ") || "No resolved literal imports"}
              </p>
              <p className="break-all text-muted-foreground">
                Affected files: {file.affectedFiles.join(", ") || "None recorded"}
                {file.affectedFileCount > file.affectedFiles.length
                  ? ` (first ${file.affectedFiles.length} of ${file.affectedFileCount})`
                  : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                {file.scopes.map((scope) => (
                  <Button
                    key={scope.scopeId}
                    size="xs"
                    variant="outline"
                    onClick={() => onOpenScope(scope.scopeId, scope.title)}
                  >
                    Open {scope.title}
                  </Button>
                ))}
              </div>
              <p className="text-muted-foreground">
                Potentially affected maps
                {file.affectedScopeCount > file.affectedScopes.length
                  ? ` (first ${file.affectedScopes.length} of ${file.affectedScopeCount})`
                  : ""}
              </p>
              {file.affectedScopes.map((scope) => (
                <button
                  key={scope.scopeId}
                  className="block text-left text-primary hover:underline"
                  onClick={() => onOpenScope(scope.scopeId, scope.title)}
                >
                  {scope.title} · {scope.stale ? "Needs update" : "Current"}
                </button>
              ))}
              {file.affectedScopes.length === 0 && (
                <p className="text-muted-foreground">None recorded</p>
              )}
            </div>
          )}
        </details>
      ))}
      {index && index.files.length === 0 && (
        <p className="text-sm text-muted-foreground">No matching files.</p>
      )}
      {index && (
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset((value) => Math.max(0, value - 50))}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            {index.matchingFiles ? offset + 1 : 0}–{Math.min(offset + 50, index.matchingFiles)} of{" "}
            {index.matchingFiles}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={offset + 50 >= index.matchingFiles}
            onClick={() => setOffset((value) => value + 50)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
