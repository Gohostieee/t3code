import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CameraIcon,
  FileCodeIcon,
  GitBranchIcon,
  NetworkIcon,
  RefreshCwIcon,
  Settings2Icon,
} from "lucide-react";
import {
  ThreadId,
  type AtlasNode,
  type AtlasScenario,
  type AtlasFeature,
  type AtlasDocumentation,
  type CodebaseAtlasInput,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useProjects, useThreadShells } from "../../state/entities";
import { codebaseEnvironment } from "../../state/codebase";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentHttpBaseUrl, useEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogPanel,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { cn, newCommandId } from "../../lib/utils";
import { AtlasGraph } from "./AtlasGraph";
import type { CodebaseAtlasSnapshot, AtlasCapture } from "@t3tools/contracts";

const field =
  "h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring";
const running = (status: string) =>
  [
    "queued",
    "inventorying",
    "parsing",
    "resolving",
    "validating",
    "publishing",
    "capturing",
  ].includes(status);
type Project = ReturnType<typeof useProjects>[number];
type Props = { project: Project; checkout?: string; thread?: string; onLegacy: () => void };
type Action = CodebaseAtlasInput["action"];

function AtlasSource({
  project,
  checkout,
  node,
  onClose,
}: {
  project: Project;
  checkout: string;
  node: AtlasNode;
  onClose: () => void;
}) {
  const result = useEnvironmentQuery(
    codebaseEnvironment.source({
      environmentId: project.environmentId,
      input: { cwd: checkout, relativePath: node.source.path },
    }),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-4xl overflow-auto">
        <DialogHeader>
          <DialogTitle>
            {node.source.path}:{node.source.startLine}
          </DialogTitle>
          <DialogDescription>Source evidence for {node.label}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <pre className="overflow-auto text-xs leading-6">
            {result.error ?? result.data?.contents ?? "Loading source…"}
          </pre>
        </DialogPanel>
      </DialogContent>
    </Dialog>
  );
}

export function CodebaseAtlas({ project, checkout, thread, onLegacy }: Props) {
  const projects = useProjects();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const httpBase = useEnvironmentHttpBaseUrl(project.environmentId);
  const environment = useEnvironment(project.environmentId);
  const [appRoot, setAppRoot] = useState<string>();
  const [view, setView] = useState<"routes" | "modules" | "features" | "files" | "diagnostics">(
    "routes",
  );
  const [query, setQuery] = useState("");
  const [ungrouped, setUngrouped] = useState(false);
  const [selectedScenarios, setSelectedScenarios] = useState<Record<string, string>>({});
  const [offset, setOffset] = useState(0);
  const [graphView, setGraphView] = useState(true);
  const [history, setHistory] = useState<Pick<AtlasNode, "id" | "label">[]>([]);
  const canvas = useRef<HTMLElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const [inspect, setInspect] = useState<AtlasNode | null>(null);
  const [source, setSource] = useState<AtlasNode | null>(null);
  const [setup, setSetup] = useState(false);
  const [scenario, setScenario] = useState<AtlasScenario | null>(null);
  const [feature, setFeature] = useState<AtlasFeature | null>(null);
  const [image, setImage] = useState<{ url: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const target = {
    environmentId: project.environmentId,
    input: {
      projectId: project.id,
      ...(thread ? { threadId: ThreadId.make(thread) } : {}),
      ...(checkout ? { checkout } : {}),
    },
  };
  const focus = history.at(-1);
  const locationKey = `${appRoot ?? ""}:${view}:${focus?.id ?? "root"}:${offset}:${query}`;
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    element.scrollTop = scrollPositions.current.get(locationKey) ?? 0;
    return () => {
      scrollPositions.current.set(locationKey, element.scrollTop);
    };
  }, [locationKey]);
  const result = useEnvironmentQuery(
    codebaseEnvironment.atlas({
      ...target,
      input: {
        ...target.input,
        ...(appRoot ? { appRoot } : {}),
        action: { type: "read" },
        view: view === "features" ? "routes" : view,
        query,
        ungrouped: view === "routes" && ungrouped,
        offset,
        verifyFreshness: !query && !focus && offset === 0,
        ...(focus ? { nodeId: focus.id } : {}),
      },
    }),
  );
  const progress = useEnvironmentQuery(codebaseEnvironment.progress(target));
  const refresh = useRef(result.refresh);
  refresh.current = result.refresh;
  useEffect(() => {
    refresh.current();
  }, [progress.data?.atlasRevision, progress.data?.diskRevision]);
  const command = useAtomCommand(codebaseEnvironment.atlasCommand);
  const data = result.data;
  const run = async (action: Action) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const response = await command({
        ...target,
        input: { ...target.input, ...(data?.appRoot ? { appRoot: data.appRoot } : {}), action },
      });
      if (response._tag === "Failure") {
        setError(String(squashAtomCommandFailure(response)));
        return false;
      }
      result.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  };
  const saveDocs = (documentation: AtlasDocumentation) =>
    run({
      type: "documentation",
      expectedRevision: data?.documentationRevision ?? null,
      documentation,
    });
  const draftScenario = (node: AtlasNode): AtlasScenario => ({
    id: `scenario_${newCommandId()}`,
    routeId: node.id,
    name: "Default",
    parameters: Object.fromEntries(node.parameters.map((p) => [p.name, ""])),
    query: {},
    viewport: "desktop",
    theme: "light",
    readiness: { kind: "text", value: "" },
  });
  const imageUrl = (relative: string | undefined) =>
    relative && httpBase ? new URL(relative, httpBase).toString() : null;
  const worktrees = [
    ...new Set([
      project.workspaceRoot,
      ...threads
        .filter((t) => t.projectId === project.id && t.environmentId === project.environmentId)
        .flatMap((t) => (t.worktreePath ? [t.worktreePath] : [])),
      ...(checkout ? [checkout] : []),
    ]),
  ];
  const currentJobs = data?.jobs.filter((j) => running(j.status)) ?? [];
  const changeView = (next: typeof view) => {
    setView(next);
    setOffset(0);
    setHistory([]);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header
        className={cn(
          "flex min-h-(--workspace-topbar-height) flex-wrap items-center gap-2 border-b px-3 py-2 wco:pr-[var(--workspace-native-controls-inset)]",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Back to chat"
          onClick={() => void navigate({ to: "/" })}
        >
          <ArrowLeftIcon />
        </Button>
        <NetworkIcon className="size-4 text-muted-foreground" />
        <span className="mr-1 text-sm font-semibold">Codebase</span>
        <select
          aria-label="Project"
          className="max-w-44 bg-transparent text-sm"
          value={`${project.environmentId}:${project.id}`}
          onChange={(e) => {
            const next = projects.find((p) => `${p.environmentId}:${p.id}` === e.target.value);
            if (next)
              void navigate({
                to: "/codebase",
                search: { environment: next.environmentId, project: next.id },
              });
          }}
        >
          {projects.map((p) => (
            <option key={`${p.environmentId}:${p.id}`} value={`${p.environmentId}:${p.id}`}>
              {p.title}
            </option>
          ))}
        </select>
        <select
          aria-label="Application"
          className="max-w-52 bg-transparent text-sm"
          value={data?.appRoot ?? appRoot ?? ""}
          onChange={(e) => {
            setAppRoot(e.target.value);
            setHistory([]);
            setOffset(0);
          }}
        >
          {data?.apps.map((a) => (
            <option key={a.root} value={a.root}>
              {a.name} · {a.framework}
            </option>
          ))}
        </select>
        <select
          aria-label="Checkout"
          className="max-w-40 bg-transparent text-xs text-muted-foreground"
          value={data?.checkout ?? checkout ?? project.workspaceRoot}
          onChange={(e) =>
            void navigate({
              to: "/codebase",
              search: {
                environment: project.environmentId,
                project: project.id,
                checkout: e.target.value,
              },
            })
          }
        >
          {worktrees.map((w) => (
            <option key={w} value={w}>
              {w.split(/[\\/]/).at(-1)}
            </option>
          ))}
        </select>
        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <GitBranchIcon className="size-3" />
          {data?.branch ?? "detached"} · {data?.freshness ?? "unknown"}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={!data || busy || currentJobs.some((j) => j.kind === "index")}
          onClick={() =>
            void run({
              type: "index",
              commandId: newCommandId(),
              expectedRevision: data?.revision ?? null,
            })
          }
        >
          <RefreshCwIcon />
          {data?.revision ? "Refresh index" : "Index codebase"}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Preview setup and activity"
          onClick={() => setSetup(true)}
        >
          <Settings2Icon />
        </Button>
        <Button size="sm" variant="ghost" onClick={onLegacy}>
          Legacy AI map
        </Button>
      </header>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        {(["routes", "modules", "features", "files", "diagnostics"] as const).map((v) => (
          <Button
            key={v}
            size="sm"
            variant={view === v ? "secondary" : "ghost"}
            aria-pressed={view === v}
            onClick={() => changeView(v)}
          >
            {v[0]!.toUpperCase() + v.slice(1)}
          </Button>
        ))}
        <input
          aria-label="Search atlas"
          placeholder={`Search ${view}…`}
          className={cn(field, "ml-auto max-w-64")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
          }}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setFeature({ id: `feature_${newCommandId()}`, name: "", description: "", members: [] })
          }
        >
          New feature
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={graphView}
          onClick={() => setGraphView(!graphView)}
        >
          {graphView ? "Show list" : "Show map"}
        </Button>
      </div>
      {(error || result.error || data?.detail) && (
        <p role="alert" className="border-b px-4 py-3 text-sm text-destructive">
          {error ?? result.error ?? data?.detail}
        </p>
      )}
      {view === "routes" && (
        <label className="flex items-center gap-2 px-4 py-2 text-xs">
          <input
            type="checkbox"
            checked={ungrouped}
            onChange={(e) => {
              setUngrouped(e.target.checked);
              setOffset(0);
            }}
          />
          Ungrouped routes only
        </label>
      )}
      {currentJobs.map((j) => (
        <div
          key={j.id}
          role="status"
          className="flex items-center gap-3 border-b px-4 py-2 text-xs"
        >
          <span className="font-medium">
            {j.kind} · {j.status}
          </span>
          <span className="truncate text-muted-foreground">{j.label}</span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => void run({ type: "cancel", jobId: j.id })}
          >
            Cancel
          </Button>
        </div>
      ))}
      {data && (
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs text-muted-foreground">
          <span>{data.coverage.routes} routes</span>
          <span>{data.coverage.endpoints} endpoints</span>
          {data.viewPartial && (
            <span>
              Showing {data.nodes.length}/{data.total} items and {data.edges.length}/
              {data.totalEdges} connections · narrow the scope or change pages
            </span>
          )}
          <span>
            {data.coverage.parsedFiles}/{data.coverage.totalFiles} files parsed
          </span>
          <span>
            {data.coverage.partial
              ? "Partial coverage · inspect diagnostics"
              : "Supported source indexed"}
          </span>
          <span>
            Previews:{" "}
            {
              new Set(
                data.captures.filter((c) => c.available && !c.outdated).map((c) => c.scenarioId),
              ).size
            }
            /{data.documentation.scenarios.length} scenarios captured
          </span>
        </div>
      )}
      {history.length > 0 && (
        <nav aria-label="Atlas breadcrumbs" className="flex flex-wrap gap-2 px-4 pb-3">
          <Button size="sm" variant="ghost" onClick={() => setHistory([])}>
            Whole app
          </Button>
          {history.map((n, i) => (
            <Button
              size="sm"
              variant="ghost"
              key={`${n.id}:${i}`}
              onClick={() => setHistory(history.slice(0, i + 1))}
            >
              {n.label}
            </Button>
          ))}
        </nav>
      )}
      <main ref={canvas} className="min-h-0 flex-1 overflow-auto p-4">
        {!data?.revision ? (
          <div className="mx-auto max-w-lg py-20 text-center">
            <NetworkIcon className="mx-auto mb-5 size-8 text-muted-foreground" />
            <h1 className="text-xl font-semibold">A map built from your code</h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Index routes, components, and dependencies in this checkout. No AI provider or running
              app is needed. Attach your app later for real page previews.
            </p>
          </div>
        ) : view === "features" ? (
          <div className="space-y-3">
            {data.documentation.features.length === 0 && (
              <p className="p-8 text-sm text-muted-foreground">
                Create a feature, then assign routes or source items from their inspector.
              </p>
            )}
            {data.documentation.features.map((f) => (
              <section key={f.id} className="rounded-lg border p-4">
                <div className="flex items-center gap-3">
                  <h2 className="font-medium">{f.name}</h2>
                  <span className="text-xs text-muted-foreground">
                    User-authored · {f.members.length} items
                  </span>
                  <Button
                    className="ml-auto"
                    size="sm"
                    variant="ghost"
                    onClick={() => setFeature(f)}
                  >
                    Edit
                  </Button>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{f.description}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {f.members.map((id) => (
                    <Button
                      size="sm"
                      variant="outline"
                      key={id}
                      onClick={() => {
                        const node = data.nodes.find((n) => n.id === id);
                        setHistory([{ id, label: node?.label ?? "Referenced item" }]);
                        setQuery("");
                        setOffset(0);
                        setView("modules");
                      }}
                    >
                      {data.nodes.find((n) => n.id === id)?.label ?? id}
                    </Button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : view === "files" ? (
          <div className="divide-y rounded-lg border">
            {data.files.map((f) => (
              <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm" key={f.path}>
                <FileCodeIcon className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1 break-all font-mono text-xs">{f.path}</span>
                <span className="text-xs text-muted-foreground">
                  {f.status}
                  {f.reason ? ` · ${f.reason}` : ""}
                </span>
              </div>
            ))}
          </div>
        ) : view === "diagnostics" ? (
          <div className="divide-y rounded-lg border">
            {data.diagnostics.map((d, i) => (
              <div className="p-4 text-sm" key={`${d.path}:${i}`}>
                <p className="font-medium">{d.code}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{d.path}</p>
                <p className="mt-2 text-muted-foreground">{d.message}</p>
              </div>
            ))}
            {!data.diagnostics.length && (
              <p className="p-5 text-sm text-muted-foreground">No matching diagnostics.</p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4">
            {graphView && (view === "modules" || focus) ? (
              <div className="col-span-full">
                <AtlasGraph
                  nodes={data.nodes}
                  edges={data.edges}
                  onInspect={setInspect}
                  onSource={setSource}
                  onExplore={(node) => {
                    setHistory([...history, node]);
                    setOffset(0);
                  }}
                />
              </div>
            ) : (
              data.nodes.map((node) => {
                const scenarios = data.documentation.scenarios.filter((s) => s.routeId === node.id);
                const selectedScenario =
                  scenarios.find((scenario) => scenario.id === selectedScenarios[node.id]) ??
                  scenarios[0];
                const capture = data.captures.find(
                  (c) => c.scenarioId === selectedScenario?.id && c.available,
                );
                const thumb = imageUrl(capture?.thumbnailUrl);
                return (
                  <article
                    className="flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card"
                    key={node.id}
                  >
                    {selectedScenario && (
                      <label className="flex items-center gap-2 border-b px-3 py-2 text-xs">
                        Scenario
                        <select
                          aria-label={`Scenario for ${node.label}`}
                          className="min-w-0 flex-1 bg-transparent"
                          value={selectedScenario.id}
                          onChange={(e) =>
                            setSelectedScenarios({
                              ...selectedScenarios,
                              [node.id]: e.target.value,
                            })
                          }
                        >
                          {scenarios.map((scenario) => (
                            <option key={scenario.id} value={scenario.id}>
                              {scenario.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {thumb && (
                      <button
                        type="button"
                        className="border-b bg-muted"
                        aria-label={`Enlarge ${node.label} capture`}
                        onClick={() => {
                          const url = imageUrl(capture?.imageUrl);
                          if (url)
                            setImage({ url, label: `${node.label} · ${capture?.createdAt}` });
                        }}
                      >
                        <img
                          className="aspect-[8/5] w-full object-cover object-top"
                          src={thumb}
                          alt={`${node.label} scenario capture`}
                          loading="lazy"
                          onError={() =>
                            setError(
                              "Capture URL expired or image was removed. Refresh the view to renew access.",
                            )
                          }
                        />
                      </button>
                    )}
                    <div className="flex flex-1 flex-col p-4">
                      <span className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                        {node.kind}
                        {node.roles
                          .filter((role) => role.startsWith("@") || /^\(\.{1,3}\)/.test(role))
                          .map((role) => ` · ${role}`)}
                        {capture?.outdated ? " · historical capture" : ""}
                      </span>
                      <button
                        className="text-left text-sm font-semibold wrap-anywhere hover:underline"
                        onClick={() => setInspect(node)}
                      >
                        {node.label}
                      </button>
                      <p className="mt-2 break-all font-mono text-xs leading-5 text-muted-foreground">
                        {node.source.path}
                      </p>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setHistory([...history, node]);
                            setOffset(0);
                          }}
                        >
                          Explore
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setSource(node)}>
                          Source
                        </Button>
                        {node.kind === "route" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setScenario(scenarios[0] ?? draftScenario(node))}
                          >
                            <CameraIcon />
                            {scenarios.length ? "Scenarios" : "Set up preview"}
                          </Button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })
            )}
            {!data.nodes.length && (
              <p className="p-6 text-sm text-muted-foreground">
                No matching items. Try another view or search.
              </p>
            )}
          </div>
        )}
      </main>
      {data?.revision && view !== "features" && (
        <footer className="flex items-center gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
          <span>
            {offset + 1}–
            {Math.min(offset + (view === "files" || view === "diagnostics" ? 50 : 80), data.total)}{" "}
            of {data.total}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={offset === 0}
            onClick={() =>
              setOffset(
                Math.max(0, offset - (view === "files" || view === "diagnostics" ? 50 : 80)),
              )
            }
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={offset + (view === "files" || view === "diagnostics" ? 50 : 80) >= data.total}
            onClick={() =>
              setOffset(offset + (view === "files" || view === "diagnostics" ? 50 : 80))
            }
          >
            Next
          </Button>
          <span className="ml-auto truncate" title={data.checkout}>
            {environment?.label ?? project.environmentId} · {data.checkout}
          </span>
        </footer>
      )}
      {source && data && (
        <AtlasSource
          project={project}
          checkout={data.checkout}
          node={source}
          onClose={() => setSource(null)}
        />
      )}
      {inspect && data && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setInspect(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{inspect.label}</DialogTitle>
              <DialogDescription>{inspect.kind} · source-derived facts</DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-4">
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button variant="outline" onClick={() => setSource(inspect)}>
                View source evidence
              </Button>
              <p className="text-sm">
                {inspect.layouts.length} layouts · {inspect.boundaries.length} boundaries
                {inspect.methods.length ? ` · ${inspect.methods.join(", ")}` : ""}
              </p>
              <p className="text-sm text-muted-foreground">
                Inspect relationships by choosing Explore. Imports and JSX references describe
                source structure, not runtime execution.
              </p>
              <Button
                onClick={() => {
                  setHistory([...history, inspect]);
                  setInspect(null);
                }}
              >
                Explore relationships
              </Button>
              <fieldset className="space-y-3">
                <legend className="mb-3 text-sm font-medium">Feature membership</legend>
                {data.documentation.features.map((f) => (
                  <label className="flex items-center gap-2 text-sm" key={f.id}>
                    <input
                      type="checkbox"
                      checked={f.members.includes(inspect.id)}
                      disabled={busy}
                      onChange={(e) =>
                        void saveDocs({
                          ...data.documentation,
                          features: data.documentation.features.map((g) =>
                            g.id === f.id
                              ? {
                                  ...g,
                                  members: e.target.checked
                                    ? [...g.members, inspect.id]
                                    : g.members.filter((id) => id !== inspect.id),
                                }
                              : g,
                          ),
                        })
                      }
                    />
                    {f.name}
                  </label>
                ))}
              </fieldset>
            </DialogPanel>
          </DialogContent>
        </Dialog>
      )}
      {feature && data && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setFeature(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {data.documentation.features.some((f) => f.id === feature.id)
                  ? "Edit feature"
                  : "New feature"}
              </DialogTitle>
              <DialogDescription>Group source items into a capability you name.</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveDocs({
                    ...data.documentation,
                    features: [
                      ...data.documentation.features.filter((f) => f.id !== feature.id),
                      feature,
                    ],
                  }).then((ok) => {
                    if (ok) setFeature(null);
                  });
                }}
              >
                <label className="block space-y-2 text-sm">
                  Name
                  <input
                    required
                    className={field}
                    value={feature.name}
                    onChange={(e) => setFeature({ ...feature, name: e.target.value })}
                  />
                </label>
                <label className="block space-y-2 text-sm">
                  Description
                  <textarea
                    className={cn(field, "h-24 py-2")}
                    value={feature.description}
                    onChange={(e) => setFeature({ ...feature, description: e.target.value })}
                  />
                </label>
                <fieldset className="space-y-2">
                  <legend className="text-sm">Members</legend>
                  {feature.members.map((id) => (
                    <div key={id} className="flex items-center gap-2 text-xs">
                      <span className="min-w-0 flex-1 break-all">
                        {data.nodes.find((node) => node.id === id)?.label ??
                          `Referenced item ${id}`}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setFeature({
                            ...feature,
                            members: feature.members.filter((member) => member !== id),
                          })
                        }
                      >
                        Remove member
                      </Button>
                    </div>
                  ))}
                </fieldset>
                <div className="flex justify-between">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void saveDocs({
                        ...data.documentation,
                        features: data.documentation.features.filter((f) => f.id !== feature.id),
                      }).then((ok) => {
                        if (ok) setFeature(null);
                      })
                    }
                  >
                    Delete feature
                  </Button>
                  <Button type="submit" disabled={busy}>
                    Save feature
                  </Button>
                </div>
              </form>
            </DialogPanel>
          </DialogContent>
        </Dialog>
      )}
      {scenario && data && (
        <AtlasScenarioDialog
          scenario={scenario}
          routes={data.nodes.filter((n) => n.kind === "route")}
          sessions={data.sessions}
          scenarios={data.documentation.scenarios.filter((s) => s.routeId === scenario.routeId)}
          captures={data.captures.filter((c) => c.scenarioId === scenario.id)}
          busy={busy}
          error={error}
          onChange={setScenario}
          onClose={() => setScenario(null)}
          onSave={() =>
            saveDocs({
              ...data.documentation,
              scenarios: [
                ...data.documentation.scenarios.filter((s) => s.id !== scenario.id),
                scenario,
              ],
            })
          }
          onNew={() =>
            setScenario({ ...scenario, id: `scenario_${newCommandId()}`, name: "New scenario" })
          }
          onDelete={() =>
            void saveDocs({
              ...data.documentation,
              scenarios: data.documentation.scenarios.filter((s) => s.id !== scenario.id),
            }).then((ok) => {
              if (ok) setScenario(null);
            })
          }
          onCapture={() =>
            void saveDocs({
              ...data.documentation,
              scenarios: [
                ...data.documentation.scenarios.filter((s) => s.id !== scenario.id),
                scenario,
              ],
            }).then((ok) => {
              if (ok)
                void run({
                  type: "capture",
                  commandId: newCommandId(),
                  scenarioIds: [scenario.id],
                });
            })
          }
          onDeleteCapture={(captureId) => void run({ type: "delete-capture", captureId })}
          onImage={(url, label) => {
            const resolved = imageUrl(url);
            if (resolved) setImage({ url: resolved, label });
          }}
        />
      )}
      {setup && data && (
        <AtlasSetup
          data={data}
          busy={busy}
          error={error}
          run={run}
          onScenario={(scenario) => {
            setSetup(false);
            setScenario(scenario);
          }}
          onClose={() => setSetup(false)}
        />
      )}
      {image && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setImage(null);
          }}
        >
          <DialogContent className="max-h-[95vh] max-w-6xl overflow-auto">
            <DialogHeader>
              <DialogTitle>{image.label}</DialogTitle>
              <DialogDescription>
                Point-in-time observation from an attached target. Running source is unverified.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <img src={image.url} alt={image.label} className="h-auto w-full" />
            </DialogPanel>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function AtlasSetup({
  data,
  busy,
  error,
  run,
  onScenario,
  onClose,
}: {
  data: CodebaseAtlasSnapshot;
  busy: boolean;
  error: string | null;
  run: (action: Action) => Promise<boolean>;
  onScenario: (scenario: AtlasScenario) => void;
  onClose: () => void;
}) {
  const [origin, setOrigin] = useState(data.target?.origin ?? "");
  const [prefix, setPrefix] = useState(data.target?.prefix ?? "");
  const [sessionName, setSessionName] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [captureSelection, setCaptureSelection] = useState<string[]>([]);
  const [state, setState] = useState("");
  const [privateName, setPrivateName] = useState("");
  const [privateValue, setPrivateValue] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Preview setup and activity</DialogTitle>
          <DialogDescription>
            Attach an app already running in this environment. Starting the app remains explicit.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-6">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run({ type: "attach", origin, prefix });
            }}
          >
            <label className="block space-y-2 text-sm">
              App origin
              <input
                required
                className={field}
                placeholder="http://localhost:3000"
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
              />
            </label>
            <label className="block space-y-2 text-sm">
              Deployment prefix
              <input
                className={field}
                placeholder="/optional-prefix"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
              />
            </label>
            <p className="text-xs leading-5 text-muted-foreground">
              This confirms your target choice. It does not verify the running app's source
              checkout.
            </p>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                Attach target
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy || !data.target}
                onClick={() => void run({ type: "attach", origin: null, prefix: "" })}
              >
                Detach
              </Button>
            </div>
          </form>
          <section className="space-y-3 border-t pt-4">
            <h3 className="text-sm font-medium">Capture browser</h3>
            <p className="text-xs text-muted-foreground">
              {data.browserAvailable
                ? "Ready in this environment"
                : "Set up Chromium once to enable real page captures."}
            </p>
            {!data.browserAvailable && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void run({ type: "browser-setup", commandId: newCommandId() })}
              >
                Set up capture browser
              </Button>
            )}
          </section>
          <form
            className="space-y-3 border-t pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run({
                type: "session",
                id: sessionId || `session_${newCommandId()}`,
                name: sessionName,
                storageState: state,
              }).then((ok) => {
                if (ok) {
                  setState("");
                  setSessionName("");
                  setSessionId("");
                }
              });
            }}
          >
            <h3 className="text-sm font-medium">Private session profile</h3>
            <select
              aria-label="Import as profile"
              className={field}
              value={sessionId}
              onChange={(e) => {
                setSessionId(e.target.value);
                setSessionName(
                  data.sessions.find((session) => session.id === e.target.value)?.name ?? "",
                );
              }}
            >
              <option value="">New profile</option>
              {data.sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  Replace {session.name}
                </option>
              ))}
            </select>
            <input
              aria-label="Session profile name"
              required
              placeholder="Profile name"
              className={field}
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
            />
            <label className="block text-xs text-muted-foreground">
              Import Playwright storage state
              <input
                type="file"
                accept="application/json,.json"
                className="mt-2 block w-full text-xs"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void file.text().then(setState);
                }}
              />
            </label>
            <Button type="submit" size="sm" variant="outline" disabled={busy || !state}>
              Import private profile
            </Button>
            <p className="text-xs text-muted-foreground">
              Stored only in this environment. Never included in Git-owned maps.
            </p>
            {data.sessions.map((s) => (
              <div className="flex items-center justify-between text-sm" key={s.id}>
                {s.name}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run({ type: "session", id: s.id, name: s.name, storageState: null })
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
          </form>
          <section className="space-y-3 border-t pt-4">
            <h3 className="text-sm font-medium">Capture saved scenarios</h3>
            {data.documentation.scenarios.map((scenario) => (
              <Button
                key={scenario.id}
                size="sm"
                variant="outline"
                className="mr-2"
                onClick={() => onScenario(scenario)}
              >
                Edit {scenario.name}
              </Button>
            ))}
            <p className="text-xs text-muted-foreground">
              Choose up to 20 configured scenarios. The environment captures them one at a time.
            </p>
            {data.documentation.scenarios.map((scenario) => (
              <label key={scenario.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={captureSelection.includes(scenario.id)}
                  disabled={
                    busy ||
                    (!captureSelection.includes(scenario.id) && captureSelection.length >= 20)
                  }
                  onChange={(e) =>
                    setCaptureSelection(
                      e.target.checked
                        ? [...captureSelection, scenario.id]
                        : captureSelection.filter((id) => id !== scenario.id),
                    )
                  }
                />
                {scenario.name}
              </label>
            ))}
            <Button
              size="sm"
              disabled={busy || !captureSelection.length || !data.target || !data.browserAvailable}
              onClick={() =>
                void run({
                  type: "capture",
                  commandId: newCommandId(),
                  scenarioIds: captureSelection,
                })
              }
            >
              Capture selection
            </Button>
          </section>
          <section className="space-y-3 border-t pt-4">
            <h3 className="text-sm font-medium">Private scenario values</h3>
            <p className="text-xs text-muted-foreground">
              Use @private:name in parameters or query values to keep a value out of Git.
            </p>
            <input
              aria-label="Private value name"
              className={field}
              placeholder="Name"
              value={privateName}
              onChange={(e) => setPrivateName(e.target.value)}
            />
            <input
              aria-label="Private scenario value"
              className={field}
              type="password"
              placeholder="Value"
              value={privateValue}
              onChange={(e) => setPrivateValue(e.target.value)}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || !privateName || !privateValue}
              onClick={() =>
                void run({ type: "private-value", name: privateName, value: privateValue }).then(
                  (ok) => {
                    if (ok) {
                      setPrivateName("");
                      setPrivateValue("");
                    }
                  },
                )
              }
            >
              Save private value
            </Button>
            {data.privateValueNames.map((name) => (
              <div key={name} className="flex items-center justify-between text-sm">
                {name}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void run({ type: "private-value", name, value: null })}
                >
                  Remove
                </Button>
              </div>
            ))}
          </section>
          <section className="space-y-3 border-t pt-4">
            <h3 className="text-sm font-medium">Recent activity</h3>
            {data.jobs.map((j) => (
              <div className="text-xs" key={j.id}>
                <p>
                  {j.kind} · {j.status} · {j.label}
                </p>
                {j.detail && <p className="mt-1 text-muted-foreground">{j.detail}</p>}
              </div>
            ))}
          </section>
        </DialogPanel>
      </DialogContent>
    </Dialog>
  );
}

function AtlasScenarioDialog({
  scenario,
  routes,
  sessions,
  scenarios,
  captures,
  busy,
  error,
  onChange,
  onClose,
  onSave,
  onNew,
  onDelete,
  onCapture,
  onDeleteCapture,
  onImage,
}: {
  scenario: AtlasScenario;
  routes: readonly AtlasNode[];
  sessions: CodebaseAtlasSnapshot["sessions"];
  scenarios: readonly AtlasScenario[];
  captures: readonly AtlasCapture[];
  busy: boolean;
  error: string | null;
  onChange: (s: AtlasScenario) => void;
  onClose: () => void;
  onSave: () => Promise<boolean>;
  onNew: () => void;
  onDelete: () => void;
  onCapture: () => void;
  onDeleteCapture: (id: string) => void;
  onImage: (url: string, label: string) => void;
}) {
  const [queryText, setQueryText] = useState(() => new URLSearchParams(scenario.query).toString());
  useEffect(() => {
    setQueryText(new URLSearchParams(scenario.query).toString());
  }, [scenario.id]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Page scenarios</DialogTitle>
          <DialogDescription>
            Define one real rendering state. Parameters and readiness must be supplied; auth and
            data are not inferred.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error && (
            <p role="alert" className="mb-4 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="mb-4 flex flex-wrap gap-2">
            {scenarios.map((s) => (
              <Button
                key={s.id}
                variant={s.id === scenario.id ? "secondary" : "ghost"}
                size="sm"
                onClick={() => onChange(s)}
              >
                {s.name}
              </Button>
            ))}
            <Button size="sm" variant="outline" onClick={onNew}>
              New scenario
            </Button>
          </div>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void onSave();
            }}
          >
            <label className="block space-y-2 text-sm">
              Route
              <select
                aria-label="Scenario route"
                className={field}
                value={scenario.routeId}
                onChange={(e) => {
                  const route = routes.find((route) => route.id === e.target.value);
                  if (route)
                    onChange({
                      ...scenario,
                      routeId: route.id,
                      parameters: Object.fromEntries(
                        route.parameters.map((parameter) => [
                          parameter.name,
                          scenario.parameters[parameter.name] ?? "",
                        ]),
                      ),
                    });
                }}
              >
                <option value={scenario.routeId}>
                  {routes.find((route) => route.id === scenario.routeId)?.label ??
                    "Current route reference (missing or outside this page)"}
                </option>
                {routes
                  .filter((route) => route.id !== scenario.routeId)
                  .map((route) => (
                    <option key={route.id} value={route.id}>
                      {route.label}
                    </option>
                  ))}
              </select>
            </label>
            <label className="block space-y-2 text-sm">
              Name
              <input
                required
                className={field}
                value={scenario.name}
                onChange={(e) => onChange({ ...scenario, name: e.target.value })}
              />
            </label>
            {Object.entries(scenario.parameters).map(([name, value]) => (
              <label key={name} className="block space-y-2 text-sm">
                Parameter: {name}
                <input
                  className={field}
                  value={value}
                  onChange={(e) =>
                    onChange({
                      ...scenario,
                      parameters: { ...scenario.parameters, [name]: e.target.value },
                    })
                  }
                />
              </label>
            ))}
            <label className="block space-y-2 text-sm">
              Relative path override
              <input
                className={field}
                placeholder="Optional; needed for unsupported route matching"
                value={scenario.relativePath ?? ""}
                onChange={(e) => {
                  const { relativePath: _, ...rest } = scenario;
                  onChange(e.target.value ? { ...rest, relativePath: e.target.value } : rest);
                }}
              />
            </label>
            <label className="block space-y-2 text-sm">
              Query values
              <input
                className={field}
                placeholder="view=empty"
                value={queryText}
                onChange={(e) => {
                  setQueryText(e.target.value);
                  onChange({
                    ...scenario,
                    query: Object.fromEntries(new URLSearchParams(e.target.value)),
                  });
                }}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-2 text-sm">
                Viewport
                <select
                  className={field}
                  value={scenario.viewport}
                  onChange={(e) =>
                    onChange({
                      ...scenario,
                      viewport: e.target.value === "mobile" ? "mobile" : "desktop",
                    })
                  }
                >
                  <option value="desktop">Desktop</option>
                  <option value="mobile">Mobile</option>
                </select>
              </label>
              <label className="space-y-2 text-sm">
                Theme
                <select
                  className={field}
                  value={scenario.theme}
                  onChange={(e) =>
                    onChange({ ...scenario, theme: e.target.value === "dark" ? "dark" : "light" })
                  }
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
            </div>
            <label className="block space-y-2 text-sm">
              Session
              <select
                className={field}
                value={scenario.sessionId ?? ""}
                onChange={(e) => {
                  const { sessionId: _, ...rest } = scenario;
                  onChange(e.target.value ? { ...rest, sessionId: e.target.value } : rest);
                }}
              >
                <option value="">Anonymous</option>
                {sessions.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-2 text-sm">
              Readiness
              <select
                className={field}
                value={scenario.readiness.kind}
                onChange={(e) =>
                  onChange({
                    ...scenario,
                    readiness: {
                      ...scenario.readiness,
                      kind: e.target.value === "locator" ? "locator" : "text",
                    },
                  })
                }
              >
                <option value="text">Visible text</option>
                <option value="locator">Locator</option>
              </select>
              <input
                required
                aria-label="Readiness value"
                className={field}
                placeholder={
                  scenario.readiness.kind === "text"
                    ? "Text visible when this state is ready"
                    : "[data-testid=project-ready]"
                }
                value={scenario.readiness.value}
                onChange={(e) =>
                  onChange({
                    ...scenario,
                    readiness: { ...scenario.readiness, value: e.target.value },
                  })
                }
              />
            </label>
            <label className="block space-y-2 text-sm">
              Expected final path
              <input
                className={field}
                placeholder="Optional, e.g. /login for a signed-out scenario"
                value={scenario.expectedPath ?? ""}
                onChange={(e) => {
                  const { expectedPath: _, ...rest } = scenario;
                  onChange(e.target.value ? { ...rest, expectedPath: e.target.value } : rest);
                }}
              />
            </label>
            <label className="block space-y-2 text-sm">
              Expected HTTP status
              <input
                className={field}
                type="number"
                min={100}
                max={599}
                placeholder="Optional; default is a successful page"
                value={scenario.expectedStatus ?? ""}
                onChange={(e) => {
                  const { expectedStatus: _, ...rest } = scenario;
                  onChange(
                    e.target.value ? { ...rest, expectedStatus: Number(e.target.value) } : rest,
                  );
                }}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="outline" disabled={busy}>
                Save scenario
              </Button>
              <Button
                type="button"
                disabled={busy || !scenario.readiness.value}
                onClick={onCapture}
              >
                <CameraIcon />
                Save and capture
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={onDelete}>
                Delete scenario
              </Button>
            </div>
          </form>
          <div className="mt-6 space-y-3 border-t pt-4">
            {captures.map((c) => (
              <div key={c.id} className="space-y-2 text-xs">
                <p>
                  {c.createdAt} · {c.outcome}
                  {c.outdated ? " · outdated" : ""}
                </p>
                <p className="text-muted-foreground">{c.detail}</p>
                <div className="flex gap-2">
                  {c.available && c.imageUrl ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onImage(c.imageUrl!, `${scenario.name} · ${c.createdAt}`)}
                    >
                      View capture
                    </Button>
                  ) : (
                    <span className="text-muted-foreground">Image unavailable; capture again.</span>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => onDeleteCapture(c.id)}>
                    Delete capture
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </DialogPanel>
      </DialogContent>
    </Dialog>
  );
}
