# Explore your codebase

Open **Codebase** in the sidebar to see how a project's systems fit together. The chat header, command palette, and **Open codebase** keybinding lead to the same workspace. The default shortcut is Ctrl+Alt+M (Command+Option+M on macOS). You can explore without creating a conversation.

Check the project, checkout, and branch above the map. Opening from a conversation selects its worktree. Choose another existing checkout to explore that checkout's files. A worktree draft must be provisioned before it can be analyzed.

## Build and explore

Choose an analyzer, review its model options, and select **Build overview**. Analysis starts only after you choose Build or Refresh. Reading, inspecting, scrolling, or returning to a map does not start another pass.

Select a node to see its responsibility, technology, source references, and connections. Select a connection to see its direction, mechanism, and evidence. Inferred connections are labeled and drawn with dashed lines. Source references open source from the selected environment, including when you connect remotely.

Choose **Explore** to open a node's next layer. You can also double-click or use the node's context menu. If that layer has not been built, review the selected analyzer and choose **Build this layer**. Each pass describes one immediate scope. Breadcrumbs return to earlier scopes and restore your selection and position. Mobile provides the same inspection and exploration actions in an outline.

Coverage is deliberately bounded. The map explains the source supplied to the analyzer; it does not prove every runtime behavior. Review the coverage and omissions and verify important claims using the source links.

## Choose your analyzer

**AI setup** provides a project default plus optional Overview and Detail overrides. The model picker beside Build overrides the current pass. Removing a pass override restores inheritance. Settings links to this project setup and your provider accounts.

Analyzer preferences travel with the project. Credentials and account bindings stay in the environment. If a saved model is unavailable, or several accounts could match, choose the account explicitly. T3 does not silently substitute another analyzer. Previously accepted maps can be read without an AI account.

Currently, Codex supports codebase analysis. Other adapters are unavailable for these passes until they can enforce inspection permissions. Codex receives a bounded source bundle with execution tools, network search, apps, and MCP tools disabled. The server validates and saves the result.

## Follow a pass

**Analysis activity** shows queued, running, waiting, validating, saving, and terminal attempts. **View transcript** opens the attempt's source input, response, and provider activity. These attempts do not appear in your conversation list.

Cancel stops a pending attempt without removing the last accepted map. After a result has been saved, cancellation reports it as complete. A disconnected client can reconnect to the same durable attempt. After a server restart, a completed response may finish saving if its inputs are unchanged. Unfinished provider work requires an explicit retry. A map removed or changed after saving began is preserved. T3 does not automatically start another paid pass.

## Keep maps with your source

Accepted maps are readable JSON files in `.t3-codebase` inside your project. The manifest contains portable preferences; each explored scope has its own file. Review and commit them through your normal Git workflow. Building a map never stages, commits, pushes, or switches branches. An ignored map directory is identified in the workspace.

The selected branch and worktree determine which map files you see. Uncommitted files follow Git's ordinary checkout behavior. A branch without a map shows an unbuilt view. Committing only map files does not make unchanged source stale.

When source or analysis configuration changes, the existing map remains readable with a freshness warning. **Check source freshness** reads the checkout without running an analyzer. **Refresh this scope** requests a new pass and leaves other layers untouched.

If inputs or the destination change during a pass, its result is retained in the transcript and is not accepted over the newer files. Reload and start another pass. Invalid JSON, Git conflicts, unsupported versions, and inaccessible checkouts are reported separately. Resolve the files in source control and reload; T3 does not automatically repair or overwrite them.
