import { useEffect, useRef, useState } from "react";
import { Image, Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import {
  CommandId,
  ThreadId,
  type AtlasNode,
  type AtlasScenario,
  type AtlasFeature,
  type CodebaseAtlasInput,
  type AtlasDocumentation,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePreparedConnection } from "../../state/session";
import { codebaseEnvironment } from "../../state/codebase";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";

type Project = ReturnType<typeof useProjects>[number];
type Params = { checkout?: string; threadId?: string };
const active = (status: string) =>
  [
    "queued",
    "inventorying",
    "parsing",
    "resolving",
    "validating",
    "publishing",
    "capturing",
  ].includes(status);
const inputClass = "min-h-11 rounded-xl border border-border bg-surface px-3 text-foreground";
const commandId = () => CommandId.make(uuidv4());

export function CodebaseAtlas({
  project,
  params,
  onLegacy,
}: {
  project: Project;
  params: Params;
  onLegacy: () => void;
}) {
  const navigation = useNavigation();
  const threads = useThreadShells();
  const prepared = usePreparedConnection(project.environmentId);
  const [root, setRoot] = useState<string>();
  const [view, setView] = useState<"routes" | "modules" | "features" | "files" | "diagnostics">(
    "routes",
  );
  const [query, setQuery] = useState("");
  const [ungrouped, setUngrouped] = useState(false);
  const [selectedScenarios, setSelectedScenarios] = useState<Record<string, string>>({});
  const [offset, setOffset] = useState(0);
  const [history, setHistory] = useState<Pick<AtlasNode, "id" | "label">[]>([]);
  const [selected, setSelected] = useState<AtlasNode | null>(null);
  const [source, setSource] = useState<AtlasNode | null>(null);
  const [scenario, setScenario] = useState<AtlasScenario | null>(null);
  const [feature, setFeature] = useState<AtlasFeature | null>(null);
  const [setup, setSetup] = useState(false);
  const [origin, setOrigin] = useState("");
  const [prefix, setPrefix] = useState("");
  const [sessionName, setSessionName] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [captureSelection, setCaptureSelection] = useState<string[]>([]);
  const [sessionState, setSessionState] = useState("");
  const [privateName, setPrivateName] = useState("");
  const [privateValue, setPrivateValue] = useState("");
  const [queryText, setQueryText] = useState("");
  useEffect(() => {
    setQueryText(new URLSearchParams(scenario?.query ?? {}).toString());
  }, [scenario?.id]);
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = {
    environmentId: project.environmentId,
    input: {
      projectId: project.id,
      ...(params.threadId ? { threadId: ThreadId.make(params.threadId) } : {}),
      ...(params.checkout ? { checkout: params.checkout } : {}),
    },
  };
  const focus = history.at(-1);
  const result = useEnvironmentQuery(
    codebaseEnvironment.atlas({
      ...target,
      input: {
        ...target.input,
        ...(root ? { appRoot: root } : {}),
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
  const run = async (action: CodebaseAtlasInput["action"]) => {
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
  const assetUrl = (url: string | undefined) =>
    url && prepared._tag === "Some" ? new URL(url, prepared.value.httpBaseUrl).toString() : null;
  const draft = (node: AtlasNode): AtlasScenario => ({
    id: `scenario_${uuidv4()}`,
    routeId: node.id,
    name: "Default",
    parameters: Object.fromEntries(node.parameters.map((p) => [p.name, ""])),
    query: {},
    viewport: "mobile",
    theme: "light",
    readiness: { kind: "text", value: "" },
  });
  const pageSize = view === "files" || view === "diagnostics" ? 50 : 80;
  return (
    <View className="flex-1 bg-screen">
      <View className="gap-3 border-b border-border px-4 pb-3">
        <View className="flex-row flex-wrap items-center gap-2">
          <ControlPillMenu
            actions={(data?.apps ?? []).map((a) => ({
              id: a.root,
              title: a.name,
              subtitle: a.framework,
            }))}
            onPressAction={({ nativeEvent }) => {
              setRoot(nativeEvent.event);
              setHistory([]);
              setOffset(0);
            }}
          >
            <ControlPill
              label={data?.apps.find((a) => a.root === data.appRoot)?.name ?? "Application"}
              variant="pill"
            />
          </ControlPillMenu>
          <ControlPillMenu
            actions={[
              ...new Set([
                project.workspaceRoot,
                ...threads
                  .filter(
                    (t) => t.projectId === project.id && t.environmentId === project.environmentId,
                  )
                  .flatMap((t) => (t.worktreePath ? [t.worktreePath] : [])),
              ]),
            ].map((w) => ({ id: w, title: w.split(/[\\/]/).at(-1) ?? w }))}
            onPressAction={({ nativeEvent }) =>
              navigation.setParams({ checkout: nativeEvent.event, threadId: undefined })
            }
          >
            <ControlPill label={data?.branch ?? "Checkout"} variant="pill" />
          </ControlPillMenu>
          <ControlPill
            label={data?.revision ? "Refresh index" : "Index codebase"}
            variant="primary"
            disabled={busy || data?.jobs.some((j) => j.kind === "index" && active(j.status))}
            onPress={() =>
              void run({
                type: "index",
                commandId: commandId(),
                expectedRevision: data?.revision ?? null,
              })
            }
          />
          <ControlPill
            label="Setup"
            variant="pill"
            onPress={() => {
              setOrigin(data?.target?.origin ?? "");
              setPrefix(data?.target?.prefix ?? "");
              setSetup(true);
            }}
          />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="flex-row gap-2">
            {(["routes", "modules", "features", "files", "diagnostics"] as const).map((v) => (
              <ControlPill
                key={v}
                label={v}
                variant={view === v ? "primary" : "pill"}
                onPress={() => {
                  setView(v);
                  setOffset(0);
                  setHistory([]);
                }}
              />
            ))}
          </View>
        </ScrollView>
        <TextInput
          accessibilityLabel="Search atlas"
          placeholder="Search atlas"
          placeholderTextColor="#888"
          className={inputClass}
          value={query}
          onChangeText={(text) => {
            setQuery(text);
            setOffset(0);
          }}
        />
        <Text className="text-xs text-foreground-muted">
          {data?.freshness ?? "unknown"} · {data?.coverage.routes ?? 0} routes ·{" "}
          {data?.coverage.parsedFiles ?? 0}/{data?.coverage.totalFiles ?? 0} files parsed
          {data?.coverage.partial ? " · partial coverage" : ""}
        </Text>
        {view === "routes" && (
          <ControlPill
            variant="pill"
            label={ungrouped ? "Show all routes" : "Ungrouped routes only"}
            onPress={() => {
              setUngrouped(!ungrouped);
              setOffset(0);
            }}
          />
        )}
        {(error || result.error || data?.detail) && (
          <Text accessibilityRole="alert" className="text-sm text-danger">
            {error ?? result.error ?? data?.detail}
          </Text>
        )}
        {data?.jobs
          .filter((j) => active(j.status))
          .map((j) => (
            <View key={j.id} className="flex-row items-center justify-between">
              <Text className="flex-1 text-xs">
                {j.kind} · {j.status} · {j.label}
              </Text>
              <ControlPill
                label="Cancel"
                variant="pill"
                onPress={() => void run({ type: "cancel", jobId: j.id })}
              />
            </View>
          ))}
      </View>
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 p-4"
        keyboardShouldPersistTaps="handled"
      >
        {history.length > 0 && (
          <View className="flex-row flex-wrap gap-2">
            <ControlPill label="Whole app" variant="pill" onPress={() => setHistory([])} />
            {history.map((n, i) => (
              <ControlPill
                key={`${n.id}:${i}`}
                label={n.label}
                variant="pill"
                onPress={() => setHistory(history.slice(0, i + 1))}
              />
            ))}
          </View>
        )}
        {!data?.revision && (
          <View className="gap-3 py-10">
            <Text className="text-xl font-t3-bold">A map built from your code</Text>
            <Text className="text-foreground-muted">
              Index source without an AI provider. Attach a running app when you want real page
              captures.
            </Text>
          </View>
        )}
        {view === "features" ? (
          <>
            <ControlPill
              label="New feature"
              variant="pill"
              onPress={() =>
                setFeature({ id: `feature_${uuidv4()}`, name: "", description: "", members: [] })
              }
            />
            {data?.documentation.features.map((f) => (
              <Pressable
                key={f.id}
                accessibilityRole="button"
                onPress={() => setFeature(f)}
                className="gap-2 rounded-2xl border border-border p-4"
              >
                <Text className="font-t3-bold">{f.name}</Text>
                <Text className="text-xs text-foreground-muted">
                  User-authored · {f.members.length} members
                </Text>
                <Text>{f.description}</Text>
                {f.members.map((id) => (
                  <ControlPill
                    key={id}
                    variant="pill"
                    label={data.nodes.find((n) => n.id === id)?.label ?? "Inspect source item"}
                    onPress={() => {
                      const n = data.nodes.find((n) => n.id === id);
                      setView("modules");
                      setHistory([{ id, label: n?.label ?? "Referenced item" }]);
                      setQuery("");
                      setOffset(0);
                    }}
                  />
                ))}
              </Pressable>
            ))}
          </>
        ) : view === "files" ? (
          data?.files.map((f) => (
            <View key={f.path} className="gap-2 border-b border-border py-3">
              <Text selectable className="font-mono text-xs">
                {f.path}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {f.status} {f.reason}
              </Text>
            </View>
          ))
        ) : view === "diagnostics" ? (
          data?.diagnostics.map((d, i) => (
            <View key={`${d.path}:${i}`} className="gap-2 border-b border-border py-3">
              <Text className="font-t3-bold">{d.code}</Text>
              <Text className="font-mono text-xs text-foreground-muted">{d.path}</Text>
              <Text>{d.message}</Text>
            </View>
          ))
        ) : (
          data?.nodes.map((node) => {
            const scenarios = data.documentation.scenarios.filter((s) => s.routeId === node.id);
            const selectedScenario =
              scenarios.find((scenario) => scenario.id === selectedScenarios[node.id]) ??
              scenarios[0];
            const capture = data.captures.find(
              (c) => c.scenarioId === selectedScenario?.id && c.available,
            );
            const thumb = assetUrl(capture?.thumbnailUrl);
            return (
              <View
                key={node.id}
                className="overflow-hidden rounded-2xl border border-border bg-surface"
              >
                {selectedScenario && (
                  <ControlPillMenu
                    actions={scenarios.map((scenario) => ({
                      id: scenario.id,
                      title: scenario.name,
                    }))}
                    onPressAction={({ nativeEvent }) =>
                      setSelectedScenarios({ ...selectedScenarios, [node.id]: nativeEvent.event })
                    }
                  >
                    <ControlPill label={`Scenario: ${selectedScenario.name}`} variant="pill" />
                  </ControlPillMenu>
                )}
                {thumb && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Enlarge ${node.label} capture`}
                    onPress={() => setImage(assetUrl(capture?.imageUrl))}
                  >
                    <Image
                      accessibilityLabel={`${node.label} scenario capture`}
                      source={{ uri: thumb }}
                      style={{ width: "100%", height: 180 }}
                      resizeMode="cover"
                    />
                  </Pressable>
                )}
                <View className="gap-3 p-4">
                  <Text className="text-xs text-foreground-muted">
                    {node.kind}
                    {capture?.outdated ? " · historical capture" : ""}
                  </Text>
                  <Pressable accessibilityRole="button" onPress={() => setSelected(node)}>
                    <Text className="font-t3-bold">{node.label}</Text>
                  </Pressable>
                  <Text className="font-mono text-xs text-foreground-muted">
                    {node.source.path}
                  </Text>
                  <View className="flex-row flex-wrap gap-2">
                    <ControlPill
                      label="Explore"
                      variant="pill"
                      onPress={() => {
                        setHistory([...history, node]);
                        setOffset(0);
                      }}
                    />
                    <ControlPill label="Source" variant="pill" onPress={() => setSource(node)} />
                    {node.kind === "route" && (
                      <ControlPill
                        label="Scenarios"
                        variant="pill"
                        onPress={() => setScenario(scenarios[0] ?? draft(node))}
                      />
                    )}
                  </View>
                </View>
              </View>
            );
          })
        )}
        {focus &&
          data?.edges.map((e) => (
            <Pressable
              accessibilityRole="button"
              key={e.id}
              onPress={() => {
                const node = data.nodes.find((n) => n.id === e.from);
                if (node) setSource({ ...node, source: e.source });
              }}
            >
              <Text className="text-xs">
                {data.nodes.find((n) => n.id === e.from)?.label} → {e.kind} →{" "}
                {data.nodes.find((n) => n.id === e.to)?.label}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {e.evidence} · {e.rule}
              </Text>
            </Pressable>
          ))}
        {data?.revision && view !== "features" && (
          <View className="flex-row flex-wrap items-center gap-2">
            <ControlPill
              label="Previous"
              variant="pill"
              disabled={offset === 0}
              onPress={() => setOffset(Math.max(0, offset - pageSize))}
            />
            <Text className="text-xs">
              {offset + 1}–{Math.min(offset + pageSize, data.total)} / {data.total}
            </Text>
            <ControlPill
              label="Next"
              variant="pill"
              disabled={offset + pageSize >= data.total}
              onPress={() => setOffset(offset + pageSize)}
            />
          </View>
        )}
        <ControlPill label="Legacy AI map" variant="pill" onPress={onLegacy} />
      </ScrollView>
      {(selected || feature || scenario || setup || image) && (
        <Modal
          visible
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => {
            setSelected(null);
            setFeature(null);
            setScenario(null);
            setSetup(false);
            setImage(null);
          }}
        >
          <ScrollView
            className="flex-1 bg-screen"
            contentContainerClassName="gap-4 p-5"
            keyboardShouldPersistTaps="handled"
          >
            <ControlPill
              label="Close"
              variant="pill"
              onPress={() => {
                setSelected(null);
                setFeature(null);
                setScenario(null);
                setSetup(false);
                setImage(null);
              }}
            />
            {image && (
              <>
                <Text className="text-xs text-foreground-muted">
                  Point-in-time capture. Attached running source is unverified.
                </Text>
                <Image
                  source={{ uri: image }}
                  style={{ width: "100%", height: 700 }}
                  resizeMode="contain"
                />
              </>
            )}
            {selected && data && (
              <>
                <Text className="text-xl font-t3-bold">{selected.label}</Text>
                <Text>
                  {selected.kind} · {selected.layouts.length} layouts · {selected.boundaries.length}{" "}
                  boundaries
                </Text>
                <Text className="text-sm text-foreground-muted">
                  Source relationships do not prove runtime calls or DOM identity.
                </Text>
                <ControlPill
                  label="View source"
                  variant="pill"
                  onPress={() => setSource(selected)}
                />
                <ControlPill
                  label="Explore relationships"
                  variant="primary"
                  onPress={() => {
                    setHistory([...history, selected]);
                    setSelected(null);
                  }}
                />
                <Text className="font-t3-bold">Feature membership</Text>
                {data.documentation.features.map((f) => (
                  <ControlPill
                    key={f.id}
                    label={`${f.members.includes(selected.id) ? "Remove from" : "Add to"} ${f.name}`}
                    variant="pill"
                    disabled={busy}
                    onPress={() =>
                      void saveDocs({
                        ...data.documentation,
                        features: data.documentation.features.map((g) =>
                          g.id === f.id
                            ? {
                                ...g,
                                members: g.members.includes(selected.id)
                                  ? g.members.filter((id) => id !== selected.id)
                                  : [...g.members, selected.id],
                              }
                            : g,
                        ),
                      })
                    }
                  />
                ))}
                {!data.documentation.features.length && (
                  <ControlPill
                    label="Create feature"
                    variant="pill"
                    onPress={() => {
                      setFeature({
                        id: `feature_${uuidv4()}`,
                        name: "",
                        description: "",
                        members: [selected.id],
                      });
                      setSelected(null);
                    }}
                  />
                )}
              </>
            )}
            {feature && data && (
              <>
                <Text className="text-xl font-t3-bold">Feature</Text>
                <TextInput
                  accessibilityLabel="Feature name"
                  placeholder="Feature name"
                  className={inputClass}
                  value={feature.name}
                  onChangeText={(name) => setFeature({ ...feature, name })}
                />
                <TextInput
                  accessibilityLabel="Feature description"
                  placeholder="Description"
                  multiline
                  className={inputClass}
                  value={feature.description}
                  onChangeText={(description) => setFeature({ ...feature, description })}
                />
                {feature.members.map((id) => (
                  <View key={id} className="gap-2">
                    <Text className="text-xs">
                      {data.nodes.find((node) => node.id === id)?.label ?? `Referenced item ${id}`}
                    </Text>
                    <ControlPill
                      label="Remove member"
                      variant="pill"
                      onPress={() =>
                        setFeature({
                          ...feature,
                          members: feature.members.filter((member) => member !== id),
                        })
                      }
                    />
                  </View>
                ))}
                <ControlPill
                  label="Save feature"
                  variant="primary"
                  disabled={busy || !feature.name}
                  onPress={() =>
                    void saveDocs({
                      ...data.documentation,
                      features: [
                        ...data.documentation.features.filter((f) => f.id !== feature.id),
                        feature,
                      ],
                    }).then((ok) => {
                      if (ok) setFeature(null);
                    })
                  }
                />
                <ControlPill
                  label="Delete feature"
                  variant="pill"
                  disabled={busy}
                  onPress={() =>
                    void saveDocs({
                      ...data.documentation,
                      features: data.documentation.features.filter((f) => f.id !== feature.id),
                    }).then((ok) => {
                      if (ok) setFeature(null);
                    })
                  }
                />
              </>
            )}
            {scenario && data && (
              <>
                <ControlPillMenu
                  actions={data.nodes
                    .filter((node) => node.kind === "route")
                    .map((node) => ({ id: node.id, title: node.label }))}
                  onPressAction={({ nativeEvent }) => {
                    const route = data.nodes.find((node) => node.id === nativeEvent.event);
                    if (route)
                      setScenario({
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
                  <ControlPill
                    label={`Route: ${data.nodes.find((node) => node.id === scenario.routeId)?.label ?? "Missing or outside this page"}`}
                    variant="pill"
                  />
                </ControlPillMenu>
                <Text className="text-xl font-t3-bold">Page scenarios</Text>
                <View className="flex-row flex-wrap gap-2">
                  {data.documentation.scenarios
                    .filter((s) => s.routeId === scenario.routeId)
                    .map((s) => (
                      <ControlPill
                        key={s.id}
                        label={s.name}
                        variant={s.id === scenario.id ? "primary" : "pill"}
                        onPress={() => setScenario(s)}
                      />
                    ))}
                  <ControlPill
                    label="New scenario"
                    variant="pill"
                    onPress={() =>
                      setScenario({ ...scenario, id: `scenario_${uuidv4()}`, name: "New scenario" })
                    }
                  />
                </View>
                <TextInput
                  accessibilityLabel="Scenario name"
                  placeholder="Name"
                  className={inputClass}
                  value={scenario.name}
                  onChangeText={(name) => setScenario({ ...scenario, name })}
                />
                {Object.entries(scenario.parameters).map(([name, value]) => (
                  <View key={name} className="gap-2">
                    <Text className="text-sm">Parameter: {name}</Text>
                    <TextInput
                      accessibilityLabel={`Parameter ${name}`}
                      className={inputClass}
                      value={value}
                      onChangeText={(text) =>
                        setScenario({
                          ...scenario,
                          parameters: { ...scenario.parameters, [name]: text },
                        })
                      }
                    />
                  </View>
                ))}
                <TextInput
                  accessibilityLabel="Relative path override"
                  placeholder="Optional relative path override"
                  className={inputClass}
                  value={scenario.relativePath ?? ""}
                  onChangeText={(text) => {
                    const { relativePath: _, ...rest } = scenario;
                    setScenario(text ? { ...rest, relativePath: text } : rest);
                  }}
                />
                <TextInput
                  accessibilityLabel="Query values"
                  placeholder="Query values, e.g. view=empty"
                  className={inputClass}
                  value={queryText}
                  onChangeText={(text) => {
                    setQueryText(text);
                    setScenario({
                      ...scenario,
                      query: Object.fromEntries(new URLSearchParams(text)),
                    });
                  }}
                />
                <View className="flex-row flex-wrap gap-2">
                  <ControlPill
                    label={scenario.viewport === "mobile" ? "Mobile viewport" : "Desktop viewport"}
                    variant="pill"
                    onPress={() =>
                      setScenario({
                        ...scenario,
                        viewport: scenario.viewport === "mobile" ? "desktop" : "mobile",
                      })
                    }
                  />
                  <ControlPill
                    label={`${scenario.theme} theme`}
                    variant="pill"
                    onPress={() =>
                      setScenario({
                        ...scenario,
                        theme: scenario.theme === "light" ? "dark" : "light",
                      })
                    }
                  />
                  <ControlPill
                    label={scenario.readiness.kind === "text" ? "Visible text" : "Locator"}
                    variant="pill"
                    onPress={() =>
                      setScenario({
                        ...scenario,
                        readiness: {
                          ...scenario.readiness,
                          kind: scenario.readiness.kind === "text" ? "locator" : "text",
                        },
                      })
                    }
                  />
                </View>
                <TextInput
                  accessibilityLabel="Readiness condition"
                  placeholder="Visible text or locator when the state is ready"
                  className={inputClass}
                  value={scenario.readiness.value}
                  onChangeText={(value) =>
                    setScenario({ ...scenario, readiness: { ...scenario.readiness, value } })
                  }
                />
                <ControlPillMenu
                  actions={[
                    { id: "anonymous", title: "Anonymous" },
                    ...data.sessions.map((s) => ({ id: s.id, title: s.name })),
                  ]}
                  onPressAction={({ nativeEvent }) => {
                    const { sessionId: _, ...rest } = scenario;
                    setScenario(
                      nativeEvent.event === "anonymous"
                        ? rest
                        : { ...rest, sessionId: nativeEvent.event },
                    );
                  }}
                >
                  <ControlPill
                    label={
                      data.sessions.find((s) => s.id === scenario.sessionId)?.name ??
                      "Anonymous session"
                    }
                    variant="pill"
                  />
                </ControlPillMenu>
                <TextInput
                  accessibilityLabel="Expected final path"
                  placeholder="Expected redirect path (optional)"
                  className={inputClass}
                  value={scenario.expectedPath ?? ""}
                  onChangeText={(text) => {
                    const { expectedPath: _, ...rest } = scenario;
                    setScenario(text ? { ...rest, expectedPath: text } : rest);
                  }}
                />
                <TextInput
                  accessibilityLabel="Expected HTTP status"
                  placeholder="Expected HTTP status (optional)"
                  keyboardType="number-pad"
                  className={inputClass}
                  value={scenario.expectedStatus?.toString() ?? ""}
                  onChangeText={(text) => {
                    const { expectedStatus: _, ...rest } = scenario;
                    setScenario(text ? { ...rest, expectedStatus: Number(text) } : rest);
                  }}
                />
                <ControlPill
                  label="Save scenario"
                  variant="pill"
                  disabled={busy}
                  onPress={() =>
                    void saveDocs({
                      ...data.documentation,
                      scenarios: [
                        ...data.documentation.scenarios.filter((s) => s.id !== scenario.id),
                        scenario,
                      ],
                    })
                  }
                />
                <ControlPill
                  label="Save and capture"
                  variant="primary"
                  disabled={busy || !scenario.readiness.value}
                  onPress={() =>
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
                          commandId: commandId(),
                          scenarioIds: [scenario.id],
                        });
                    })
                  }
                />
                <ControlPill
                  label="Delete scenario"
                  variant="pill"
                  onPress={() =>
                    void saveDocs({
                      ...data.documentation,
                      scenarios: data.documentation.scenarios.filter((s) => s.id !== scenario.id),
                    }).then((ok) => {
                      if (ok) setScenario(null);
                    })
                  }
                />
                {data.captures
                  .filter((c) => c.scenarioId === scenario.id)
                  .map((c) => (
                    <View key={c.id} className="gap-2 border-t border-border pt-3">
                      <Text className="text-xs">
                        {c.createdAt} · {c.outcome}
                        {c.outdated ? " · outdated" : ""}
                      </Text>
                      <Text className="text-xs text-foreground-muted">{c.detail}</Text>
                      {c.available && (
                        <ControlPill
                          label="View capture"
                          variant="pill"
                          onPress={() => {
                            setImage(assetUrl(c.imageUrl));
                            setScenario(null);
                          }}
                        />
                      )}
                      <ControlPill
                        label="Delete capture"
                        variant="pill"
                        onPress={() => void run({ type: "delete-capture", captureId: c.id })}
                      />
                    </View>
                  ))}
              </>
            )}
            {setup && data && (
              <>
                <Text className="text-xl font-t3-bold">Preview setup</Text>
                <Text className="text-sm text-foreground-muted">
                  Attach a running app reachable from this environment. Target selection does not
                  verify its source checkout.
                </Text>
                <TextInput
                  accessibilityLabel="App origin"
                  placeholder="http://localhost:3000"
                  autoCapitalize="none"
                  className={inputClass}
                  value={origin}
                  onChangeText={setOrigin}
                />
                <TextInput
                  accessibilityLabel="Deployment prefix"
                  placeholder="Deployment prefix (optional)"
                  className={inputClass}
                  value={prefix}
                  onChangeText={setPrefix}
                />
                <ControlPill
                  label="Attach target"
                  variant="primary"
                  disabled={busy || !origin}
                  onPress={() => void run({ type: "attach", origin, prefix })}
                />
                <ControlPill
                  label="Detach target"
                  variant="pill"
                  disabled={busy || !data.target}
                  onPress={() => void run({ type: "attach", origin: null, prefix: "" })}
                />
                {!data.browserAvailable && (
                  <ControlPill
                    label="Set up capture browser"
                    variant="pill"
                    disabled={busy}
                    onPress={() => void run({ type: "browser-setup", commandId: commandId() })}
                  />
                )}
                <Text className="font-t3-bold">Private session profile</Text>
                <ControlPillMenu
                  actions={[
                    { id: "new", title: "New profile" },
                    ...data.sessions.map((session) => ({
                      id: session.id,
                      title: `Replace ${session.name}`,
                    })),
                  ]}
                  onPressAction={({ nativeEvent }) => {
                    const session = data.sessions.find((entry) => entry.id === nativeEvent.event);
                    setSessionId(session?.id ?? "");
                    setSessionName(session?.name ?? "");
                  }}
                >
                  <ControlPill
                    label={sessionId ? "Replace profile" : "New profile"}
                    variant="pill"
                  />
                </ControlPillMenu>
                <Text className="text-xs text-foreground-muted">
                  Import Playwright storage state. Saved only in this environment.
                </Text>
                <TextInput
                  accessibilityLabel="Session profile name"
                  placeholder="Profile name"
                  className={inputClass}
                  value={sessionName}
                  onChangeText={setSessionName}
                />
                <TextInput
                  accessibilityLabel="Private storage state"
                  placeholder="Paste storage state JSON"
                  multiline
                  autoCapitalize="none"
                  className={inputClass}
                  value={sessionState}
                  onChangeText={setSessionState}
                />
                <ControlPill
                  label="Import private profile"
                  variant="pill"
                  disabled={busy || !sessionName || !sessionState}
                  onPress={() =>
                    void run({
                      type: "session",
                      id: sessionId || `session_${uuidv4()}`,
                      name: sessionName,
                      storageState: sessionState,
                    }).then((ok) => {
                      if (ok) {
                        setSessionState("");
                        setSessionName("");
                        setSessionId("");
                      }
                    })
                  }
                />
                {data.sessions.map((s) => (
                  <ControlPill
                    key={s.id}
                    label={`Remove ${s.name}`}
                    variant="pill"
                    onPress={() =>
                      void run({ type: "session", id: s.id, name: s.name, storageState: null })
                    }
                  />
                ))}
                <Text className="font-t3-bold">Capture saved scenarios</Text>
                {data.documentation.scenarios.map((scenario) => (
                  <ControlPill
                    key={scenario.id}
                    label={`Edit ${scenario.name}`}
                    variant="pill"
                    onPress={() => {
                      setSetup(false);
                      setScenario(scenario);
                    }}
                  />
                ))}
                <Text className="text-xs text-foreground-muted">
                  Select up to 20 configured scenarios.
                </Text>
                {data.documentation.scenarios.map((scenario) => (
                  <Pressable
                    key={scenario.id}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: captureSelection.includes(scenario.id) }}
                    disabled={
                      busy ||
                      (!captureSelection.includes(scenario.id) && captureSelection.length >= 20)
                    }
                    onPress={() =>
                      setCaptureSelection(
                        captureSelection.includes(scenario.id)
                          ? captureSelection.filter((id) => id !== scenario.id)
                          : [...captureSelection, scenario.id],
                      )
                    }
                  >
                    <Text className="py-2 text-sm">
                      {captureSelection.includes(scenario.id) ? "✓ " : "○ "}
                      {scenario.name}
                    </Text>
                  </Pressable>
                ))}
                <ControlPill
                  label="Capture selection"
                  variant="primary"
                  disabled={
                    busy || !captureSelection.length || !data.target || !data.browserAvailable
                  }
                  onPress={() =>
                    void run({
                      type: "capture",
                      commandId: commandId(),
                      scenarioIds: captureSelection,
                    })
                  }
                />
                <Text className="font-t3-bold">Private scenario values</Text>
                <Text className="text-xs text-foreground-muted">
                  Use @private:name in a parameter or query to keep its value out of Git.
                </Text>
                <TextInput
                  accessibilityLabel="Private value name"
                  placeholder="Name"
                  className={inputClass}
                  value={privateName}
                  onChangeText={setPrivateName}
                />
                <TextInput
                  accessibilityLabel="Private scenario value"
                  placeholder="Value"
                  secureTextEntry
                  className={inputClass}
                  value={privateValue}
                  onChangeText={setPrivateValue}
                />
                <ControlPill
                  label="Save private value"
                  variant="pill"
                  disabled={busy || !privateName || !privateValue}
                  onPress={() =>
                    void run({
                      type: "private-value",
                      name: privateName,
                      value: privateValue,
                    }).then((ok) => {
                      if (ok) {
                        setPrivateName("");
                        setPrivateValue("");
                      }
                    })
                  }
                />
                {data.privateValueNames.map((name) => (
                  <ControlPill
                    key={name}
                    label={`Remove ${name}`}
                    variant="pill"
                    onPress={() => void run({ type: "private-value", name, value: null })}
                  />
                ))}
                <Text className="font-t3-bold">Recent activity</Text>
                {data.jobs.map((j) => (
                  <View key={j.id} className="gap-2">
                    <Text className="text-xs">
                      {j.kind} · {j.status} · {j.label}
                    </Text>
                    {j.detail && <Text className="text-xs text-foreground-muted">{j.detail}</Text>}
                  </View>
                ))}
              </>
            )}
            {(error || result.error) && (
              <Text accessibilityRole="alert" className="text-sm text-danger">
                {error ?? result.error}
              </Text>
            )}
          </ScrollView>
        </Modal>
      )}
      {source && data && (
        <AtlasSource
          project={project}
          checkout={data.checkout}
          node={source}
          close={() => setSource(null)}
        />
      )}
    </View>
  );
}

function AtlasSource({
  project,
  checkout,
  node,
  close,
}: {
  project: Project;
  checkout: string;
  node: AtlasNode;
  close: () => void;
}) {
  const source = useEnvironmentQuery(
    codebaseEnvironment.source({
      environmentId: project.environmentId,
      input: { cwd: checkout, relativePath: node.source.path },
    }),
  );
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View className="flex-1 bg-screen p-5">
        <ControlPill label="Close source" variant="pill" onPress={close} />
        <Text className="my-4 font-t3-bold">
          {node.source.path}:{node.source.startLine}
        </Text>
        <ScrollView>
          <Text selectable className="font-mono text-xs">
            {source.error ?? source.data?.contents ?? "Loading source…"}
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}
