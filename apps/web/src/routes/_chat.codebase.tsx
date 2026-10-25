import { useOpenInPreferredEditor } from "../editorPreferences";
import { AnalysisTranscript } from "../components/codebase/AnalysisTranscript";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { readLocalApi } from "../localApi";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  GitBranchIcon,
  LayersIcon,
  NetworkIcon,
  RefreshCwIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import {
  ThreadId,
  type CodebaseAnalyzers,
  type CodebaseEdge,
  type CodebaseNode,
  type CodebaseSource,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
  isCodebaseAnalysisActive,
} from "@t3tools/contracts";
import {
  codebaseProgressRevision,
  portableCodebaseAnalyzer,
  resolveCodebaseAnalyzer,
} from "@t3tools/client-runtime/state/codebase";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useProjects, useThreadShells } from "../state/entities";
import { codebaseEnvironment } from "../state/codebase";
import { environmentServerConfigsAtom } from "../state/server";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { deriveProviderInstanceEntries, NO_PROVIDER_MODEL_SELECTION } from "../providerInstances";
import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { Button } from "../components/ui/button";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { cn, newCommandId } from "../lib/utils";

type Search = { environment?: string; project?: string; checkout?: string; thread?: string };
export const Route = createFileRoute("/_chat/codebase")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    ...(typeof search.environment === "string" ? { environment: search.environment } : {}),
    ...(typeof search.project === "string" ? { project: search.project } : {}),
    ...(typeof search.checkout === "string" ? { checkout: search.checkout } : {}),
    ...(typeof search.thread === "string" ? { thread: search.thread } : {}),
  }),
  component: CodebaseRoute,
});

function CodebaseRoute() {
  const search = Route.useSearch();
  const projects = useProjects();
  const project =
    projects.find(
      (entry) =>
        entry.id === search.project &&
        (!search.environment || entry.environmentId === search.environment),
    ) ?? (!search.project ? projects[0] : null);
  return (
    <SidebarInset className="min-w-0 overflow-hidden">
      {project ? (
        <CodebaseExplorer
          key={`${project.environmentId}:${project.id}:${search.checkout ?? search.thread ?? "main"}`}
          project={project}
          search={search}
        />
      ) : (
        <div className="m-auto max-w-md p-8 text-center">
          <NetworkIcon className="mx-auto mb-4 size-8 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Explore a codebase</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Add or select a project to explore its architecture.
          </p>
          <Button className="mt-5" render={<Link to="/" />}>
            Back to Chat
          </Button>
        </div>
      )}
    </SidebarInset>
  );
}

function AnalyzerPicker({
  selection,
  onChange,
  providers,
  supported,
}: {
  selection: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
  providers: ReadonlyArray<ServerProvider>;
  supported: readonly string[];
}) {
  const entries = useMemo(() => deriveProviderInstanceEntries(providers), [providers]);
  const models = useMemo(
    () => new Map(entries.map((entry) => [entry.instanceId, entry.models])),
    [entries],
  );
  const current = selection ?? NO_PROVIDER_MODEL_SELECTION;
  const provider = providers.find((entry) => entry.instanceId === current.instanceId);
  const model = provider?.models.find((entry) => entry.slug === current.model);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ProviderModelPicker
        activeInstanceId={current.instanceId}
        model={current.model || "Choose analyzer"}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={models}
        getModelDisabledReason={(instanceId) =>
          supported.includes(instanceId)
            ? null
            : "Inspection permissions are not supported by this adapter yet."
        }
        onInstanceModelChange={(instanceId, model) => onChange({ instanceId, model })}
        triggerAriaLabel="Choose analysis provider and model"
      />
      {selection &&
        model?.capabilities?.optionDescriptors?.map((descriptor) => (
          <label
            key={descriptor.id}
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            {descriptor.label}
            <select
              className="h-8 rounded-md border border-border bg-background px-2 text-foreground"
              aria-label={descriptor.label}
              value={String(
                selection.options?.find((option) => option.id === descriptor.id)?.value ??
                  descriptor.currentValue ??
                  (descriptor.type === "select"
                    ? (descriptor.options.find((option) => option.isDefault)?.id ??
                      descriptor.options[0]?.id ??
                      "")
                    : false),
              )}
              onChange={(event) =>
                onChange({
                  ...selection,
                  options: [
                    ...(selection.options ?? []).filter((option) => option.id !== descriptor.id),
                    {
                      id: descriptor.id,
                      value:
                        descriptor.type === "boolean"
                          ? event.target.value === "true"
                          : event.target.value,
                    },
                  ],
                })
              }
            >
              {descriptor.type === "boolean" ? (
                <>
                  <option value="false">Off</option>
                  <option value="true">On</option>
                </>
              ) : (
                descriptor.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))
              )}
            </select>
          </label>
        ))}
    </div>
  );
}

function SourcePreview({
  environmentId,
  checkout,
  source,
  onClose,
}: {
  environmentId: EnvironmentId;
  checkout: string;
  source: CodebaseSource;
  onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    codebaseEnvironment.source({
      environmentId,
      input: { cwd: checkout, relativePath: source.path },
    }),
  );
  const config = useAtomValue(environmentServerConfigsAtom).get(environmentId);
  const openInEditor = useOpenInPreferredEditor(environmentId, config?.availableEditors ?? []);
  const [editorError, setEditorError] = useState<string | null>(null);
  const lines = query.data?.contents.split("\n");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] max-w-4xl flex-col overflow-hidden"
        showCloseButton={false}
      >
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <DialogTitle className="truncate text-sm font-medium">
            {source.path}:{source.startLine}–{source.endLine}
          </DialogTitle>
          {!!config?.availableEditors.length && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void (async () => {
                  const result = await openInEditor(
                    `${checkout.replaceAll("\\", "/")}/${source.path}:${source.startLine}`,
                  );
                  if (result._tag === "Failure")
                    setEditorError(String(squashAtomCommandFailure(result)));
                })()
              }
            >
              Open in editor
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Close source preview"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </header>
        {editorError && <p role="alert">{editorError}</p>}
        {query.error ? (
          <p role="alert" className="p-4 text-sm text-destructive">
            {query.error}
          </p>
        ) : (
          <pre className="min-h-0 flex-1 overflow-auto p-4 text-xs leading-6">
            {lines
              ?.slice(Math.max(0, source.startLine - 4), source.endLine + 3)
              .map((line, index) => {
                const number = Math.max(1, source.startLine - 3) + index;
                return (
                  <div
                    key={number}
                    className={cn(
                      "px-2",
                      number >= source.startLine && number <= source.endLine && "bg-accent",
                    )}
                  >
                    <span className="mr-4 select-none text-muted-foreground">{number}</span>
                    {line}
                  </div>
                );
              }) ?? "Loading source…"}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CodebaseExplorer({
  project,
  search,
}: {
  project: ReturnType<typeof useProjects>[number];
  search: Search;
}) {
  const navigate = useNavigate();
  const projects = useProjects();
  const threads = useThreadShells();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const providers = configs.get(project.environmentId)?.providers ?? [];
  const [history, setHistory] = useState([
    { id: "overview", title: "Whole app", parent: null as string | null },
  ]);
  const scope = history[history.length - 1]!;
  const [selectionByScope, setSelectionByScope] = useState<Record<string, string | null>>({});
  const selectedId = selectionByScope[scope.id] ?? null;
  const [override, setOverride] = useState<ModelSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [transcript, setTranscript] = useState<ThreadId | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [setupSlot, setSetupSlot] = useState<keyof CodebaseAnalyzers>("default");
  const [setupSelection, setSetupSelection] = useState<ModelSelection | null>(null);
  const [source, setSource] = useState<CodebaseSource | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const target = {
    environmentId: project.environmentId,
    input: {
      projectId: project.id,
      ...(search.thread ? { threadId: ThreadId.make(search.thread) } : {}),
      ...(search.checkout ? { checkout: search.checkout } : {}),
    },
  };
  const map = useEnvironmentQuery(
    codebaseEnvironment.read({ ...target, input: { ...target.input, scopeId: scope.id } }),
  );
  const progress = useEnvironmentQuery(codebaseEnvironment.progress(target));
  const mapRefresh = useRef(map.refresh);
  mapRefresh.current = map.refresh;
  useEffect(() => {
    if (progress.data) mapRefresh.current();
  }, [codebaseProgressRevision(progress.data), scope.id]);
  useEffect(() => {
    const element = viewport.current;
    const restored = positions.current.get(scope.id);
    if (element) {
      element.scrollLeft = restored?.x ?? 0;
      element.scrollTop = restored?.y ?? 0;
    }
  }, [scope.id, map.data?.scope?.scopeId]);
  const chosen = resolveCodebaseAnalyzer({
    analyzers: map.data?.manifest?.analyzers ?? {},
    passKind: (map.data?.scope?.parentScopeId ?? scope.parent) ? "detail" : "overview",
    providers,
    chatDefault: project.defaultModelSelection,
    binding:
      map.data?.analyzerBindings?.[
        (map.data?.scope?.parentScopeId ?? scope.parent) ? "detail" : "overview"
      ] ??
      map.data?.analyzerBindings?.default ??
      progress.data?.runs[0]?.modelSelection,
    override,
  });
  const supportReason =
    chosen.selection &&
    map.data?.supportedProviderInstanceIds &&
    !map.data.supportedProviderInstanceIds.includes(chosen.selection.instanceId)
      ? "This adapter cannot enforce inspection permissions. Choose a supported analyzer."
      : null;
  const active = progress.data?.runs.find(
    (run) => run.analysis.scopeId === scope.id && isCodebaseAnalysisActive(run.analysis.status),
  );
  const start = useAtomCommand(codebaseEnvironment.start);
  const cancel = useAtomCommand(codebaseEnvironment.cancel);
  const configure = useAtomCommand(codebaseEnvironment.configure);
  const graph = map.data?.scope?.graph;
  const node = graph?.nodes.find((entry) => entry.id === selectedId);
  const edge = graph?.edges.find((entry) => entry.id === selectedId);
  const canBuild =
    !busy &&
    !active &&
    !!chosen.selection &&
    !chosen.reason &&
    !!map.data?.supportedProviderInstanceIds?.includes(chosen.selection.instanceId) &&
    (!map.data || ["ready", "unbuilt"].includes(map.data.state));
  const choose = (id: string) =>
    setSelectionByScope((previous) => ({ ...previous, [scope.id]: id }));
  const explore = (item: CodebaseNode) => {
    const id = item.boundaryScopeId ?? item.childScopeId;
    if (id)
      setHistory((previous) => [
        ...previous,
        { id, title: item.name, parent: item.boundaryScopeId ? null : scope.id },
      ]);
  };
  const build = async () => {
    if (!chosen.selection) return;
    setBusy(true);
    setError(null);
    const result = await start({
      ...target,
      input: {
        ...target.input,
        scopeId: scope.id,
        parentScopeId: map.data?.scope?.parentScopeId ?? scope.parent,
        expectedRevision: map.data?.revision ?? null,
        commandId: newCommandId(),
        modelSelection: chosen.selection,
      },
    });
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    setBusy(false);
  };
  const sourceLinks = (sources: ReadonlyArray<CodebaseSource>) =>
    sources.map((item, index) => (
      <button
        key={`${item.path}:${item.startLine}:${index}`}
        className="block max-w-full truncate py-1 text-left text-xs text-primary underline-offset-4 hover:underline"
        onClick={() => setSource(item)}
      >
        {item.path}:{item.startLine} ↗
      </button>
    ));
  const worktrees = map.data?.worktrees ?? [
    ...new Set([
      project.workspaceRoot,
      ...threads
        .filter(
          (thread) =>
            thread.projectId === project.id && thread.environmentId === project.environmentId,
        )
        .flatMap((thread) => (thread.worktreePath ? [thread.worktreePath] : [])),
    ]),
  ];

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div className="flex items-center gap-3">
          <SidebarTrigger />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Codebase</h1>
            <p className="text-xs text-muted-foreground">A shared map of your project.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowActivity(!showActivity)}>
            <LayersIcon className="size-4" />
            Analysis activity
          </Button>
          <Button variant="ghost" size="sm" render={<Link to="/" />}>
            Chat
          </Button>
        </div>
      </header>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3 text-xs">
          <select
            aria-label="Codebase project"
            className="max-w-52 rounded border bg-background px-2 py-1.5"
            value={`${project.environmentId}:${project.id}`}
            onChange={(event) => {
              const next = projects.find(
                (entry) => `${entry.environmentId}:${entry.id}` === event.target.value,
              );
              if (next)
                void navigate({
                  to: "/codebase",
                  search: { environment: next.environmentId, project: next.id },
                });
            }}
          >
            {projects.map((entry) => (
              <option
                key={`${entry.environmentId}:${entry.id}`}
                value={`${entry.environmentId}:${entry.id}`}
              >
                {entry.title}
              </option>
            ))}
          </select>
          <select
            aria-label="Codebase checkout"
            className="max-w-64 rounded border bg-background px-2 py-1.5"
            value={map.data?.checkout ?? search.checkout ?? project.workspaceRoot}
            onChange={(event) =>
              void navigate({
                to: "/codebase",
                search: {
                  environment: project.environmentId,
                  project: project.id,
                  checkout: event.target.value,
                },
              })
            }
          >
            {worktrees.map((path) => (
              <option key={path} value={path}>
                {path === project.workspaceRoot ? "Main checkout" : path.split(/[/\\]/).at(-1)}
              </option>
            ))}
          </select>
          <span className="flex items-center gap-1 text-muted-foreground">
            <GitBranchIcon className="size-3" />
            {map.data?.branch ?? map.data?.head?.slice(0, 8) ?? "Resolving checkout…"}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          {map.data?.scope
            ? map.data.freshness === "current"
              ? "Current"
              : map.data.freshness === "stale"
                ? "Needs refresh"
                : "Freshness unknown"
            : "Not built"}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <nav
          aria-label="Codebase breadcrumbs"
          className="flex flex-wrap items-center gap-2 text-xs"
        >
          {history.length > 1 && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Back one scope"
              onClick={() => setHistory((previous) => previous.slice(0, -1))}
            >
              <ArrowLeftIcon />
            </Button>
          )}
          {history.map((entry, index) => (
            <span key={`${entry.id}:${index}`} className="flex items-center gap-2">
              {index > 0 && <span className="text-muted-foreground">/</span>}
              <button
                onClick={() => setHistory((previous) => previous.slice(0, index + 1))}
                className={
                  index === history.length - 1
                    ? "font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }
              >
                {entry.title}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <AnalyzerPicker
            selection={chosen.selection}
            onChange={setOverride}
            providers={providers}
            supported={map.data?.supportedProviderInstanceIds ?? []}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="AI setup"
            onClick={() => {
              setSetupSelection(chosen.selection);
              setShowSetup(true);
            }}
          >
            <Settings2Icon />
          </Button>
          <Button size="sm" disabled={!canBuild} onClick={() => void build()}>
            {active
              ? active.analysis.status
              : busy
                ? "Starting…"
                : graph
                  ? "Refresh this scope"
                  : scope.parent
                    ? "Build this layer"
                    : "Build overview"}
          </Button>
        </div>
      </div>
      {(error ??
        map.error ??
        progress.error ??
        chosen.reason ??
        supportReason ??
        map.data?.detail) && (
        <div
          role="alert"
          className="flex items-center justify-between gap-4 border-b bg-muted/40 px-5 py-3 text-sm"
        >
          <span>
            {error ??
              map.error ??
              progress.error ??
              chosen.reason ??
              supportReason ??
              map.data?.detail}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setError(null);
              map.refresh();
            }}
          >
            Reload
          </Button>
        </div>
      )}
      {map.data?.ignored && (
        <p className="border-b px-5 py-2 text-xs text-muted-foreground">
          Git ignores this map directory. Adjust your ignore rules if you want the map included in
          commits.
        </p>
      )}
      {map.data?.freshness === "stale" && (
        <p className="border-b px-5 py-2 text-xs text-muted-foreground">
          Source or analysis settings have changed since this map was built. It remains readable;
          refresh this scope when you’re ready.
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <div
          ref={viewport}
          onScroll={(event) =>
            positions.current.set(scope.id, {
              x: event.currentTarget.scrollLeft,
              y: event.currentTarget.scrollTop,
            })
          }
          className="relative min-w-0 flex-1 overflow-auto"
          style={{
            backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }}
        >
          {graph ? (
            <CodebaseGraphView
              nodes={graph.nodes}
              edges={graph.edges}
              selectedId={selectedId}
              onSelect={choose}
              onExplore={explore}
            />
          ) : (
            <div className="flex h-full min-h-72 items-center justify-center p-8">
              <div className="max-w-md text-center">
                <NetworkIcon className="mx-auto mb-4 size-8 text-muted-foreground" />
                <h2 className="text-lg font-medium">
                  {map.isPending
                    ? "Reading the map…"
                    : scope.parent
                      ? `Explore ${scope.title}`
                      : "See how your project fits together"}
                </h2>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  {map.data && !["ready", "unbuilt"].includes(map.data.state)
                    ? "Resolve the map file issue and reload to continue."
                    : "Build one layer at a time. Start with the main systems, then explore the parts you want to understand."}
                </p>
                <p className="mt-4 text-xs text-muted-foreground">
                  Analysis starts only when you choose Build.
                </p>
              </div>
            </div>
          )}
        </div>
        {(node || edge) && (
          <aside
            className="w-80 shrink-0 overflow-y-auto border-l bg-background p-5 max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:z-10 max-md:max-h-[55%] max-md:w-auto max-md:border-t"
            aria-label="Codebase inspector"
          >
            <div className="mb-5 flex items-start justify-between gap-2">
              <div>
                <p className="mb-2 text-xs text-muted-foreground">
                  {node?.kind ?? `${edge?.kind} · ${edge?.evidence}`}
                </p>
                <h2 className="text-base font-semibold">{node?.name ?? edge?.label}</h2>
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Close inspector"
                onClick={() =>
                  setSelectionByScope((previous) => ({ ...previous, [scope.id]: null }))
                }
              >
                <XIcon />
              </Button>
            </div>
            <p className="text-sm leading-6 text-muted-foreground">
              {node?.explanation ?? edge?.explanation}
            </p>
            {node && (
              <>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {node.technologies.map((tech) => (
                    <span className="rounded border px-2 py-0.5 text-xs" key={tech}>
                      {tech}
                    </span>
                  ))}
                </div>
                {[
                  ...[...(node.inputs ?? [])].map((value) => `Input: ${value}`),
                  ...[...(node.outputs ?? [])].map((value) => `Output: ${value}`),
                  ...[...(node.sideEffects ?? [])].map((value) => `Effect: ${value}`),
                ].map((value) => (
                  <p className="mt-3 text-xs text-muted-foreground" key={value}>
                    {value}
                  </p>
                ))}
                <h3 className="mb-2 mt-6 border-t pt-5 text-xs font-medium">Connections</h3>
                {graph?.edges
                  .filter((item) => item.from === node.id || item.to === node.id)
                  .map((item) => (
                    <button
                      className="block py-2 text-left text-xs text-primary"
                      key={item.id}
                      onClick={() => choose(item.id)}
                    >
                      {item.from === node.id ? "→" : "←"} {item.label}
                    </button>
                  ))}
              </>
            )}
            {edge && (
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                <button className="text-primary" onClick={() => choose(edge.from)}>
                  {graph?.nodes.find((item) => item.id === edge.from)?.name}
                </button>
                <ArrowRightIcon className="size-3" />
                <button className="text-primary" onClick={() => choose(edge.to)}>
                  {graph?.nodes.find((item) => item.id === edge.to)?.name}
                </button>
              </div>
            )}
            <h3 className="mb-2 mt-6 border-t pt-5 text-xs font-medium">Source references</h3>
            {sourceLinks(node?.sources ?? edge?.sources ?? [])}
            {node && (node.childScopeId || node.boundaryScopeId) && (
              <Button className="mt-6 w-full" variant="outline" onClick={() => explore(node)}>
                Explore {node.name}
                <ArrowRightIcon className="size-4" />
              </Button>
            )}
          </aside>
        )}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t px-5 py-3 text-xs text-muted-foreground">
        <span>{graph?.summary ?? "Deeper layers are built only when you explore them."}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Check source freshness"
          onClick={map.refresh}
        >
          <RefreshCwIcon />
        </Button>
      </footer>
      {graph && (
        <details className="shrink-0 border-t px-5 py-2 text-xs text-muted-foreground">
          <summary>
            Coverage and omissions · {map.data?.scope?.coverage.referencedFiles} files referenced of{" "}
            {map.data?.scope?.coverage.inventoryFiles} inventoried;{" "}
            {map.data?.scope?.coverage.omittedFiles} not supplied,{" "}
            {map.data?.scope?.coverage.truncatedFiles ?? 0} excerpts truncated
          </summary>
          <ul className="mt-2 list-disc pl-5">
            {graph.omissions.map((omission) => (
              <li key={omission}>{omission}</li>
            ))}
          </ul>
        </details>
      )}
      {source && map.data && (
        <SourcePreview
          environmentId={project.environmentId}
          checkout={map.data.checkout}
          source={source}
          onClose={() => setSource(null)}
        />
      )}
      {showActivity && (
        <section
          className="absolute inset-y-0 right-0 z-20 w-96 max-w-full overflow-auto border-l bg-background p-5 shadow-xl"
          aria-label="Analysis activity"
        >
          <header className="mb-6 flex items-center justify-between">
            <h2 className="font-semibold">Analysis activity</h2>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close analysis activity"
              onClick={() => setShowActivity(false)}
            >
              <XIcon />
            </Button>
          </header>
          {progress.data?.runs.length ? (
            progress.data.runs.map((run) => (
              <article className="border-b py-4" key={run.threadId}>
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium">{run.analysis.scopeId}</span>
                  <span className="text-xs text-muted-foreground">{run.analysis.status}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{run.modelSelection.model}</p>
                {run.analysis.detail && (
                  <p className="mt-3 text-xs leading-5">{run.analysis.detail}</p>
                )}
                <div className="mt-3 flex gap-2">
                  <Button variant="outline" size="xs" onClick={() => setTranscript(run.threadId)}>
                    View transcript
                  </Button>
                  {isCodebaseAnalysisActive(run.analysis.status) && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        void (async () => {
                          const result = await cancel({
                            ...target,
                            input: { ...target.input, runThreadId: run.threadId },
                          });
                          if (result._tag === "Failure")
                            setError(String(squashAtomCommandFailure(result)));
                        })()
                      }
                    >
                      Cancel analysis
                    </Button>
                  )}
                </div>
              </article>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No analysis has run in this checkout.</p>
          )}
        </section>
      )}
      {transcript && (
        <AnalysisTranscript
          threadRef={{ environmentId: project.environmentId, threadId: transcript }}
          onClose={() => setTranscript(null)}
        />
      )}
      <Dialog open={showSetup} onOpenChange={setShowSetup}>
        <DialogContent className="max-w-xl">
          <header className="mb-5 flex items-center justify-between">
            <DialogTitle>AI setup</DialogTitle>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close AI setup"
              onClick={() => setShowSetup(false)}
            >
              <XIcon />
            </Button>
          </header>
          <p className="mb-5 text-sm text-muted-foreground">
            Choose the analyzer for this project. Overview and detail overrides inherit the default
            when unset.
          </p>
          <label className="mb-4 flex items-center gap-3 text-sm">
            Applies to
            <select
              className="rounded border bg-background p-2"
              value={setupSlot}
              onChange={(event) => {
                const slot = event.target.value as keyof CodebaseAnalyzers;
                setSetupSlot(slot);
                setSetupSelection(
                  resolveCodebaseAnalyzer({
                    analyzers: {
                      default:
                        map.data?.manifest?.analyzers[slot] ??
                        map.data?.manifest?.analyzers.default,
                    },
                    passKind: "overview",
                    providers,
                    chatDefault: project.defaultModelSelection,
                    binding: chosen.selection,
                  }).selection,
                );
              }}
            >
              <option value="default">Default analyzer</option>
              <option value="overview">Overview passes</option>
              <option value="detail">Detail passes</option>
            </select>
          </label>
          <AnalyzerPicker
            selection={setupSelection}
            onChange={setSetupSelection}
            providers={providers}
            supported={map.data?.supportedProviderInstanceIds ?? []}
          />
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowSetup(false)}>
              Discard
            </Button>
            {setupSlot !== "default" && (
              <Button
                variant="outline"
                onClick={() =>
                  void (async () => {
                    const analyzers = { ...map.data?.manifest?.analyzers };
                    delete analyzers[setupSlot];
                    const result = await configure({
                      ...target,
                      input: {
                        ...target.input,
                        expectedRevision: map.data?.configurationRevision ?? null,
                        analyzers,
                        analyzerBindings: { [setupSlot]: null },
                      },
                    });
                    if (result._tag === "Failure")
                      setError(String(squashAtomCommandFailure(result)));
                    else {
                      setShowSetup(false);
                      setOverride(null);
                      map.refresh();
                    }
                  })()
                }
              >
                Use default
              </Button>
            )}
            <Button
              disabled={!setupSelection}
              onClick={() =>
                void (async () => {
                  if (!setupSelection) return;
                  const preference = portableCodebaseAnalyzer(setupSelection, providers);
                  if (!preference) return;
                  const result = await configure({
                    ...target,
                    input: {
                      ...target.input,
                      expectedRevision: map.data?.configurationRevision ?? null,
                      analyzers: { ...map.data?.manifest?.analyzers, [setupSlot]: preference },
                      analyzerBindings: { [setupSlot]: setupSelection },
                    },
                  });
                  if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
                  else {
                    setShowSetup(false);
                    setOverride(null);
                    map.refresh();
                  }
                })()
              }
            >
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CodebaseGraphView({
  nodes,
  edges,
  selectedId,
  onSelect,
  onExplore,
}: {
  nodes: ReadonlyArray<CodebaseNode>;
  edges: ReadonlyArray<CodebaseEdge>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onExplore: (node: CodebaseNode) => void;
}) {
  const layout = useMemo(() => {
    const incoming = new Set(edges.map((edge) => edge.to));
    const outgoing = new Set(edges.map((edge) => edge.from));
    const columns = [
      nodes.filter((node) => !incoming.has(node.id)),
      nodes.filter((node) => incoming.has(node.id) && outgoing.has(node.id)),
      nodes.filter((node) => incoming.has(node.id) && !outgoing.has(node.id)),
    ].filter((column) => column.length);
    const height = Math.max(520, ...columns.map((column) => column.length * 184 + 80));
    return {
      width: Math.max(700, columns.length * 310 + 40),
      height,
      nodes: columns.flatMap((column, x) =>
        column.map((node, y) => ({
          node,
          x: 32 + x * 310,
          y: 40 + y * ((height - 80) / column.length),
        })),
      ),
    };
  }, [nodes, edges]);
  const byId = new Map(layout.nodes.map((item) => [item.node.id, item]));
  return (
    <div
      className="relative"
      style={{ width: layout.width, height: layout.height }}
      aria-label="Architecture map"
    >
      <svg
        className="absolute inset-0"
        width={layout.width}
        height={layout.height}
        aria-label="Architecture connections"
      >
        <defs>
          <marker
            id="codebase-arrow"
            markerWidth="7"
            markerHeight="7"
            refX="6"
            refY="3.5"
            orient="auto"
          >
            <path d="M0 0L7 3.5L0 7" fill="currentColor" />
          </marker>
        </defs>
        {edges.map((edge) => {
          const from = byId.get(edge.from),
            to = byId.get(edge.to);
          if (!from || !to) return null;
          const x1 = from.x + 236,
            y1 = from.y + 65,
            x2 = to.x,
            y2 = to.y + 65;
          const path = `M${x1},${y1} C${x1 + 65},${y1} ${x2 - 65},${y2} ${x2},${y2}`;
          return (
            <g
              key={edge.id}
              className={selectedId === edge.id ? "text-primary" : "text-muted-foreground/45"}
            >
              <path
                d={path}
                fill="none"
                stroke="currentColor"
                strokeWidth={selectedId === edge.id ? 2 : 1.2}
                strokeDasharray={edge.evidence === "inferred" ? "4 4" : undefined}
                markerEnd="url(#codebase-arrow)"
              />
              <path
                d={path}
                fill="none"
                stroke="transparent"
                strokeWidth="14"
                className="cursor-pointer"
                onClick={() => onSelect(edge.id)}
              />
              <foreignObject x={(x1 + x2) / 2 - 48} y={(y1 + y2) / 2 - 10} width="96" height="28">
                <button
                  className="w-full truncate rounded border border-border bg-background px-1.5 py-1 text-[10px] text-muted-foreground hover:text-foreground"
                  title={edge.label}
                  onClick={() => onSelect(edge.id)}
                >
                  {edge.label}
                </button>
              </foreignObject>
            </g>
          );
        })}
      </svg>
      {layout.nodes.map(({ node, x, y }) => (
        <article
          key={node.id}
          className={cn(
            "absolute w-[236px] rounded-lg border bg-card shadow-sm",
            selectedId === node.id ? "border-primary ring-2 ring-primary/20" : "border-border",
          )}
          style={{ left: x, top: y }}
          onDoubleClick={() => onExplore(node)}
          onContextMenu={(event) => {
            event.preventDefault();
            onSelect(node.id);
            void readLocalApi()
              ?.contextMenu.show(
                [
                  { id: "inspect", label: "Inspect" },
                  ...(node.childScopeId || node.boundaryScopeId
                    ? [{ id: "explore", label: `Explore ${node.name}` }]
                    : []),
                ],
                { x: event.clientX, y: event.clientY },
              )
              .then((action) => {
                if (action === "explore") onExplore(node);
              });
          }}
        >
          <button
            className="block w-full rounded-t-lg p-4 text-left focus-visible:outline-2 focus-visible:outline-primary"
            onClick={() => onSelect(node.id)}
            aria-pressed={selectedId === node.id}
          >
            <h3 className="truncate text-sm font-semibold">{node.name}</h3>
            <p className="mt-1 truncate text-[11px] text-muted-foreground">
              {node.sources[0]?.path ?? node.kind}
            </p>
            <p className="mt-3 line-clamp-2 text-xs leading-5 text-muted-foreground">
              {node.responsibility}
            </p>
          </button>
          <div className="flex items-center justify-between border-t px-4 py-2 text-[11px] text-muted-foreground">
            <span>{node.childScopeId ? "Expand on demand" : "Overview"}</span>
            {(node.childScopeId || node.boundaryScopeId) && (
              <button
                className="flex items-center gap-1 text-primary"
                onClick={() => onExplore(node)}
              >
                Explore <ArrowRightIcon className="size-3" />
              </button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
