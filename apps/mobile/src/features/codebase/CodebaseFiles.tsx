import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import type { CodebaseCheckoutInput, EnvironmentId } from "@t3tools/contracts";
import { codebaseEnvironment } from "../../state/codebase";
import { useEnvironmentQuery } from "../../state/query";
import { ControlPill } from "../../components/ControlPill";
import { AppText as Text } from "../../components/AppText";

export function CodebaseFiles({
  environmentId,
  input,
  revision,
  close,
  openScope,
}: {
  environmentId: EnvironmentId;
  input: CodebaseCheckoutInput;
  revision: string;
  close: () => void;
  openScope: (id: string, title: string) => void;
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
  const submit = () => {
    setQuery(search);
    setOffset(0);
  };
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <ScrollView
        className="bg-screen"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 20, gap: 16 }}
      >
        <ControlPill label="Close files" variant="pill" onPress={close} />
        <Text className="text-xl font-t3-bold">Files and change impact</Text>
        <Text className="text-xs text-foreground-muted">
          SHA-256 records file bytes. Impact follows literal JavaScript and TypeScript imports,
          workspace packages, and saved source references. Computed imports, runtime behavior, and
          other languages may have additional dependencies.
        </Text>
        <TextInput
          accessibilityLabel="Search codebase files"
          placeholder="Find a file…"
          className="rounded-lg bg-subtle p-3 text-foreground"
          value={search}
          onChangeText={setSearch}
          onSubmitEditing={submit}
          returnKeyType="search"
        />
        <View className="flex-row flex-wrap gap-2">
          <ControlPill label="Search" variant="pill" onPress={submit} />
          <ControlPill
            label={changedOnly ? "Show all files" : "Changed files only"}
            variant="pill"
            onPress={() => {
              setChangedOnly((value) => !value);
              setOffset(0);
            }}
          />
        </View>
        {map.error && <Text accessibilityRole="alert">{map.error}</Text>}
        {map.isPending && <Text>Reading file hashes…</Text>}
        {index && (
          <Text className="text-xs text-foreground-muted">
            {index.inspectedFiles} of {index.totalFiles} files fully supplied · {index.changedFiles}{" "}
            changed · {index.staleScopes} maps need review · {index.excludedFiles} excluded
          </Text>
        )}
        {index?.files.map((file) => (
          <View key={file.path} className="gap-2 border-b border-separator pb-3">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Inspect ${file.path}`}
              accessibilityState={{ expanded: expanded === file.path }}
              className="py-3"
              onPress={() => setExpanded((path) => (path === file.path ? null : file.path))}
            >
              <Text className="font-t3-bold">{file.path}</Text>
            </Pressable>
            <Text className="text-xs text-foreground-muted">
              {file.change} ·{" "}
              {file.inspected ? "fully supplied" : (file.exclusion ?? "analysis pending")} · affects{" "}
              {file.affectedFileCount} files and {file.affectedScopeCount} maps
            </Text>
            {expanded === file.path && (
              <View className="gap-3">
                <Text selectable className="font-mono text-xs">
                  Current SHA-256: {file.sha256 ?? "No regular file"}
                </Text>
                {file.previousSha256 !== file.sha256 && (
                  <Text selectable className="font-mono text-xs">
                    Saved SHA-256: {file.previousSha256 ?? "Not indexed"}
                  </Text>
                )}
                <Text className="text-xs">
                  Imports: {file.dependsOn.join(", ") || "None recorded"}
                </Text>
                <Text className="text-xs">
                  Affected files: {file.affectedFiles.join(", ") || "None recorded"}
                  {file.affectedFileCount > file.affectedFiles.length
                    ? ` (first ${file.affectedFiles.length} of ${file.affectedFileCount})`
                    : ""}
                </Text>
                <Text className="text-xs">
                  Potentially affected maps
                  {file.affectedScopeCount > file.affectedScopes.length
                    ? ` (first ${file.affectedScopes.length} of ${file.affectedScopeCount})`
                    : ""}
                </Text>
                {file.affectedScopes.map((scope) => (
                  <Pressable
                    key={scope.scopeId}
                    accessibilityRole="button"
                    className="py-3"
                    onPress={() => openScope(scope.scopeId, scope.title)}
                  >
                    <Text>
                      {scope.title} · {scope.stale ? "Needs update" : "Current"}
                    </Text>
                  </Pressable>
                ))}
                {file.scopes.map((scope) => (
                  <Pressable
                    key={scope.scopeId}
                    accessibilityRole="button"
                    className="py-3"
                    onPress={() => openScope(scope.scopeId, scope.title)}
                  >
                    <Text>Open {scope.title}</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        ))}
        {index?.files.length === 0 && <Text>No matching files.</Text>}
        {index && (
          <View className="flex-row flex-wrap items-center gap-3">
            <ControlPill
              label="Previous"
              variant="pill"
              disabled={offset === 0}
              onPress={() => setOffset((value) => Math.max(0, value - 50))}
            />
            <Text className="text-xs">
              {index.matchingFiles ? offset + 1 : 0}–{Math.min(offset + 50, index.matchingFiles)} of{" "}
              {index.matchingFiles}
            </Text>
            <ControlPill
              label="Next"
              variant="pill"
              disabled={offset + 50 >= index.matchingFiles}
              onPress={() => setOffset((value) => value + 50)}
            />
          </View>
        )}
      </ScrollView>
    </Modal>
  );
}
