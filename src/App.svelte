<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import { copyText } from './lib/clipboard';
  import DetailsPanel from './lib/components/DetailsPanel.svelte';
  import FileList, { type FileStatus } from './lib/components/FileList.svelte';
  import SummaryBar from './lib/components/SummaryBar.svelte';
  import TagTable from './lib/components/TagTable.svelte';
  import { DICTIONARY_SOURCE } from './lib/dicom/dictionary';
  import { NotDicomError } from './lib/dicom/parser';
  import { readDicomFile } from './lib/dicom/reader';
  import type { ParsedDicom } from './lib/dicom/types';
  import { filesFromDataTransfer, filesFromInput, type PickedFile } from './lib/files';
  import { valueList } from './lib/format';
  import { buildTree, filterTree, type Tree } from './lib/tree';

  type LoadResult =
    | { status: 'loading' }
    | { status: 'ok'; parsed: ParsedDicom; tree: Tree }
    | { status: 'not-dicom'; message: string }
    | { status: 'failed'; message: string };

  /** Parsed files kept in memory; older ones are parsed again when revisited. */
  const MAX_CACHED_RESULTS = 300;

  let files = $state.raw<PickedFile[]>([]);
  let selected = $state(0);
  // Results are not deeply reactive (SvelteMap does not proxy values): parsed trees can be big.
  const results = new SvelteMap<PickedFile, LoadResult>();

  let query = $state('');
  let appliedQuery = $state('');
  let showNames = $state(false);
  let selectedKey = $state<string | undefined>();
  let dragDepth = $state(0);

  let table = $state<ReturnType<typeof TagTable>>();
  let filterInput = $state<HTMLInputElement>();
  let fileInput: HTMLInputElement;
  let folderInput: HTMLInputElement;

  const current = $derived<PickedFile | undefined>(files[selected]);
  const result = $derived(current ? results.get(current) : undefined);
  const tree = $derived(result?.status === 'ok' ? result.tree : undefined);
  const terms = $derived(appliedQuery.toLowerCase().split(/\s+/).filter(Boolean));
  const filter = $derived(tree ? filterTree(tree, appliedQuery) : undefined);
  const selectedNode = $derived(tree && selectedKey ? tree.byKey.get(selectedKey) : undefined);

  // Debounce filtering of big files.
  $effect(() => {
    const value = query;
    const delay = tree && tree.nodeCount > 5000 ? 150 : 0;
    if (delay === 0) {
      appliedQuery = value;
      return;
    }
    const timer = setTimeout(() => (appliedQuery = value), delay);
    return () => clearTimeout(timer);
  });

  async function load(file: PickedFile) {
    results.set(file, { status: 'loading' });
    let loaded: LoadResult;
    try {
      const parsed = await readDicomFile(file.file);
      loaded = { status: 'ok', parsed, tree: buildTree(parsed) };
    } catch (error) {
      loaded =
        error instanceof NotDicomError
          ? { status: 'not-dicom', message: error.message }
          : { status: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
    if (!files.includes(file)) return; // another set of files was opened meanwhile
    results.set(file, loaded);
    if (results.size > MAX_CACHED_RESULTS) {
      for (const [key, value] of results) {
        if (results.size <= MAX_CACHED_RESULTS) break;
        if (key !== current && value.status === 'ok') results.delete(key);
      }
    }
  }

  // Load the selected file, and the next one so that stepping through a series feels instant.
  $effect(() => {
    for (const file of [current, files[selected + 1]]) {
      if (file && !results.has(file)) load(file);
    }
  });

  $effect(() => {
    document.title = current ? `${current.path.split('/').pop()} – DICOM Tags Explorer` : 'DICOM Tags Explorer';
  });

  function open(picked: PickedFile[]) {
    if (!picked.length) return;
    results.clear();
    files = picked;
    selected = 0;
  }

  function fileStatus(file: PickedFile): FileStatus {
    const loaded = results.get(file);
    switch (loaded?.status) {
      case undefined:
        return undefined;
      case 'loading':
        return 'loading';
      case 'ok':
        return loaded.parsed.error ? 'error' : loaded.parsed.warnings.length ? 'warning' : 'ok';
      case 'not-dicom':
        return 'not-dicom';
      case 'failed':
        return 'error';
    }
  }

  const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

  function ondrop(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    filesFromDataTransfer(event.dataTransfer!).then(open);
  }

  function onGlobalKeydown(event: KeyboardEvent) {
    const mod = event.ctrlKey || event.metaKey;
    const inInput = event.target instanceof HTMLInputElement;
    if ((mod && event.key === 'f') || (event.key === '/' && !inInput)) {
      if (!tree) return;
      event.preventDefault();
      filterInput?.focus();
      filterInput?.select();
    } else if (mod && event.key === 'o') {
      event.preventDefault();
      fileInput.click();
    } else if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && files.length > 1) {
      event.preventDefault();
      selected = Math.max(0, Math.min(files.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)));
    } else if (mod && event.key === 'c' && !inInput && !window.getSelection()?.toString()) {
      if (selectedNode?.kind !== 'element') return;
      const values = valueList(selectedNode.element);
      if (values.length) {
        event.preventDefault();
        copyText(values.join('\\'));
      }
    }
  }

  function onFilterKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      query = '';
      table?.focus();
    } else if (event.key === 'Enter' || event.key === 'ArrowDown') {
      event.preventDefault();
      appliedQuery = query;
      const first = tree && filter ? tree.elements.find((node) => filter!.matches.has(node)) : undefined;
      if (first) selectedKey = first.key;
      table?.focus();
    }
  }
</script>

<svelte:window
  onkeydown={onGlobalKeydown}
  ondragenter={(event) => hasFiles(event) && dragDepth++}
  ondragleave={(event) => hasFiles(event) && (dragDepth = Math.max(0, dragDepth - 1))}
  ondragover={(event) => hasFiles(event) && event.preventDefault()}
  {ondrop}
/>

<div class="app">
  <header class="topbar">
    <div class="brand">
      <img src="./favicon.svg" alt="" width="20" height="20" />
      <span>DICOM Tags Explorer</span>
    </div>

    {#if files.length}
      <div class="search">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
        <input
          bind:this={filterInput}
          bind:value={query}
          disabled={!tree}
          onkeydown={onFilterKeydown}
          type="search"
          placeholder="Filter by tag, keyword or value"
          aria-label="Filter tags"
          spellcheck="false"
          autocomplete="off"
        />
        {#if filter}
          <span class="count faint">{filter.matches.size} match{filter.matches.size === 1 ? '' : 'es'}</span>
        {:else}
          <kbd class="shortcut">Ctrl F</kbd>
        {/if}
      </div>
      <div class="toolbar">
        <button class="button" disabled={!tree} onclick={() => table?.expandAll()} title="Expand all sequences">
          Expand all
        </button>
        <button class="button" disabled={!tree} onclick={() => table?.collapseAll()} title="Collapse all sequences">
          Collapse all
        </button>
        <div class="segmented" role="group" aria-label="Show keywords or names">
          <button class:active={!showNames} onclick={() => (showNames = false)}>Keyword</button>
          <button class:active={showNames} onclick={() => (showNames = true)}>Name</button>
        </div>
      </div>
    {/if}

    <div class="open">
      <button class="button" onclick={() => fileInput.click()}>Open files…</button>
      <button class="button" onclick={() => folderInput.click()}>Open folder…</button>
    </div>
  </header>

  {#if !files.length}
    <main class="empty">
      <div class="drop-card">
        <svg class="drop-icon" viewBox="0 0 48 48" aria-hidden="true">
          <path d="M14 6h14l10 10v26a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" />
          <path d="M28 6v10h10M18 24h12M18 30h8M18 36h10" />
        </svg>
        <h1>Drop DICOM files or folders here</h1>
        <p class="muted">or</p>
        <div class="actions">
          <button class="button primary" onclick={() => fileInput.click()}>Open files…</button>
          <button class="button" onclick={() => folderInput.click()}>Open folder…</button>
        </div>
        <ul class="notes muted">
          <li>Files are read locally in your browser. Nothing is uploaded.</li>
          <li>Only the header is read: even multi-GB files open instantly.</li>
        </ul>
      </div>
      <p class="footer faint">Tag dictionary: {DICTIONARY_SOURCE}</p>
    </main>
  {:else}
    <main class="workspace" class:multi={files.length > 1}>
      {#if files.length > 1}
        <FileList {files} bind:selected status={fileStatus} />
      {/if}

      <section class="content">
        {#if result?.status === 'ok' && tree && current}
          <SummaryBar picked={current} parsed={result.parsed} />
          <TagTable bind:this={table} {tree} {filter} {terms} {showNames} bind:selectedKey />
        {:else if result?.status === 'not-dicom' || result?.status === 'failed'}
          <div class="message">
            <h2>{result.status === 'not-dicom' ? 'Not a DICOM file' : 'Could not read this file'}</h2>
            <p class="muted">{current?.path}</p>
            <p>{result.message}</p>
          </div>
        {:else}
          <div class="message muted">Reading {current?.path}…</div>
        {/if}
      </section>

      <DetailsPanel node={selectedNode} />
    </main>
  {/if}

  {#if dragDepth > 0}
    <div class="drop-overlay" aria-hidden="true">
      <div>Drop to open</div>
    </div>
  {/if}

  <input
    bind:this={fileInput}
    type="file"
    multiple
    hidden
    onchange={(event) => {
      open(filesFromInput(event.currentTarget.files!));
      event.currentTarget.value = '';
    }}
  />
  <input
    bind:this={folderInput}
    type="file"
    webkitdirectory
    hidden
    onchange={(event) => {
      open(filesFromInput(event.currentTarget.files!));
      event.currentTarget.value = '';
    }}
  />
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .topbar {
    display: flex;
    align-items: center;
    gap: 16px;
    height: 48px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
    flex: none;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    white-space: nowrap;
  }

  .search {
    position: relative;
    display: flex;
    align-items: center;
    flex: 0 1 420px;
    min-width: 160px;
  }

  .search svg {
    position: absolute;
    left: 9px;
    width: 14px;
    height: 14px;
    fill: none;
    stroke: var(--fg-faint);
    stroke-width: 1.6;
    stroke-linecap: round;
    pointer-events: none;
  }

  .search input {
    width: 100%;
    height: 30px;
    padding: 0 90px 0 30px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--bg);
    outline: none;
  }

  .search input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--focus);
  }

  .search .count,
  .search .shortcut {
    position: absolute;
    right: 8px;
    font-size: 11px;
    pointer-events: none;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .segmented {
    display: inline-flex;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    overflow: hidden;
    height: 28px;
  }

  .segmented button {
    border: none;
    background: var(--bg-elevated);
    padding: 0 10px;
  }

  .segmented button + button {
    border-left: 1px solid var(--border-strong);
  }

  .segmented button.active {
    background: var(--accent-subtle);
    color: var(--accent);
    font-weight: 500;
  }

  .open {
    display: flex;
    gap: 6px;
    margin-left: auto;
  }

  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }

  .drop-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    max-width: 520px;
    width: 100%;
    padding: 48px 32px;
    border: 2px dashed var(--border-strong);
    border-radius: 16px;
    text-align: center;
  }

  .drop-icon {
    width: 56px;
    height: 56px;
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
    margin-bottom: 12px;
  }

  h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }

  .drop-card > p {
    margin: 8px 0;
  }

  .actions {
    display: flex;
    gap: 8px;
  }

  .notes {
    margin: 24px 0 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 4px;
    font-size: 12px;
  }

  .footer {
    margin-top: 16px;
    font-size: 11px;
  }

  .workspace {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 380px;
  }

  .workspace.multi {
    grid-template-columns: 260px minmax(0, 1fr) 380px;
  }

  .content {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border-right: 1px solid var(--border);
  }

  .message {
    padding: 32px;
  }

  .message h2 {
    margin: 0 0 4px;
    font-size: 16px;
  }

  .message p {
    margin: 4px 0;
  }

  .drop-overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    pointer-events: none;
    z-index: 10;
  }

  .drop-overlay div {
    padding: 32px 64px;
    border: 2px dashed var(--accent);
    border-radius: 16px;
    background: var(--bg-elevated);
    color: var(--accent);
    font-size: 18px;
    font-weight: 600;
  }

  @media (max-width: 1100px) {
    .workspace,
    .workspace.multi {
      grid-template-columns: minmax(0, 1fr);
    }

    .workspace :global(.files),
    .workspace :global(.details) {
      display: none;
    }
  }
</style>
