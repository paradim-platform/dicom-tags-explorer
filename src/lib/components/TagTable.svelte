<script lang="ts">
  // Virtualized tree table of DICOM elements: only the rows in view are rendered,
  // so that fully expanded files with tens of thousands of nested elements stay fast.
  import { SvelteMap } from 'svelte/reactivity';
  import { formatTag } from '../dicom/dictionary';
  import { VRS } from '../dicom/vr';
  import { visibleRows, type FilterResult, type Row, type Tree, type TreeNode } from '../tree';
  import Highlight from './Highlight.svelte';

  interface Props {
    tree: Tree;
    filter: FilterResult | undefined;
    terms: string[];
    showNames: boolean;
    selectedKey: string | undefined;
  }

  let { tree, filter, terms, showNames, selectedKey = $bindable() }: Props = $props();

  const ROW_HEIGHT = 26;
  const OVERSCAN = 10;
  const INDENT = 18;
  /** Files with more nodes than this start with collapsed sequences. */
  const AUTO_EXPAND_LIMIT = 2000;

  let viewport: HTMLDivElement;
  let scrollTop = $state(0);
  let viewportHeight = $state(0);

  let expandMode = $state<'auto' | 'all' | 'none'>('auto');
  // Keyed by node key (tag path) so that the state carries over to other files of a series.
  const overrides = new SvelteMap<string, boolean>();

  function isExpanded(node: TreeNode): boolean {
    const override = overrides.get(node.key);
    if (override !== undefined) return override;
    if (node.kind !== 'element') return true; // sections and items are open by default
    if (expandMode === 'auto') return tree.nodeCount <= AUTO_EXPAND_LIMIT;
    return expandMode === 'all';
  }

  const rows: Row[] = $derived(visibleRows(tree, isExpanded, filter));
  const selectedIndex = $derived(rows.findIndex((row) => row.node.key === selectedKey));
  const maxDepth = $derived(rows.reduce((max, row) => Math.max(max, row.depth), 0));

  const start = $derived(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN));
  const end = $derived(Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN));
  const slice = $derived(rows.slice(start, end));

  export function expandAll() {
    overrides.clear();
    expandMode = 'all';
  }

  export function collapseAll() {
    overrides.clear();
    expandMode = 'none';
  }

  export function focus() {
    viewport?.focus();
  }

  function toggle(row: Row) {
    if (row.expandable) overrides.set(row.node.key, !row.expanded);
  }

  // Go back to the top when the filter changes.
  $effect(() => {
    void filter;
    if (viewport) viewport.scrollTop = 0;
  });

  function select(index: number) {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    selectedKey = row.node.key;
    const top = rows.indexOf(row) * ROW_HEIGHT;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = top + ROW_HEIGHT - viewport.clientHeight;
    }
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const row = rows[selectedIndex];
    const page = Math.max(1, Math.floor(viewport.clientHeight / ROW_HEIGHT) - 1);
    switch (event.key) {
      case 'ArrowDown':
        select(selectedIndex + 1);
        break;
      case 'ArrowUp':
        select(selectedIndex < 0 ? 0 : selectedIndex - 1);
        break;
      case 'PageDown':
        select(selectedIndex + page);
        break;
      case 'PageUp':
        select(selectedIndex - page);
        break;
      case 'Home':
        select(0);
        break;
      case 'End':
        select(rows.length - 1);
        break;
      case 'ArrowRight':
        if (!row) return select(0);
        if (row.expandable && !row.expanded) toggle(row);
        else if (row.expanded) select(selectedIndex + 1);
        break;
      case 'ArrowLeft': {
        if (!row) return select(0);
        if (row.expandable && row.expanded) {
          toggle(row);
        } else if (row.node.parent) {
          const parentIndex = rows.findIndex((r) => r.node === row.node.parent);
          if (parentIndex >= 0) select(parentIndex);
        }
        break;
      }
      case 'Enter':
      case ' ':
        if (row) toggle(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  function vrTitle(node: TreeNode): string {
    if (node.kind !== 'element') return '';
    const { vr, vrSource, encodedVr } = node.element;
    const name = VRS[vr]?.name ?? 'Unknown VR';
    if (encodedVr) return `${vr} (${name}): encoded as ${encodedVr} in the file, interpreted using the dictionary`;
    return vrSource === 'implicit' ? `${vr} (${name}): implicit VR, from the dictionary` : `${vr} (${name})`;
  }
</script>

<div class="table" style:--tag-width="{126 + maxDepth * INDENT}px">
  <div class="header row-grid" role="row">
    <div role="columnheader">Tag</div>
    <div role="columnheader">{showNames ? 'Name' : 'Keyword'}</div>
    <div role="columnheader">VR</div>
    <div role="columnheader">Value</div>
  </div>

  <div
    class="viewport"
    role="treegrid"
    aria-label="DICOM tags"
    tabindex="0"
    bind:this={viewport}
    bind:clientHeight={viewportHeight}
    onscroll={() => (scrollTop = viewport.scrollTop)}
    {onkeydown}
  >
    <div class="spacer" style:height="{rows.length * ROW_HEIGHT}px">
      {#each slice as row, i (row.node.id)}
        {@const node = row.node}
        <!-- Keyboard navigation is handled by the treegrid container. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="row"
          class:row-grid={node.kind !== 'section'}
          class:selected={node.key === selectedKey}
          class:section={node.kind === 'section'}
          class:item={node.kind === 'item'}
          class:context={filter && !row.match && node.kind === 'element'}
          style:transform="translateY({(start + i) * ROW_HEIGHT}px)"
          role="row"
          aria-level={row.depth + 1}
          aria-expanded={row.expandable ? row.expanded : undefined}
          aria-selected={node.key === selectedKey}
          tabindex="-1"
          onclick={() => {
            selectedKey = node.key;
            viewport.focus();
          }}
          ondblclick={() => toggle(row)}
        >
          {#snippet toggleButton()}
            {#if row.expandable}
              <button
                class="toggle"
                tabindex="-1"
                aria-label={row.expanded ? 'Collapse' : 'Expand'}
                onclick={(event) => {
                  event.stopPropagation();
                  selectedKey = node.key;
                  toggle(row);
                  viewport.focus();
                }}
              >
                <svg viewBox="0 0 16 16" class:open={row.expanded}><path d="M6 4l4 4-4 4" /></svg>
              </button>
            {:else}
              <span class="toggle"></span>
            {/if}
          {/snippet}

          {#if node.kind === 'section'}
            {@render toggleButton()}
            <span class="section-title">{node.title}</span>
            <span class="faint">{node.children.length} elements</span>
          {:else if node.kind === 'item'}
            <div class="cell tag" style:padding-left="{row.depth * INDENT}px">
              {@render toggleButton()}
              <span>Item {node.index + 1}</span>
            </div>
            <div class="cell faint">{node.children.length} element{node.children.length === 1 ? '' : 's'}</div>
            <div class="cell"></div>
            <div class="cell"></div>
          {:else}
            {@const element = node.element}
            <div class="cell tag mono" style:padding-left="{row.depth * INDENT}px">
              {@render toggleButton()}
              <span><Highlight text={formatTag(element.tag)} {terms} /></span>
            </div>
            <div
              class="cell keyword"
              class:private={node.keyword.startsWith('[')}
              class:retired={node.retired}
              title={node.retired ? `${node.name} (retired)` : node.name}
            >
              <Highlight text={showNames ? node.name : node.keyword || 'Unknown'} {terms} />
            </div>
            <div class="cell">
              <span
                class="vr"
                class:sq={element.vr === 'SQ'}
                class:implicit={element.vrSource === 'implicit'}
                class:converted={!!element.encodedVr}
                title={vrTitle(node)}>{element.vr}</span
              >
            </div>
            <div class="cell value" title={node.value.length > 80 ? node.value : undefined}>
              {#if element.value.kind === 'empty'}
                <span class="faint">(empty)</span>
              {:else if element.value.kind === 'sequence' || element.value.kind === 'pixel-data'}
                <span class="muted">{node.value}</span>
              {:else}
                <span class="mono"><Highlight text={node.value} {terms} /></span>
              {/if}
              {#if node.annotation}
                <span class="annotation"><Highlight text={node.annotation} {terms} /></span>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
    {#if rows.length === 0}
      <div class="empty muted">No matching tags</div>
    {/if}
  </div>
</div>

<style>
  .table {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
  }

  .row-grid {
    display: grid;
    grid-template-columns: var(--tag-width) minmax(180px, 280px) 48px minmax(0, 1fr);
    align-items: center;
  }

  .header {
    height: 30px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-subtle);
    color: var(--fg-muted);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .header > div:first-child {
    padding-left: 22px;
  }

  .viewport {
    position: relative;
    flex: 1;
    overflow: auto;
    outline: none;
  }

  .spacer {
    position: relative;
    min-width: 100%;
  }

  .row {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 26px;
    padding: 0 12px;
    white-space: nowrap;
    cursor: default;
    border-left: 2px solid transparent;
  }

  .row:hover {
    background: var(--row-hover);
  }

  .row.selected {
    background: var(--row-selected);
    border-left-color: var(--accent);
  }

  .viewport:not(:focus) .row.selected {
    border-left-color: transparent;
  }

  .row.section {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-subtle);
    border-bottom: 1px solid var(--border);
    font-weight: 600;
  }

  .row.section.selected {
    background: var(--row-selected);
  }

  .section-title {
    font-size: 12px;
  }

  .row.item .tag {
    color: var(--fg-muted);
    font-size: 12px;
  }

  .row.context {
    opacity: 0.6;
  }

  .cell {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    padding-right: 12px;
  }

  .tag {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--fg-muted);
  }

  button.toggle:hover {
    background: var(--border);
  }

  .toggle svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 0.1s;
  }

  .toggle svg.open {
    transform: rotate(90deg);
  }

  .keyword.private {
    color: var(--private);
    font-style: italic;
  }

  .keyword.retired {
    color: var(--retired);
    text-decoration: line-through;
    text-decoration-color: var(--border-strong);
  }

  .vr {
    display: inline-block;
    min-width: 28px;
    padding: 0 4px;
    border-radius: 4px;
    background: var(--vr-bg);
    color: var(--vr-fg);
    font-family: var(--font-mono);
    font-size: 11px;
    text-align: center;
  }

  .vr.sq {
    background: var(--vr-sq-bg);
    color: var(--vr-sq-fg);
  }

  .vr.implicit {
    background: none;
    border: 1px dashed var(--border-strong);
  }

  .vr.converted {
    text-decoration: underline dotted;
  }

  .annotation {
    margin-left: 8px;
    color: var(--fg-faint);
  }

  .empty {
    padding: 24px;
    text-align: center;
  }
</style>
