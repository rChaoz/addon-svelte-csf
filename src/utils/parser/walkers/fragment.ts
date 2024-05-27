import dedent from 'dedent';
import type {
  Attribute,
  Component,
  SnippetBlock,
  Comment,
  Root,
  SvelteNode,
} from 'svelte/compiler';
import type { Visitors } from 'zimmerframe';
import { logger } from '@storybook/client-logger';

import { type FragmentMeta, type StoryMeta } from '../types.js';
import type { SvelteASTNodes } from '../extract-ast-nodes.js';

/**
 * NOTE: Fragment is the 'html' code - not the one innside `<script>` nor `<style>`
 */
export async function walkOnFragment({
  fragment,
  source,
  nodes,
}: {
  fragment: Root['fragment'];
  source: string;
  nodes: SvelteASTNodes;
}): Promise<FragmentMeta> {
  const { walk } = await import('zimmerframe');

  const state: FragmentMeta = {
    stories: {},
  };
  let latestComment: Comment | undefined;

  const storiesIds = new Set<string>(Object.keys(state.stories));
  const storiesNames = new Set<string>();
  const visitors: Visitors<SvelteNode, typeof state> = {
    Comment(node, { next }) {
      latestComment = node;
      next();
    },

    Component(node, { state }) {
      if (node.name === nodes.storyIdentifier.name) {
        const { attributes } = node;
        const name = getStoryName({ attributes, storiesNames });
        const sourceAttribute = getSourceAttribute(attributes);
        const childrenRawSource = getChildrenRawSource({
          node,
          rawSource: source,
        });
        const id = getStoryId({ attributes, name, storiesIds: storiesIds });
        const description =
          latestComment && latestComment.end === node.start - 1
            ? dedent`${latestComment?.data}`
            : undefined;

        const meta: StoryMeta = {
          id,
          name,
          description,
          source: sourceAttribute,
          rawSource: childrenRawSource,
        };

        state.stories[name] = meta;
      }

      latestComment = undefined;
    },
  };

  walk(fragment, state, visitors);

  return state;
}

function getSourceAttribute(attributes: Component['attributes']) {
  const name = 'source';
  let value: boolean | string | undefined;

  try {
    value = getBooleanFromAttribute(name, attributes);
  } catch {
    value = getStringFromAttribute(name, attributes);
  }

  return value;
}

export function getStoryName({
  attributes,
  storiesNames,
}: {
  attributes: Component['attributes'];
  storiesNames: Set<string>;
}) {
  let name = getStringFromAttribute('name', attributes);

  if (!name) {
    throw new Error(`Missing prop 'name' in <Story> component.`);
  }

  if (storiesNames.has(name)) {
    throw new Error(`Story name - ${name} - conflicts with another story.`);
  }

  return name;
}

export function getStoryId({
  attributes,
  name,
  storiesIds,
}: {
  attributes: Component['attributes'];
  name: string;
  storiesIds: Set<string>;
}) {
  const id = getStringFromAttribute('id', attributes);

  if (id) {
    return id;
  }

  let generated = name.replace(/\W+(.|$)/g, (_, chr) => chr.toUpperCase());

  if (storiesIds.has(generated)) {
    logger.warn(`Story name conflict with exports - Please add an explicit id for story ${name}`);
    generated += hashCode(name);
  }

  return generated;
}

function hashCode(str: string) {
  const h = str.split('').reduce((prev, curr) => ((prev << 5) - prev + curr.charCodeAt(0)) | 0, 0);

  return Math.abs(h).toString(16);
}

export function getBooleanFromAttribute(name: string, attributes: Component['attributes']) {
  const attribute = lookupAttribute(name, attributes);

  if (!attribute) {
    return;
  }

  const { value } = attribute;

  if (value === true) {
    return value;
  }

  if (
    value.length === 1 &&
    value[0].type === 'ExpressionTag' &&
    value[0].expression.type === 'Literal' &&
    typeof value[0].expression.value === 'boolean'
  ) {
    return value[0].expression.value;
  }

  throw new Error(`Attribute "${name}" is not a static boolean`);
}

export function getStringFromAttribute(name: string, attributes: Component['attributes']) {
  const attribute = lookupAttribute(name, attributes);

  if (!attribute) {
    return;
  }

  const { value } = attribute;

  if (value === true) {
    throw new Error(`Attribute '${name}' is not a string`);
  }

  if (value.length === 1 && value[0].type === 'Text') {
    return value[0].data;
  }

  throw new Error(`Attribute "${name}" is not a static string`);
}

export function lookupAttribute(name: string, attributes: Component['attributes']) {
  return attributes.find((node) => {
    if (node.type === 'Attribute' && node.name === name) {
      return node.value;
    }
  }) as Attribute | undefined;
}

export function getChildrenRawSource({ node, rawSource }: { node: Component; rawSource: string }) {
  const { fragment } = node;
  const { nodes } = fragment;

  // Ignore addon components without children
  if (nodes.length === 0) {
    return;
  }

  const snippetBlockChildren = nodes.find(
    (c) => c.type === 'SnippetBlock' && c.expression.name === 'children'
  ) as SnippetBlock | undefined;

  if (snippetBlockChildren) {
    const { body } = snippetBlockChildren;
    const { nodes } = body;
    const { start } = nodes[0];
    const { end } = nodes[nodes.length - 1];

    return dedent`${rawSource.slice(start, end)}`;
  }

  const { start } = nodes[0];
  const { end } = nodes[nodes.length - 1];

  return dedent`${rawSource.slice(start, end)}`;
}
