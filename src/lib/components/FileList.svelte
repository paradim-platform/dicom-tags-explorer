<script lang="ts" module>
  export type FileStatus = 'loading' | 'ok' | 'warning' | 'error' | 'not-dicom' | undefined;
</script>

<script lang="ts">
  import type { PickedFile } from '../files';
  import { formatBytes } from '../format';

  interface Props {
    files: PickedFile[];
    selected: number;
    status: (file: PickedFile) => FileStatus;
  }

  let { files, selected = $bindable(), status }: Props = $props();

  let list: HTMLUListElement;

  // Keep the selected file visible (e.g. when navigating with Alt+arrows from the table).
  $effect(() => {
    list?.children[selected]?.scrollIntoView({ block: 'nearest' });
  });

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') selected = Math.min(files.length - 1, selected + 1);
    else if (event.key === 'ArrowUp') selected = Math.max(0, selected - 1);
    else if (event.key === 'Home') selected = 0;
    else if (event.key === 'End') selected = files.length - 1;
    else return;
    event.preventDefault();
  }

  const statusLabel: Record<NonNullable<FileStatus>, string> = {
    loading: 'Loading',
    ok: 'DICOM',
    warning: 'DICOM with warnings',
    error: 'DICOM with errors',
    'not-dicom': 'Not a DICOM file',
  };
</script>

<nav class="files" aria-label="Files">
  <div class="title">
    <span>{files.length} files</span>
  </div>
  <ul bind:this={list} role="listbox" tabindex="0" aria-label="Files" {onkeydown}>
    {#each files as file, i (file.path + i)}
      {@const slash = file.path.lastIndexOf('/')}
      {@const fileStatus = status(file)}
      <!-- Keyboard navigation is handled by the listbox. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <li
        role="option"
        aria-selected={i === selected}
        class:selected={i === selected}
        class:not-dicom={fileStatus === 'not-dicom'}
        title={file.path}
        onclick={() => (selected = i)}
      >
        <span class="dot {fileStatus ?? ''}" title={fileStatus ? statusLabel[fileStatus] : 'Not loaded yet'}></span>
        <span class="name">
          {file.path.slice(slash + 1)}{#if slash >= 0}<span class="dir">{file.path.slice(0, slash)}</span>{/if}
        </span>
        <span class="size faint">{formatBytes(file.file.size)}</span>
      </li>
    {/each}
  </ul>
</nav>

<style>
  .files {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border);
    background: var(--bg-subtle);
  }

  .title {
    display: flex;
    align-items: center;
    height: 30px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
    color: var(--fg-muted);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  ul {
    flex: 1;
    overflow: auto;
    margin: 0;
    padding: 4px 0;
    list-style: none;
    outline: none;
  }

  li {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 26px;
    padding: 0 10px;
    cursor: default;
    border-left: 2px solid transparent;
  }

  li:hover {
    background: var(--row-hover);
  }

  li.selected {
    background: var(--row-selected);
  }

  ul:focus li.selected {
    border-left-color: var(--accent);
  }

  li.not-dicom .name {
    color: var(--fg-faint);
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dir {
    margin-left: 8px;
    color: var(--fg-faint);
    font-size: 11px;
  }

  .size {
    font-size: 11px;
    flex: none;
  }

  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 1px solid var(--border-strong);
  }

  .dot.ok {
    background: #30a46c;
    border-color: #30a46c;
  }

  .dot.warning {
    background: #f5a623;
    border-color: #f5a623;
  }

  .dot.error {
    background: #e5484d;
    border-color: #e5484d;
  }

  .dot.not-dicom {
    background: var(--border-strong);
  }

  .dot.loading {
    border-color: var(--accent);
  }
</style>
