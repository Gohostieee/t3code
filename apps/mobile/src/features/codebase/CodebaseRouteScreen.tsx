import { environmentThreadDetails } from "../../state/threads";
import { CodebaseAtlas } from "./CodebaseAtlas";
import { CodebaseFiles } from "./CodebaseFiles";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import {
  CommandId,
  ThreadId,
  type CodebaseAnalyzers,
  type CodebaseNode,
  type CodebaseSource,
  type ModelSelection,
  isCodebaseAnalysisActive,
} from "@t3tools/contracts";
import {
  portableCodebaseAnalyzer,
  resolveCodebaseAnalyzer,
  codebaseProgressRevision,
  codebaseExplorationLabel,
} from "@t3tools/client-runtime/state/codebase";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { useProjects, useThreadShells } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { codebaseEnvironment } from "../../state/codebase";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import {
  applyProviderOptionMenuEvent,
  buildProviderOptionMenuActions,
  resolveProviderOptionDescriptors,
} from "../../lib/providerOptions";

type Params = { environmentId?: string; projectId?: string; checkout?: string; threadId?: string };

export function CodebaseLink({ params = {} }: { params?: Params }) {
  const navigation = useNavigation();
  return (
    <ControlPill
      label="Codebase"
      variant="pill"
      onPress={() => navigation.navigate("Codebase", params)}
    />
  );
}

export function CodebaseRouteScreen({ route }: StaticScreenProps<Params>) {
  const [legacy, setLegacy] = useState(false);
  const navigation = useNavigation();
  const projects = useProjects();
  const project =
    projects.find(
      (entry) =>
        entry.id === route.params.projectId && entry.environmentId === route.params.environmentId,
    ) ?? (!route.params.projectId ? projects[0] : null);
  return (
    <View className="flex-1 bg-screen">
      <View className="flex-row flex-wrap gap-2 px-4 py-3">
        <ControlPill label="Chat" variant="pill" onPress={() => navigation.navigate("Home")} />
        <ControlPillMenu
          actions={projects.map((entry) => ({
            id: `${entry.environmentId}:${entry.id}`,
            title: entry.title,
            subtitle: entry.environmentId,
          }))}
          onPressAction={({ nativeEvent }) => {
            const next = projects.find(
              (entry) => `${entry.environmentId}:${entry.id}` === nativeEvent.event,
            );
            if (next)
              navigation.setParams({
                environmentId: next.environmentId,
                projectId: next.id,
                checkout: undefined,
                threadId: undefined,
              });
          }}
        >
          <ControlPill label={project?.title ?? "Choose project"} variant="pill" />
        </ControlPillMenu>
      </View>
      {project ? (
        legacy ? (
          <>
            <ControlPill
              label="Back to source atlas"
              variant="pill"
              onPress={() => setLegacy(false)}
            />
            <Explorer
              key={`${project.environmentId}:${project.id}:${route.params.checkout ?? route.params.threadId ?? "main"}`}
              project={project}
              params={route.params}
            />
          </>
        ) : (
          <CodebaseAtlas
            key={`${project.environmentId}:${project.id}:${route.params.checkout ?? route.params.threadId ?? "main"}`}
            project={project}
            params={route.params}
            onLegacy={() => setLegacy(true)}
          />
        )
      ) : (
        <Text className="p-5 text-foreground-muted">Add a project to explore its codebase.</Text>
      )}
    </View>
  );
}

function Source({
  project,
  checkout,
  source,
  close,
}: {
  project: ReturnType<typeof useProjects>[number];
  checkout: string;
  source: CodebaseSource;
  close: () => void;
}) {
  const result = useEnvironmentQuery(
    codebaseEnvironment.source({
      environmentId: project.environmentId,
      input: { cwd: checkout, relativePath: source.path },
    }),
  );
  return (
    <Modal visible animationType="slide" onRequestClose={close} presentationStyle="pageSheet">
      <View className="flex-1 bg-screen p-5">
        <ControlPill label="Close source" variant="pill" onPress={close} />
        <Text className="my-4 font-t3-bold">
          {source.path}:{source.startLine}-{source.endLine}
        </Text>
        <ScrollView>
          <Text selectable className="font-mono text-xs">
            {result.error ??
              result.data?.contents
                .split("\n")
                .slice(Math.max(0, source.startLine - 4), source.endLine + 3)
                .map((line, index) => `${Math.max(1, source.startLine - 3) + index}  ${line}`)
                .join("\n") ??
              "Loading source…"}
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

function Explorer({
  project,
  params,
  readOnly = true,
}: {
  project: ReturnType<typeof useProjects>[number];
  params: Params;
  readOnly?: boolean;
}) {
  const navigation = useNavigation();
  const threads = useThreadShells();
  const config = useAtomValue(environmentServerConfigsAtom).get(project.environmentId);
  const providers = config?.providers ?? [];
  const thread = threads.find(
    (entry) => entry.environmentId === project.environmentId && entry.id === params.threadId,
  );
  const target = {
    environmentId: project.environmentId,
    input: {
      projectId: project.id,
      ...(params.threadId ? { threadId: ThreadId.make(params.threadId) } : {}),
      checkout: params.checkout ?? thread?.worktreePath ?? project.workspaceRoot,
    },
  };
  const [history, setHistory] = useState([
    { id: "overview", title: "Whole app", parent: null as string | null },
  ]);
  const scope = history.at(-1)!;
  const [selections, setSelections] = useState<Record<string, string | null>>({});
  const selected = selections[scope.id];
  const [override, setOverride] = useState<ModelSelection | null>(null);
  const [source, setSource] = useState<CodebaseSource | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [transcript, setTranscript] = useState<ScopedThreadRef | null>(null);
  const [setup, setSetup] = useState<keyof CodebaseAnalyzers | null>(null);
  const [setupSelection, setSetupSelection] = useState<ModelSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const offsets = useRef(new Map<string, number>());
  const map = useEnvironmentQuery(
    codebaseEnvironment.read({ ...target, input: { ...target.input, scopeId: scope.id } }),
  );
  const progress = useEnvironmentQuery(codebaseEnvironment.progress(target));
  const exploration = progress.data?.exploration;
  const exploring = exploration?.status === "running";
  const currentRun = progress.data?.runs.find(
    (run) => run.threadId === exploration?.currentThreadId,
  );
  const refresh = useRef(map.refresh);
  refresh.current = map.refresh;
  const revision = codebaseProgressRevision(progress.data);
  useEffect(() => {
    refresh.current();
  }, [revision, scope.id]);
  useEffect(() => {
    scroll.current?.scrollTo({ y: offsets.current.get(scope.id) ?? 0, animated: false });
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
  const start = useAtomCommand(codebaseEnvironment.start);
  const cancel = useAtomCommand(codebaseEnvironment.cancel);
  const configure = useAtomCommand(codebaseEnvironment.configure);
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
  const graph = map.data?.scope?.graph;
  const node = graph?.nodes.find((item) => item.id === selected);
  const edge = graph?.edges.find((item) => item.id === selected);
  const selection = setup ? setupSelection : chosen.selection;
  const setSelection = setup ? setSetupSelection : setOverride;
  const models = buildModelOptions(config, selection);
  const model = models.find(
    (entry) =>
      entry.selection.instanceId === selection?.instanceId &&
      entry.selection.model === selection.model,
  );
  const options = resolveProviderOptionDescriptors({
    capabilities: model?.capabilities,
    selections: selection?.options,
  });
  const explore = (item: CodebaseNode) => {
    const id = item.boundaryScopeId ?? item.childScopeId;
    if (id)
      setHistory((items) => [
        ...items,
        { id, title: item.name, parent: item.boundaryScopeId ? null : scope.id },
      ]);
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
        commandId: CommandId.make(uuidv4()),
        modelSelection: model,
        ...(all && detailChoice.selection
          ? { exploreAll: true, detailModelSelection: detailChoice.selection }
          : {}),
      },
    });
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    setBusy(false);
  };
  const save = async (inherit = false) => {
    if (readOnly || !setup) return;
    const analyzers = { ...map.data?.manifest?.analyzers };
    if (inherit) delete analyzers[setup];
    else {
      const preference = setupSelection && portableCodebaseAnalyzer(setupSelection, providers);
      if (!preference) return;
      analyzers[setup] = preference;
    }
    const result = await configure({
      ...target,
      input: {
        ...target.input,
        analyzers,
        analyzerBindings: { [setup]: inherit ? null : setupSelection },
        expectedRevision: map.data?.configurationRevision ?? null,
      },
    });
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else {
      setSetup(null);
      setOverride(null);
      map.refresh();
    }
  };
  const worktrees = map.data?.worktrees ?? [project.workspaceRoot];
  return (
    <>
      <ScrollView
        ref={scroll}
        onScroll={(event) => offsets.current.set(scope.id, event.nativeEvent.contentOffset.y)}
        scrollEventThrottle={100}
        contentContainerStyle={{ padding: 16, gap: 14 }}
      >
        <Text className="text-xs text-foreground-muted">
          {project.environmentId} ·{" "}
          {map.data?.branch ?? map.data?.head?.slice(0, 8) ?? "Resolving checkout"}
        </Text>
        <ControlPillMenu
          actions={worktrees.map((checkout) => ({ id: checkout, title: checkout }))}
          onPressAction={({ nativeEvent }) =>
            navigation.setParams({ checkout: nativeEvent.event, threadId: undefined })
          }
        >
          <ControlPill variant="pill" label={map.data?.checkout ?? target.input.checkout} />
        </ControlPillMenu>
        <View className="flex-row flex-wrap gap-2">
          {history.map((entry, index) => (
            <ControlPill
              key={`${entry.id}:${index}`}
              variant="pill"
              label={entry.title}
              onPress={() => setHistory((items) => items.slice(0, index + 1))}
            />
          ))}
        </View>
        <Text className="text-foreground-muted">
          {map.data?.scope
            ? `Map ${map.data.freshness}`
            : "Explore codebase builds every discovered layer and analyzes remaining source automatically."}
        </Text>
        {(error ??
          map.error ??
          progress.error ??
          chosen.reason ??
          explorationReason ??
          map.data?.detail) && (
          <Text accessibilityRole="alert">
            {error ??
              map.error ??
              progress.error ??
              chosen.reason ??
              explorationReason ??
              map.data?.detail}
          </Text>
        )}
        {readOnly && (
          <Text className="text-sm text-foreground-muted">
            Legacy AI map · read-only documentation. Use the source atlas to index this checkout.
          </Text>
        )}
        {!readOnly && (
          <ControlPillMenu
            actions={groupByProvider(models).map((group) => ({
              id: group.providerKey,
              title: group.providerLabel,
              subactions: group.models.map((entry) => ({
                id: entry.key,
                title: entry.label,
                attributes: map.data?.supportedProviderInstanceIds?.includes(
                  entry.selection.instanceId,
                )
                  ? undefined
                  : { disabled: true },
              })),
            }))}
            onPressAction={({ nativeEvent }) => {
              const next = models.find((entry) => entry.key === nativeEvent.event);
              if (next) setSelection(next.selection);
            }}
          >
            <ControlPill
              variant="pill"
              label={model ? `${model.providerLabel} · ${model.label}` : "Choose analyzer"}
            />
          </ControlPillMenu>
        )}
        <Text className="text-xs text-foreground-muted">
          Adapters without inspection permissions are unavailable.
        </Text>
        {!readOnly && selection && options.length > 0 && (
          <ControlPillMenu
            actions={[...buildProviderOptionMenuActions(options)]}
            onPressAction={({ nativeEvent }) => {
              const next = applyProviderOptionMenuEvent(options, nativeEvent.event);
              if (next) setSelection({ ...selection, options: next });
            }}
          >
            <ControlPill variant="pill" label="Model options" />
          </ControlPillMenu>
        )}
        <View className="flex-row flex-wrap gap-2">
          <ControlPill
            variant="primary"
            label={exploring ? "Exploring…" : "Explore codebase"}
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
            onPress={() => void build(true)}
          />
          <ControlPill
            variant="pill"
            label={
              active?.analysis.status ??
              (graph ? "Refresh this scope" : scope.parent ? "Build this layer" : "Build overview")
            }
            disabled={
              readOnly ||
              busy ||
              !!active ||
              exploring ||
              !!chosen.reason ||
              !chosen.selection ||
              !map.data?.supportedProviderInstanceIds?.includes(chosen.selection.instanceId) ||
              !map.data ||
              !["ready", "unbuilt"].includes(map.data.state)
            }
            onPress={() => void build()}
          />
          <ControlPill variant="pill" label="Check freshness" onPress={map.refresh} />
          <ControlPill
            variant="pill"
            label="Analysis activity"
            onPress={() => setShowActivity(!showActivity)}
          />
        </View>
        {exploration && (
          <View className="gap-2 rounded-xl bg-subtle p-4" accessibilityLiveRegion="polite">
            <Text className="font-t3-bold">
              {codebaseExplorationLabel(exploration, currentRun?.analysis)}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {exploration.completedScopes} layers explored · {exploration.discoveredScopes}{" "}
              discovered · {exploration.inspectedFiles} of {exploration.totalFiles} files fully
              supplied · {exploration.excludedFiles} excluded
            </Text>
            {exploration.detail && <Text className="text-xs">{exploration.detail}</Text>}
            {exploring && (
              <ControlPill
                label="Stop exploration"
                variant="pill"
                onPress={() =>
                  void (async () => {
                    const result = await cancel({
                      ...target,
                      input: { ...target.input, runThreadId: exploration.rootThreadId },
                    });
                    if (result._tag === "Failure")
                      setError(String(squashAtomCommandFailure(result)));
                  })()
                }
              />
            )}
          </View>
        )}
        <ControlPill
          variant="pill"
          label="Files and change impact"
          onPress={() => setShowFiles(true)}
        />
        {map.data?.index && (
          <Text className="text-xs text-foreground-muted">
            {map.data.index.changedFiles} changed files · {map.data.index.staleScopes} maps need
            review
          </Text>
        )}
        {!readOnly && (
          <ControlPillMenu
            actions={[
              { id: "default", title: "Default analyzer" },
              { id: "overview", title: "Overview override" },
              { id: "detail", title: "Detail override" },
            ]}
            onPressAction={({ nativeEvent }) => {
              const slot = nativeEvent.event as keyof CodebaseAnalyzers;
              setSetup(slot);
              setSetupSelection(
                resolveCodebaseAnalyzer({
                  analyzers: {
                    default:
                      map.data?.manifest?.analyzers[slot] ?? map.data?.manifest?.analyzers.default,
                  },
                  passKind: "overview",
                  providers,
                  chatDefault: project.defaultModelSelection,
                  binding: chosen.selection,
                }).selection,
              );
            }}
          >
            <ControlPill variant="pill" label="AI setup" />
          </ControlPillMenu>
        )}
        {setup && (
          <View className="gap-3 rounded-xl bg-subtle p-4">
            <Text>Editing {setup}. Choose the model above.</Text>
            <View className="flex-row flex-wrap gap-2">
              <ControlPill
                label="Save"
                variant="primary"
                disabled={!setupSelection}
                onPress={() => void save()}
              />
              <ControlPill label="Discard" variant="pill" onPress={() => setSetup(null)} />
              <ControlPill label="Inherit" variant="pill" onPress={() => void save(true)} />
            </View>
          </View>
        )}
        {map.data?.ignored && (
          <Text>Git ignores the map files; they will not be included in commits.</Text>
        )}
        {showActivity && (
          <View className="gap-3 rounded-xl bg-subtle p-4">
            {progress.data?.runs.map((run) => (
              <View key={run.threadId} className="gap-2 border-b border-separator pb-3">
                <Text>
                  {run.analysis.scopeId} · {run.analysis.status}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {run.modelSelection.model}
                  {run.analysis.detail ? `\n${run.analysis.detail}` : ""}
                </Text>
                <View className="flex-row gap-2">
                  <ControlPill
                    variant="pill"
                    label="View transcript"
                    onPress={() =>
                      setTranscript({
                        environmentId: project.environmentId,
                        threadId: run.threadId,
                      })
                    }
                  />
                  {isCodebaseAnalysisActive(run.analysis.status) && (
                    <ControlPill
                      variant="pill"
                      label="Cancel"
                      onPress={() =>
                        void (async () => {
                          const result = await cancel({
                            ...target,
                            input: { ...target.input, runThreadId: run.threadId },
                          });
                          if (result._tag === "Failure")
                            setError(String(squashAtomCommandFailure(result)));
                        })()
                      }
                    />
                  )}
                </View>
              </View>
            ))}
          </View>
        )}
        {graph && (
          <>
            <Text className="text-xl font-t3-bold">{graph.title}</Text>
            <Text className="text-foreground-muted">{graph.summary}</Text>
          </>
        )}
        {graph?.nodes.map((item) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Inspect ${item.name}`}
            key={item.id}
            onPress={() => setSelections((previous) => ({ ...previous, [scope.id]: item.id }))}
            className="gap-2 rounded-xl bg-subtle p-4"
          >
            <Text className="font-t3-bold">{item.name}</Text>
            <Text className="text-foreground-muted">{item.responsibility}</Text>
            <Text className="text-xs text-foreground-muted">
              {item.technologies.join(" · ")}
              {item.expandable ? " · Explore available" : ""}
            </Text>
          </Pressable>
        ))}
        {(node || edge) && (
          <View className="gap-3 rounded-xl bg-subtle-strong p-4">
            <ControlPill
              label="Close inspector"
              variant="pill"
              onPress={() => setSelections((previous) => ({ ...previous, [scope.id]: null }))}
            />
            <Text className="text-lg font-t3-bold">{node?.name ?? edge?.label}</Text>
            <Text>{node?.explanation ?? edge?.explanation}</Text>
            {edge && (
              <>
                <Text>
                  {edge.kind} · {edge.evidence}
                </Text>
                <Text>
                  {graph?.nodes.find((item) => item.id === edge.from)?.name} →{" "}
                  {graph?.nodes.find((item) => item.id === edge.to)?.name}
                </Text>
                {[edge.from, edge.to].map((id) => (
                  <ControlPill
                    key={id}
                    variant="pill"
                    label={`Inspect ${graph?.nodes.find((item) => item.id === id)?.name}`}
                    onPress={() => setSelections((previous) => ({ ...previous, [scope.id]: id }))}
                  />
                ))}
              </>
            )}
            {node && (
              <>
                {[
                  ...(node.inputs ?? []).map((item) => `Input: ${item}`),
                  ...(node.outputs ?? []).map((item) => `Output: ${item}`),
                  ...(node.sideEffects ?? []).map((item) => `Effect: ${item}`),
                ].map((item) => (
                  <Text key={item}>{item}</Text>
                ))}
                {graph?.edges
                  .filter((item) => item.from === node.id || item.to === node.id)
                  .map((item) => (
                    <ControlPill
                      key={item.id}
                      variant="pill"
                      label={`${item.from === node.id ? "→" : "←"} ${item.label}`}
                      onPress={() =>
                        setSelections((previous) => ({ ...previous, [scope.id]: item.id }))
                      }
                    />
                  ))}
              </>
            )}
            {(node?.sources ?? edge?.sources ?? []).map((item, index) => (
              <ControlPill
                key={`${item.path}:${index}`}
                variant="pill"
                label={`${item.path}:${item.startLine}`}
                onPress={() => setSource(item)}
              />
            ))}
            {node && (node.childScopeId || node.boundaryScopeId) && (
              <ControlPill
                variant="primary"
                label={`Explore ${node.name}`}
                onPress={() => explore(node)}
              />
            )}
          </View>
        )}
        {map.data?.scope && (
          <>
            <Text className="text-xs text-foreground-muted">
              {map.data.scope.coverage.referencedFiles} files referenced of{" "}
              {map.data.scope.coverage.inventoryFiles} inventoried;{" "}
              {map.data.scope.coverage.omittedFiles} not supplied;{" "}
              {map.data.scope.coverage.truncatedFiles ?? 0} excerpts truncated. Produced by{" "}
              {map.data.scope.provenance.analyzer.model}.
            </Text>
            {graph?.omissions.map((item) => (
              <Text className="text-xs text-foreground-muted" key={item}>
                {item}
              </Text>
            ))}
          </>
        )}
      </ScrollView>
      {transcript && <Transcript threadRef={transcript} close={() => setTranscript(null)} />}
      {showFiles && (
        <CodebaseFiles
          environmentId={project.environmentId}
          input={target.input}
          revision={revision}
          close={() => setShowFiles(false)}
          openScope={(id, title) => {
            setShowFiles(false);
            setHistory((previous) => [...previous, { id, title, parent: null }]);
          }}
        />
      )}
      {source && map.data && (
        <Source
          project={project}
          checkout={map.data.checkout}
          source={source}
          close={() => setSource(null)}
        />
      )}
    </>
  );
}

function Transcript({ threadRef, close }: { threadRef: ScopedThreadRef; close: () => void }) {
  const thread = useAtomValue(environmentThreadDetails.detailAtom(threadRef));
  const [showInput, setShowInput] = useState(false);
  return (
    <Modal visible animationType="slide" onRequestClose={close} presentationStyle="pageSheet">
      <ScrollView className="bg-screen" contentContainerStyle={{ padding: 20, gap: 16 }}>
        <ControlPill label="Close transcript" variant="pill" onPress={close} />
        <Text className="text-xl font-t3-bold">Analysis transcript</Text>
        <Text>
          {thread?.analysis?.status ?? "Loading"} ? {thread?.modelSelection.model}
        </Text>
        <Text>{thread?.analysis?.detail}</Text>
        <ControlPill
          label={showInput ? "Hide source bundle" : "Show source bundle"}
          variant="pill"
          onPress={() => setShowInput(!showInput)}
        />
        {thread?.messages
          .filter((message) => message.role === "assistant" || showInput)
          .map((message) => (
            <View className="gap-2 rounded-xl bg-subtle p-4" key={message.id}>
              <Text className="font-t3-bold">{message.role}</Text>
              <Text selectable className="font-mono text-xs">
                {message.text}
              </Text>
            </View>
          ))}
        {thread?.activities.map((activity) => (
          <View key={activity.id} className="gap-1">
            <Text className="font-t3-bold">{activity.kind}</Text>
            <Text>{activity.summary}</Text>
          </View>
        ))}
      </ScrollView>
    </Modal>
  );
}
