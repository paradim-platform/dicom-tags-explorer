<script lang="ts">
  import { lookupUid } from '../dicom/dictionary';
  import type { DicomElement, ParsedDicom } from '../dicom/types';
  import type { PickedFile } from '../files';
  import { formatBytes } from '../format';

  let { picked, parsed }: { picked: PickedFile; parsed: ParsedDicom } = $props();

  function text(tag: number): string | undefined {
    const find = (list: DicomElement[]) => list.find((element) => element.tag === tag);
    const element = find(parsed.dataset) ?? find(parsed.meta);
    if (element?.value.kind !== 'text') return undefined;
    return element.value.values.filter(Boolean).join('\\') || undefined;
  }

  function uidName(uid: string | undefined): string | undefined {
    return uid ? (lookupUid(uid)?.name ?? uid) : undefined;
  }

  function formatDate(value: string | undefined): string | undefined {
    const match = value && /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : value;
  }

  const ts = $derived(parsed.transferSyntax);
  const sopClass = $derived(text(0x00080016) ?? text(0x00020002));
  const facts = $derived(
    [
      { label: 'Modality', value: text(0x00080060) },
      { label: 'SOP Class', value: uidName(sopClass), title: sopClass },
      { label: 'Patient', value: [text(0x00100010), text(0x00100020)].filter(Boolean).join(' · ') || undefined },
      { label: 'Study date', value: formatDate(text(0x00080020)) },
      { label: 'Charset', value: text(0x00080005) },
    ].filter((fact) => fact.value),
  );
</script>

<div class="summary">
  <div class="file">
    <span class="path" title={picked.path}>{picked.path}</span>
    <span class="faint">{formatBytes(picked.file.size)}</span>
  </div>
  <div class="facts">
    <span class="fact" title={ts.uid}>
      <span class="label">Transfer Syntax</span>
      {uidName(ts.uid)?.replace(/:.*$/, '')}{#if ts.guessed}<span class="faint"> (detected)</span>{/if}
    </span>
    {#each facts as fact (fact.label)}
      <span class="fact" title={fact.title}>
        <span class="label">{fact.label}</span>
        {fact.value}
      </span>
    {/each}
  </div>

  {#if parsed.error}
    <div class="banner error" role="alert">
      <strong>Parsing stopped:</strong>
      {parsed.error}. The elements read before the error are shown.
    </div>
  {/if}
  {#if parsed.warnings.length}
    <details class="banner warning">
      <summary>{parsed.warnings.length} warning{parsed.warnings.length === 1 ? '' : 's'}</summary>
      <ul>
        {#each parsed.warnings as warning, i (i)}
          <li>{warning}</li>
        {/each}
      </ul>
    </details>
  {/if}
</div>

<style>
  .summary {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    display: grid;
    gap: 8px;
  }

  .file {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }

  .path {
    font-weight: 600;
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .fact {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    max-width: 100%;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-subtle);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .label {
    color: var(--fg-faint);
    font-size: 11px;
  }

  .banner {
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid;
    font-size: 12px;
  }

  .banner.error {
    background: var(--error-bg);
    color: var(--error-fg);
    border-color: var(--error-border);
  }

  .banner.warning {
    background: var(--warning-bg);
    color: var(--warning-fg);
    border-color: var(--warning-border);
  }

  summary {
    cursor: pointer;
  }

  ul {
    margin: 6px 0 0;
    padding-left: 20px;
  }
</style>
