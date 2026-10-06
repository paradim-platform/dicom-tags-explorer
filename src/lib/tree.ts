// Display tree built from a parsed file: sections > elements > items > elements...
// Flattened into rows for the (virtualized) tag table, with filtering.

import { formatTag, isPrivateCreatorTag, isPrivateTag, lookupTag, tagToHex } from './dicom/dictionary';
import type { DicomElement, DicomItem, ParsedDicom } from './dicom/types';
import { formatValue, valueAnnotation } from './format';

// `id` is unique within a tree. `key` identifies the "same" node across files with a similar structure
// (path of tags and item indexes), to keep the expansion state and selection when switching files.

export interface SectionNode {
  kind: 'section';
  id: string;
  key: string;
  title: string;
  parent?: undefined;
  children: ElementNode[];
}

export interface ElementNode {
  kind: 'element';
  id: string;
  key: string;
  parent: SectionNode | ItemNode;
  element: DicomElement;
  keyword: string;
  name: string;
  retired: boolean;
  /** One-line value summary. */
  value: string;
  annotation?: string;
  children?: ItemNode[];
  /** Lower-case text matched by the filter. */
  searchText: string;
}

export interface ItemNode {
  kind: 'item';
  id: string;
  key: string;
  parent: ElementNode;
  item: DicomItem;
  index: number;
  children: ElementNode[];
}

export type TreeNode = SectionNode | ElementNode | ItemNode;

export interface Tree {
  sections: SectionNode[];
  /** Number of element and item nodes. */
  nodeCount: number;
  elements: ElementNode[];
  byKey: Map<string, TreeNode>;
}

export interface Row {
  node: TreeNode;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  /** The node itself matches the filter (as opposed to being shown as an ancestor of a match). */
  match: boolean;
}

function describe(element: DicomElement): { keyword: string; name: string; retired: boolean } {
  const { tag } = element;
  if (isPrivateTag(tag) && !isPrivateCreatorTag(tag) && (tag & 0xffff) !== 0) {
    const creator = element.privateCreator;
    return creator !== undefined
      ? { keyword: `[${creator}]`, name: `Private tag reserved by "${creator}"`, retired: false }
      : { keyword: '[Private]', name: 'Private tag (no private creator found)', retired: false };
  }
  const info = lookupTag(tag);
  if (!info) return { keyword: '', name: 'Unknown tag', retired: false };
  return { keyword: info.keyword || info.name, name: info.name || info.keyword, retired: info.retired };
}

export function buildTree(parsed: ParsedDicom): Tree {
  const elements: ElementNode[] = [];
  let nodeCount = 0;

  const elementNodes = (list: DicomElement[], parent: SectionNode | ItemNode, prefix: string): ElementNode[] =>
    list.map((element, i) => {
      const id = `${prefix}/${i}`;
      const key = `${parent.key}/${tagToHex(element.tag)}`;
      const { keyword, name, retired } = describe(element);
      const value = formatValue(element);
      const annotation = valueAnnotation(element);
      const node: ElementNode = {
        kind: 'element',
        id,
        key,
        parent,
        element,
        keyword,
        name,
        retired,
        value,
        annotation,
        searchText: [formatTag(element.tag), tagToHex(element.tag), keyword, name, value, annotation ?? '']
          .join('\n')
          .toLowerCase(),
      };
      nodeCount++;
      elements.push(node);
      if (element.items) {
        node.children = element.items.map((item, index) => {
          const itemNode: ItemNode = {
            kind: 'item',
            id: `${id}/${index}`,
            key: `${key}[${index}]`,
            parent: node,
            item,
            index,
            children: [],
          };
          nodeCount++;
          itemNode.children = elementNodes(item.elements, itemNode, itemNode.id);
          return itemNode;
        });
      }
      return node;
    });

  const sections: SectionNode[] = [];
  if (parsed.meta.length) {
    const section: SectionNode = { kind: 'section', id: 'meta', key: 'meta', title: 'File Meta Information', children: [] };
    section.children = elementNodes(parsed.meta, section, 'meta');
    sections.push(section);
  }
  const dataset: SectionNode = { kind: 'section', id: 'dataset', key: 'dataset', title: 'Data Set', children: [] };
  dataset.children = elementNodes(parsed.dataset, dataset, 'dataset');
  sections.push(dataset);

  const byKey = new Map<string, TreeNode>();
  const index = (node: TreeNode) => {
    if (!byKey.has(node.key)) byKey.set(node.key, node);
    node.children?.forEach(index);
  };
  sections.forEach(index);

  return { sections, nodeCount, elements, byKey };
}

export interface FilterResult {
  matches: Set<TreeNode>;
  /** Ancestors of matches, shown (expanded) to give context. */
  ancestors: Set<TreeNode>;
}

/**
 * Finds the elements matching a query. All whitespace-separated terms must match the
 * tag ("0010,0010", "00100010"), keyword, name or value (case-insensitive).
 */
export function filterTree(tree: Tree, query: string): FilterResult | undefined {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return undefined;
  const matches = new Set<TreeNode>();
  const ancestors = new Set<TreeNode>();
  for (const node of tree.elements) {
    if (!terms.every((term) => node.searchText.includes(term))) continue;
    matches.add(node);
    for (let parent: TreeNode | undefined = node.parent; parent && !ancestors.has(parent); parent = parent.parent) {
      ancestors.add(parent);
    }
  }
  return { matches, ancestors };
}

/** Flattens the tree into the rows to display, given the expansion state and an optional filter. */
export function visibleRows(
  tree: Tree,
  isExpanded: (node: TreeNode) => boolean,
  filter: FilterResult | undefined,
): Row[] {
  const rows: Row[] = [];
  const walk = (nodes: TreeNode[], depth: number, insideMatch: boolean) => {
    for (const node of nodes) {
      const match = filter?.matches.has(node) ?? false;
      const forced = !insideMatch && (filter?.ancestors.has(node) ?? false);
      if (filter && !insideMatch && !match && !forced) continue;
      const children = node.children ?? [];
      const expandable = children.length > 0;
      const expanded = expandable && (forced || isExpanded(node));
      rows.push({ node, depth, expandable, expanded, match });
      // Section children are not indented.
      if (expanded) walk(children, node.kind === 'section' ? depth : depth + 1, insideMatch || match);
    }
  };
  walk(tree.sections, 0, false);
  return rows;
}

/** Path of an element, e.g. "ReferencedSeriesSequence[0].SeriesInstanceUID" and "(0008,1115)[0].(0020,000E)". */
export function elementPath(node: ElementNode): { keywords: string; tags: string } {
  const segments: (ElementNode | ItemNode)[] = [];
  for (let current: TreeNode | undefined = node; current && current.kind !== 'section'; current = current.parent) {
    segments.unshift(current);
  }
  let keywords = '';
  let tags = '';
  for (const segment of segments) {
    if (segment.kind === 'item') {
      keywords += `[${segment.index}]`;
      tags += `[${segment.index}]`;
    } else {
      const separator = keywords ? '.' : '';
      const tag = formatTag(segment.element.tag);
      keywords += separator + (/^[A-Za-z0-9]+$/.test(segment.keyword) ? segment.keyword : tag);
      tags += separator + tag;
    }
  }
  return { keywords, tags };
}
