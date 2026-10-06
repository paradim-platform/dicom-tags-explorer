<script lang="ts">
  import { copyText } from '../clipboard';
  import { formatTag, lookupTag, lookupUid } from '../dicom/dictionary';
  import type { DicomElement } from '../dicom/types';
  import { VRS } from '../dicom/vr';
  import { formatBytes, valueList } from '../format';
  import { elementPath, type TreeNode } from '../tree';

  let { node }: { node: TreeNode | undefined } = $props();

  let copied = $state<string | undefined>();
  let copiedTimer: ReturnType<typeof setTimeout>;

  async function copy(id: string, text: string) {
    if (await copyText(text)) {
      copied = id;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copied = undefined), 1200);
    }
  }

  const offset = (value: number) => `${value} (0x${value.toString(16).toUpperCase()})`;
  const length = (value: number, undefinedLength: boolean) => (undefinedLength ? 'Undefined (delimited)' : `${value} bytes`);

  function hexDump(bytes: Uint8Array): { offset: string; hex: string; ascii: string }[] {
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const chunk = bytes.subarray(i, i + 16);
      lines.push({
        offset: i.toString(16).padStart(6, '0'),
        hex: [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' '),
        ascii: [...chunk].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join(''),
      });
    }
    return lines;
  }

  function vrDescription(element: DicomElement): string {
    const name = VRS[element.vr]?.name ?? 'Unknown';
    if (element.encodedVr) return `${element.vr} – ${name} (encoded as ${element.encodedVr}, interpreted with the dictionary VR)`;
    return `${element.vr} – ${name} (${element.vrSource === 'explicit' ? 'explicit' : 'implicit, from the dictionary'})`;
  }
</script>

{#snippet copyButton(id: string, text: string, label = 'Copy')}
  <button class="button small" onclick={() => copy(id, text)} title="Copy to clipboard">
    {copied === id ? 'Copied!' : label}
  </button>
{/snippet}

<aside class="details" aria-label="Tag details">
  {#if !node}
    <div class="placeholder muted">
      <p>Select a tag to see its details.</p>
      <ul class="hints">
        <li><kbd>↑</kbd> <kbd>↓</kbd> move</li>
        <li><kbd>←</kbd> <kbd>→</kbd> collapse / expand</li>
        <li><kbd>Ctrl</kbd>+<kbd>F</kbd> or <kbd>/</kbd> filter</li>
        <li><kbd>Ctrl</kbd>+<kbd>C</kbd> copy value</li>
        <li><kbd>Alt</kbd>+<kbd>↑</kbd> <kbd>↓</kbd> previous / next file</li>
      </ul>
    </div>
  {:else if node.kind === 'section'}
    <header>
      <h2>{node.title}</h2>
      <p class="muted">{node.children.length} top-level elements</p>
    </header>
  {:else if node.kind === 'item'}
    {@const path = elementPath(node.parent)}
    <header>
      <h2>Item {node.index + 1} <span class="muted">of {node.parent.element.items?.length}</span></h2>
      <p class="muted">in {node.parent.keyword || formatTag(node.parent.element.tag)}</p>
    </header>
    <dl>
      <dt>Elements</dt>
      <dd>{node.children.length}</dd>
      <dt>Length</dt>
      <dd>{length(node.item.length, node.item.undefinedLength)}</dd>
      <dt>Offset</dt>
      <dd class="mono">{offset(node.item.offset)}</dd>
      <dt>Path</dt>
      <dd class="mono path">{path.keywords}[{node.index}]</dd>
    </dl>
  {:else}
    {@const element = node.element}
    {@const info = lookupTag(element.tag)}
    {@const values = valueList(element)}
    {@const path = elementPath(node)}
    {@const value = element.value}
    <header>
      <div class="title-row">
        <span class="mono tag">{formatTag(element.tag)}</span>
        <span class="vr">{element.vr}</span>
        {#if node.retired}<span class="badge">Retired</span>{/if}
        {#if element.privateCreator !== undefined || node.keyword.startsWith('[')}<span class="badge private">Private</span>{/if}
      </div>
      <h2 class:private={node.keyword.startsWith('[')}>{node.keyword || 'Unknown tag'}</h2>
      <p class="muted">{node.name}</p>
    </header>

    <section>
      <div class="section-header">
        <h3>
          Value
          {#if values.length > 1}<span class="faint">({values.length} values)</span>{/if}
        </h3>
        {#if values.length}{@render copyButton('value', values.join('\\'))}{/if}
      </div>

      {#if value.kind === 'empty'}
        <p class="faint">(empty)</p>
      {:else if value.kind === 'sequence'}
        <p>{element.items?.length ?? 0} item{element.items?.length === 1 ? '' : 's'}</p>
      {:else if value.kind === 'pixel-data'}
        <p>
          {value.encapsulated ? 'Encapsulated (compressed)' : 'Native'} pixel data, not loaded.
          {#if value.fragments !== undefined}<br />{value.fragments} fragment{value.fragments === 1 ? '' : 's'}.{/if}
        </p>
      {:else if values.length}
        <ol class="values" class:numbered={values.length > 1}>
          {#each values as v, i (i)}
            {@const uid = element.vr === 'UI' ? lookupUid(v) : undefined}
            <li>
              <button class="value mono" title="Click to copy" onclick={() => copy(`v${i}`, v)}>
                {#if v === ''}<span class="faint">(empty)</span>{:else}{v}{/if}
              </button>
              {#if copied === `v${i}`}<span class="copied">Copied!</span>{/if}
              {#if uid}
                <div class="uid-name">{uid.name}{uid.retired ? ' (retired)' : ''} <span class="faint">· {uid.type}</span></div>
              {/if}
            </li>
          {/each}
        </ol>
        {#if value.kind === 'numbers' && value.count > value.values.length}
          <p class="faint">Showing the first {value.values.length} of {value.count} values.</p>
        {/if}
        {#if value.kind === 'bytes'}
          <p class="faint">Shown as text: the VR is unknown (UN) and the bytes are printable.</p>
        {/if}
      {/if}

      {#if value.kind === 'bytes'}
        <div class="hexdump mono">
          {#each hexDump(value.preview) as line (line.offset)}
            <div><span class="faint">{line.offset}</span>&nbsp;&nbsp;{line.hex.padEnd(47, ' ')}&nbsp;&nbsp;<span class="muted">{line.ascii}</span></div>
          {/each}
        </div>
        {#if value.length > value.preview.length}
          <p class="faint">Showing the first {formatBytes(value.preview.length)} of {formatBytes(value.length)}.</p>
        {/if}
      {/if}
    </section>

    <section>
      <h3>Element</h3>
      <dl>
        <dt>VR</dt>
        <dd>{vrDescription(element)}</dd>
        {#if info?.vm}
          <dt>VM</dt>
          <dd>{values.length || (value.kind === 'empty' ? 0 : 1)} <span class="faint">(dictionary: {info.vm})</span></dd>
        {/if}
        <dt>Length</dt>
        <dd>{length(element.length, element.undefinedLength)}</dd>
        <dt>Offset</dt>
        <dd class="mono">{offset(element.offset)}</dd>
        {#if element.privateCreator !== undefined}
          <dt>Creator</dt>
          <dd class="mono">{element.privateCreator}</dd>
        {/if}
      </dl>
    </section>

    <section>
      <div class="section-header">
        <h3>Path</h3>
      </div>
      <div class="path-row">
        <code class="path">{path.keywords}</code>
        {@render copyButton('path-keywords', path.keywords)}
      </div>
      <div class="path-row">
        <code class="path">{path.tags}</code>
        {@render copyButton('path-tags', path.tags)}
      </div>
    </section>
  {/if}
</aside>

<style>
  .details {
    overflow: auto;
    padding: 16px;
    background: var(--bg);
  }

  .placeholder p {
    margin-top: 0;
  }

  .hints {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 8px;
    font-size: 12px;
  }

  header {
    margin-bottom: 16px;
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .tag {
    font-size: 13px;
    color: var(--fg-muted);
  }

  h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    word-break: break-word;
  }

  h2.private {
    color: var(--private);
    font-style: italic;
  }

  header p {
    margin: 2px 0 0;
  }

  h3 {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fg-muted);
  }

  section {
    padding: 12px 0;
    border-top: 1px solid var(--border);
  }

  section > h3 {
    margin-bottom: 8px;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    min-height: 22px;
  }

  .vr,
  .badge {
    padding: 0 5px;
    border-radius: 4px;
    background: var(--vr-bg);
    color: var(--vr-fg);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .badge {
    font-family: var(--font-sans);
  }

  .badge.private {
    color: var(--private);
  }

  .values {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 4px;
  }

  .values.numbered {
    list-style: decimal;
    padding-left: 28px;
  }

  .values.numbered li::marker {
    color: var(--fg-faint);
    font-size: 11px;
  }

  .value {
    display: block;
    width: 100%;
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-subtle);
    text-align: left;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .value:hover {
    border-color: var(--border-strong);
  }

  .copied {
    font-size: 11px;
    color: var(--accent);
  }

  .uid-name {
    margin: 2px 0 0 6px;
    font-size: 12px;
  }

  .hexdump {
    overflow-x: auto;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-subtle);
    font-size: 11px;
    line-height: 1.5;
    white-space: pre;
  }

  dl {
    display: grid;
    grid-template-columns: 80px minmax(0, 1fr);
    gap: 6px 8px;
    margin: 0;
  }

  dt {
    color: var(--fg-muted);
  }

  dd {
    margin: 0;
    word-break: break-word;
  }

  .path-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-bottom: 6px;
  }

  .path {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    word-break: break-all;
  }

  p {
    margin: 0;
  }
</style>
