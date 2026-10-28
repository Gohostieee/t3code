import { useOpenInPreferredEditor } from "../editorPreferences";
import { CodebaseAtlas } from "../components/codebase/CodebaseAtlas";
import { AnalysisTranscript } from "../components/codebase/AnalysisTranscript";
import { CodebaseFiles } from "../components/codebase/CodebaseFiles";
import { codebaseGraphLayout } from "../components/codebase/codebaseGraphLayout";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "../components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import { readLocalApi } from "../localApi";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  EllipsisIcon,
  GitBranchIcon,
  InfoIcon,
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
  codebaseExplorationLabel,
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
import { SidebarInset } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
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
  const [legacy, setLegacy] = useState(false);
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
        legacy ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => setLegacy(false)}
            >
              Back to source atlas
            </Button>
            <CodebaseExplorer
              key={`${project.environmentId}:${project.id}:${search.checkout ?? search.thread ?? "main"}`}
              project={project}
              search={search}
            />
          </>
        ) : (
          <CodebaseAtlas
            key={`${project.environmentId}:${project.id}:${search.checkout ?? search.thread ?? "main"}`}
            project={project}
            {...(search.checkout ? { checkout: search.checkout } : {})}
            {...(search.thread ? { thread: search.thread } : {})}
            onLegacy={() => setLegacy(true)}
          />
        )
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
  readOnly = true,
}: {
  project: ReturnType<typeof useProjects>[number];
  search: Search;
  readOnly?: boolean;
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
  const [showInspector, setShowInspector] = useState(false);
  const [override, setOverride] = useState<ModelSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
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
  const exploration = progress.data?.exploration;
  const exploring = exploration?.status === "running";
  const currentRun = progress.data?.runs.find(
    (run) => run.threadId === exploration?.currentThreadId,
  );
  const mapRefresh = useRef(map.refresh);
  mapRefresh.current = map.refresh;
  useEffect(() => {
    if (progress.data) {
      mapRefresh.current();
    }
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
    passKind: scope.id === "overview" ? "overview" : "detail",
    providers,
    chatDefault: project.defaultModelSelection,
    binding:
      map.data?.analyzerBindings?.[scope.id === "overview" ? "overview" : "detail"] ??
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
  const overviewChoice = resolveCodebaseAnalyzer({
    analyzers: map.data?.manifest?.analyzers ?? {},
    passKind: "overview",
    providers,
    chatDefault: project.defaultModelSelection,
    binding:
      map.data?.analyzerBindings?.overview ??
      map.data?.analyzerBindings?.default ??
      chosen.selection,
    override,
  });
  const detailChoice = resolveCodebaseAnalyzer({
    analyzers: map.data?.manifest?.analyzers ?? {},
    passKind: "detail",
    providers,
    chatDefault: project.defaultModelSelection,
    binding:
      map.data?.analyzerBindings?.detail ??
      map.data?.analyzerBindings?.default ??
      overviewChoice.selection,
    override,
  });
  const explorationReason =
    overviewChoice.reason ??
    detailChoice.reason ??
    (detailChoice.selection &&
    map.data?.supportedProviderInstanceIds &&
    !map.data.supportedProviderInstanceIds.includes(detailChoice.selection.instanceId)
      ? "The detail analyzer cannot enforce inspection permissions. Choose a supported analyzer in AI setup."
      : null);
  const start = useAtomCommand(codebaseEnvironment.start);
  const cancel = useAtomCommand(codebaseEnvironment.cancel);
  const configure = useAtomCommand(codebaseEnvironment.configure);
  const graph = map.data?.scope?.graph;
  const node = graph?.nodes.find((entry) => entry.id === selectedId);
  const edge = graph?.edges.find((entry) => entry.id === selectedId);
  const canBuild =
    !readOnly &&
    !busy &&
    !active &&
    !exploring &&
    !!chosen.selection &&
    !chosen.reason &&
    !!map.data?.supportedProviderInstanceIds?.includes(chosen.selection.instanceId) &&
    (!map.data || ["ready", "unbuilt"].includes(map.data.state));
  const choose = (id: string) => {
    setSelectionByScope((previous) => ({ ...previous, [scope.id]: id }));
    setShowInspector(true);
  };
  const explore = (item: CodebaseNode) => {
    const id = item.boundaryScopeId ?? item.childScopeId;
    if (id) {
      setShowInspector(false);
      setHistory((previous) => [
        ...previous,
        { id, title: item.name, parent: item.boundaryScopeId ? null : scope.id },
      ]);
    }
  };
  const build = async (all = false) => {
    if (readOnly) return;
    const model = all ? overviewChoice.selection : chosen.selection;
    if (!model || (all && !detailChoice.selection)) return;
    setBusy(true);
    setError(null);
    const result = await start({
      ...target,
      input: {
        ...target.input,
        scopeId: all ? "overview" : scope.id,
        parentScopeId: all ? null : (map.data?.scope?.parentScopeId ?? scope.parent),
        expectedRevision: (all ? map.data?.overviewRevision : map.data?.revision) ?? null,
        commandId: newCommandId(),
        modelSelection: model,
        ...(all && detailChoice.selection
          ? { exploreAll: true, detailModelSelection: detailChoice.selection }
          : {}),
      },
    });
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    setBusy(false);
  };
  const stopExploration = async () => {
    if (!exploration) return;
    const result = await cancel({
      ...target,
      input: { ...target.input, runThreadId: exploration.rootThreadId },
    });
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
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
  const freshness = map.data?.scope
    ? map.data.freshness === "current"
      ? "Current"
      : map.data.freshness === "stale"
        ? "Needs refresh"
        : "Freshness unknown"
    : "Not built";

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <header
        className={cn(
          "flex min-h-[var(--workspace-topbar-height)] shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5 wco:pr-[var(--workspace-native-controls-inset)]",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          isElectron && "drag-region",
        )}
      >
        <h1 className="sr-only">Codebase</h1>
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <select
            aria-label="Codebase project"
            className="h-8 min-w-0 max-w-36 rounded-md border border-transparent bg-background px-2 font-medium hover:border-border focus-visible:outline-primary"
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
            className="h-8 min-w-0 max-w-36 rounded-md border border-transparent bg-background px-2 text-muted-foreground hover:border-border focus-visible:outline-primary"
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
        </div>
        <nav
          aria-label="Codebase breadcrumbs"
          className="flex min-w-28 flex-1 items-center gap-1 overflow-x-auto text-xs max-sm:order-last max-sm:basis-full"
        >
          {history.length > 1 && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Back one scope"
              onClick={() => {
                setShowInspector(false);
                setHistory((previous) => previous.slice(0, -1));
              }}
            >
              <ArrowLeftIcon />
            </Button>
          )}
          {history.map((entry, index) => (
            <span key={`${entry.id}:${index}`} className="flex shrink-0 items-center gap-2">
              {index > 0 && <span className="text-muted-foreground">/</span>}
              <button
                onClick={() => {
                  setShowInspector(false);
                  setHistory((previous) => previous.slice(0, index + 1));
                }}
                aria-current={index === history.length - 1 ? "page" : undefined}
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
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            aria-label={`Map information: ${freshness}`}
            onClick={() => setShowInfo(true)}
          >
            <InfoIcon className="size-3.5" />
            <span className="max-sm:sr-only">{freshness}</span>
          </Button>
          {!readOnly && (
            <Popover>
              <PopoverTrigger
                render={<Button variant="ghost" size="sm" aria-label="Analysis options" />}
              >
                <Settings2Icon className="size-3.5" />
                <span className="max-w-32 truncate max-sm:sr-only">
                  {chosen.selection?.model ?? "Analyzer"}
                </span>
              </PopoverTrigger>
              <PopoverPopup align="end" className="w-96 max-w-[calc(100vw-2rem)]">
                <PopoverTitle className="mb-4 text-sm">Analysis options</PopoverTitle>
                <AnalyzerPicker
                  selection={chosen.selection}
                  onChange={setOverride}
                  providers={providers}
                  supported={map.data?.supportedProviderInstanceIds ?? []}
                />
                {override && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-3"
                    onClick={() => setOverride(null)}
                  >
                    Use saved analyzer
                  </Button>
                )}
              </PopoverPopup>
            </Popover>
          )}
          <Button
            size="sm"
            disabled={
              readOnly ||
              busy ||
              !!active ||
              exploring ||
              !map.data ||
              !overviewChoice.selection ||
              !!overviewChoice.reason ||
              !!detailChoice.reason ||
              !!explorationReason ||
              !["ready", "unbuilt"].includes(map.data.state) ||
              !map.data.supportedProviderInstanceIds?.includes(overviewChoice.selection.instanceId)
            }
            onClick={() => void build(true)}
          >
            {busy ? "Starting…" : exploring ? "Exploring…" : "Explore codebase"}
          </Button>
          <Menu>
            <MenuTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label="Codebase actions" />}
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem disabled={!canBuild} onClick={() => void build()}>
                Refresh this scope
              </MenuItem>
              <MenuItem onClick={() => setShowFiles(true)}>Files and change impact</MenuItem>
              <MenuItem onClick={() => setShowActivity(true)}>
                <LayersIcon />
                Analysis activity
              </MenuItem>
              <MenuItem
                disabled={readOnly}
                onClick={() => {
                  setSetupSelection(chosen.selection);
                  setShowSetup(true);
                }}
              >
                <Settings2Icon />
                AI setup
              </MenuItem>
              <MenuItem onClick={map.refresh}>
                <RefreshCwIcon />
                Check source freshness
              </MenuItem>
            </MenuPopup>
          </Menu>
          <Button variant="ghost" size="sm" render={<Link to="/" />}>
            Chat
          </Button>
        </div>
      </header>
      {readOnly && (
        <p className="border-b px-5 py-3 text-xs text-muted-foreground">
          Legacy AI map · read-only documentation. Use the source atlas to index this checkout.
        </p>
      )}
      {exploration && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-5 py-3 text-xs">
          <div role="status" aria-live="polite" className="min-w-0 flex-1 space-y-1">
            <p className="break-all font-medium">
              {codebaseExplorationLabel(exploration, currentRun?.analysis)}
            </p>
            <p className="text-muted-foreground">
              {exploration.completedScopes} layers explored · {exploration.discoveredScopes}{" "}
              discovered · {exploration.inspectedFiles} of {exploration.totalFiles} files fully
              supplied{exploration.excludedFiles ? ` · ${exploration.excludedFiles} excluded` : ""}
            </p>
            <progress
              aria-label="Readable file coverage"
              className="h-1.5 w-full max-w-md accent-primary"
              value={exploration.inspectedFiles}
              max={Math.max(1, exploration.totalFiles - exploration.excludedFiles)}
            />
            {exploration.detail && <p className="text-muted-foreground">{exploration.detail}</p>}
          </div>
          <Button variant="ghost" size="xs" onClick={() => setShowActivity(true)}>
            Activity
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setShowFiles(true)}>
            Files and impact
          </Button>
          {exploring && (
            <Button variant="outline" size="xs" onClick={() => void stopExploration()}>
              Stop exploration
            </Button>
          )}
        </div>
      )}
      {map.data?.index && !exploring && (
        <button
          className="border-b px-5 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setShowFiles(true)}
        >
          {map.data.index.changedFiles} changed files · {map.data.index.affectedFiles} potentially
          affected files · {map.data.index.staleScopes} maps need review
        </button>
      )}
      {(error ??
        map.error ??
        progress.error ??
        chosen.reason ??
        explorationReason ??
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
              explorationReason ??
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
          tabIndex={-1}
          onScroll={(event) =>
            positions.current.set(scope.id, {
              x: event.currentTarget.scrollLeft,
              y: event.currentTarget.scrollTop,
            })
          }
          className="relative min-w-0 flex-1 overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
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
                    : "Explore codebase builds the overview, follows every discovered layer, and analyzes remaining source automatically. Browse the maps as they appear."}
                </p>
                <p className="mt-4 text-xs text-muted-foreground">
                  Exploration runs one pass at a time using your analyzer. You can stop and continue
                  later.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
      {(node || edge) && (
        <Dialog
          open={showInspector}
          onOpenChange={(open) => {
            setShowInspector(open);
            if (!open) setSource(null);
          }}
        >
          <DialogContent
            className="max-h-[85dvh] max-w-2xl"
            bottomStickOnMobile={false}
            finalFocus={() =>
              [
                ...(viewport.current?.querySelectorAll<HTMLButtonElement>(
                  "[data-codebase-selection]",
                ) ?? []),
              ].find((element) => element.dataset.codebaseSelection === selectedId) ??
              viewport.current
            }
          >
            <DialogHeader className="pr-14">
              <p className="text-xs text-muted-foreground">
                {node?.kind ?? `${edge?.kind} · ${edge?.evidence}`}
              </p>
              <DialogTitle className="break-words text-lg leading-snug">
                {node?.name ?? edge?.label}
              </DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <DialogDescription className="leading-6">
                {node?.explanation ?? edge?.explanation}
              </DialogDescription>
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
            </DialogPanel>
          </DialogContent>
          {source && map.data && (
            <SourcePreview
              environmentId={project.environmentId}
              checkout={map.data.checkout}
              source={source}
              onClose={() => setSource(null)}
            />
          )}
        </Dialog>
      )}
      <Dialog open={showInfo} onOpenChange={setShowInfo}>
        <DialogContent className="max-h-[85dvh] max-w-xl">
          <DialogHeader>
            <DialogTitle>Map information</DialogTitle>
            <DialogDescription>{freshness}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-5 text-sm">
            <p className="flex items-center gap-2 text-muted-foreground">
              <GitBranchIcon className="size-4 shrink-0" />
              <span className="min-w-0 break-all">
                {map.data?.branch ?? map.data?.head?.slice(0, 8) ?? "Resolving checkout…"}
              </span>
            </p>
            <p className="break-all text-xs text-muted-foreground">
              {map.data?.checkout ?? search.checkout ?? project.workspaceRoot}
            </p>
            {graph && (
              <>
                <p className="leading-6 text-muted-foreground">{graph.summary}</p>
                <section>
                  <h3 className="mb-2 font-medium">Coverage and omissions</h3>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {map.data?.scope?.coverage.referencedFiles} files referenced of{" "}
                    {map.data?.scope?.coverage.inventoryFiles} inventoried;{" "}
                    {map.data?.scope?.coverage.omittedFiles} not supplied,{" "}
                    {map.data?.scope?.coverage.truncatedFiles ?? 0} excerpts truncated.
                  </p>
                  <ul className="mt-3 list-disc space-y-2 pl-5 text-xs leading-5 text-muted-foreground">
                    {graph.omissions.map((omission) => (
                      <li key={omission}>{omission}</li>
                    ))}
                  </ul>
                </section>
              </>
            )}
            <Button variant="outline" size="sm" onClick={map.refresh}>
              <RefreshCwIcon className="size-3.5" />
              Check source freshness
            </Button>
          </DialogPanel>
        </DialogContent>
      </Dialog>
      <Dialog open={showActivity} onOpenChange={setShowActivity}>
        <DialogContent className="max-h-[85dvh] max-w-2xl">
          <DialogHeader>
            <DialogTitle>Analysis activity</DialogTitle>
          </DialogHeader>
          <DialogPanel>
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
          </DialogPanel>
        </DialogContent>
        {transcript && (
          <AnalysisTranscript
            threadRef={{ environmentId: project.environmentId, threadId: transcript }}
            onClose={() => setTranscript(null)}
          />
        )}
      </Dialog>
      <Dialog open={showFiles} onOpenChange={setShowFiles}>
        <DialogContent className="max-h-[85dvh] max-w-3xl">
          <DialogHeader>
            <DialogTitle>Files and change impact</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {showFiles && (
              <CodebaseFiles
                environmentId={project.environmentId}
                input={target.input}
                revision={codebaseProgressRevision(progress.data)}
                onOpenScope={(id, title) => {
                  setShowFiles(false);
                  setShowInspector(false);
                  setHistory((previous) => [...previous, { id, title, parent: null }]);
                }}
              />
            )}
          </DialogPanel>
        </DialogContent>
      </Dialog>
      <Dialog open={showSetup} onOpenChange={setShowSetup}>
        <DialogContent className="max-h-[85dvh] max-w-xl">
          <DialogHeader>
            <DialogTitle>AI setup</DialogTitle>
            <DialogDescription>
              Choose the analyzer for this project. Overview and detail overrides inherit the
              default when unset.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
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
                Save
              </Button>
            </div>
          </DialogPanel>
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
  const canvas = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = canvas.current?.parentElement;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setViewport((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(
    () => codebaseGraphLayout(nodes, edges, viewport),
    [nodes, edges, viewport],
  );
  const byId = new Map(layout.nodes.map((item) => [item.node.id, item]));
  return (
    <div
      ref={canvas}
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
          const x1 = from.x + layout.nodeWidth,
            y1 = from.y + layout.nodeHeight / 2,
            x2 = to.x,
            y2 = to.y + layout.nodeHeight / 2;
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
                  data-codebase-selection={edge.id}
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
            "absolute flex flex-col rounded-lg border bg-card shadow-sm",
            selectedId === node.id ? "border-primary ring-2 ring-primary/20" : "border-border",
          )}
          style={{ left: x, top: y, width: layout.nodeWidth, height: layout.nodeHeight }}
          onContextMenu={(event) => {
            event.preventDefault();
            const api = readLocalApi();
            if (!api) {
              onSelect(node.id);
              return;
            }
            void api.contextMenu
              .show(
                [
                  { id: "inspect", label: "Inspect" },
                  ...(node.childScopeId || node.boundaryScopeId
                    ? [{ id: "explore", label: `Explore ${node.name}` }]
                    : []),
                ],
                { x: event.clientX, y: event.clientY },
              )
              .then((action) => {
                if (action === "inspect") onSelect(node.id);
                if (action === "explore") onExplore(node);
              });
          }}
        >
          <button
            data-codebase-selection={node.id}
            className="block min-h-0 w-full flex-1 rounded-t-lg p-4 text-left focus-visible:outline-2 focus-visible:outline-primary"
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
          <div className="flex shrink-0 items-center justify-between border-t px-4 py-2 text-[11px] text-muted-foreground">
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
