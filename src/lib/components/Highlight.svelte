<script lang="ts">
  // Renders text with the filter terms highlighted.
  let { text, terms }: { text: string; terms: string[] } = $props();

  const parts = $derived.by(() => {
    if (!terms.length || !text) return [{ text, match: false }];
    const lower = text.toLowerCase();
    // Case mapping can change the length of some characters; skip highlighting rather than misplace it.
    if (lower.length !== text.length) return [{ text, match: false }];
    const marked = new Uint8Array(text.length);
    for (const term of terms) {
      for (let i = lower.indexOf(term); i >= 0; i = lower.indexOf(term, i + term.length)) {
        marked.fill(1, i, i + term.length);
      }
    }
    const result: { text: string; match: boolean }[] = [];
    let start = 0;
    for (let i = 1; i <= text.length; i++) {
      if (i === text.length || marked[i] !== marked[start]) {
        result.push({ text: text.slice(start, i), match: marked[start] === 1 });
        start = i;
      }
    }
    return result;
  });
</script>

{#each parts as part, i (i)}{#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}
