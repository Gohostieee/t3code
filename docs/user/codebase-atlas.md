# Codebase atlas

Open **Codebase** from the sidebar, chat header, command palette, or Open codebase shortcut. Choose your project, checkout, and application, then select **Index codebase**. Indexing reads the working copy, including eligible uncommitted files. It needs no AI account and does not run your application.

**Routes** lists pages and endpoints. **Modules** shows source relationships, **Features** holds groups you name, and **Files** accounts for the inventory. Search and paging keep large applications manageable. Select an item to inspect its source, follow relationships, or assign it to a feature. Breadcrumbs return to earlier scopes. Use **Ungrouped routes only** to find routes you have not organized.

The first adapters cover Next.js 16 App Router and TanStack file routes. Other JavaScript and TypeScript projects receive generic source views. Diagnostics explain unsupported routing, computed dependencies, and parse failures. An import or JSX reference describes source structure; it does not prove a runtime call or rendered component.

## Real page previews

Start your application using your normal workflow. In **Preview setup and activity**, attach its origin and optional deployment prefix. The address must be reachable from the selected environment: when connected remotely, localhost means that environment's machine. Attaching a target confirms your choice; it does not verify that the running app matches the indexed checkout.

Set up the capture browser explicitly if it is unavailable. This downloads Chromium in the environment. Opening Codebase or indexing never downloads a browser.

Choose **Set up preview** on a page. Name the scenario, supply its dynamic parameters and optional query values, choose a viewport and theme, and specify visible text or a locator that means the page is ready. Use expected final path or HTTP status for intentional redirects and error states. Save separate scenarios for populated, empty, signed-out, and error states.

For authenticated pages, import a Playwright storage-state JSON profile in setup, then select it in the scenario. Profiles can be replaced or removed. Private scenario values stay in the environment; reference them as `@private:name` in a parameter or query value. Share only scenario definitions that are safe to commit.

**Save and capture** opens an isolated browser context in the environment. Enlarge a capture to inspect it. Setup also offers a selection of up to 20 saved scenarios; captures run one at a time. A capture records one viewport at one moment, with its outcome and time. It does not establish complete runtime coverage.

Source, scenario, target, and profile changes can make images outdated. External data changes require a fresh capture. Unavailable or evicted images can be recaptured. You can delete captures, remove scenarios, and detach the target without affecting source files or stopping your app.

## Refresh and portability

Refresh the index after source edits. The previous accepted map stays visible while work runs. Activity shows progress, cancellation, and failures. Disconnecting a client leaves server-owned work running; reconnecting or opening another client shows the same accepted map. After an environment restart, interrupted jobs require an explicit retry.

Structural maps, feature groups, and scenario definitions live in `.t3-codebase/atlas` and can be reviewed and committed with your source. Indexing never stages, commits, pushes, or switches branches. Browser profiles, target addresses, screenshots, and job history stay in the environment. Another clone can open committed maps and configure its own captures.

Source freshness and preview coverage are separate. Narrow inspection views may show unknown freshness until you return to the overview or refresh. A partial map remains useful, with limitations visible in Diagnostics. If portable files contain conflicts or invalid data, restore them from Git or move the affected application's atlas directory aside before explicitly indexing again. Codebase preserves damaged files instead of replacing them automatically.

**Legacy AI map** opens earlier accepted documentation in a read-only view. It remains separate from source-derived facts.
