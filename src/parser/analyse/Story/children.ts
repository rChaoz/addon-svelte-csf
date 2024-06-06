import type { Component, SnippetBlock } from 'svelte/compiler';

import type { extractSvelteASTNodes } from '../../extract/svelte/nodes.js';
import { extractStoryAttributesNodes } from '../../extract/svelte/Story/attributes.js';
import { extractStoryChildrenSnippetBlock } from '../../extract/svelte/Story/children.js';
import { extractMetaPropertiesNodes } from '../../extract/meta-properties.js';

interface Params {
  component: Component;
  svelteASTNodes: Awaited<ReturnType<typeof extractSvelteASTNodes>>;
  originalCode: string;
  filename?: string;
}

/**
 * Determine the `source.code` of the `<Story />` component children.
 * Reference: Step 2 from the comment: https://github.com/storybookjs/addon-svelte-csf/pull/181#issuecomment-2143539873
 */
export function getStoryChildrenRawSource(params: Params): string {
  const { component, svelteASTNodes, originalCode, filename } = params;

  // `<Story />` component is self-closing...
  if (component.fragment.nodes.length === 0) {
    /**
     * Case - "explicit template" - `children` attribute references to a snippet block at the root level of fragment.
     *
     * Example:
     *
     * ```svelte
     * {#snippet template1(args)}
     *     <SomeComponent {...args} />
     * {/snippet}
     *
     * <Story name="Default" children={template1} />
     * ```
     */
    const storyAttributeChildrenSnippetBlock = findChildrenPropSnippetBlock(component, {
      svelteASTNodes,
      filename,
    });

    if (storyAttributeChildrenSnippetBlock) {
      return getSnippetBlockBodyRawCode(originalCode, storyAttributeChildrenSnippetBlock);
    }

    /**
     * Case - `setTemplate was used in the instance tag of `*.stories.svelte` file
     *
     * Example:
     *
     * ```svelte
     * <script>
     *     setTemplate(myCustomTemplate);
     * </script>
     *
     * {#snippet myCustomTemplate(args)}
     *     <SomeComponent {...args} />
     * {/snippet}
     *
     * <Story name="Default" />
     * ```
     */
    const setTemplateSnippetBlock = findSetTemplateSnippetBlock(svelteASTNodes);

    if (setTemplateSnippetBlock) {
      return getSnippetBlockBodyRawCode(originalCode, setTemplateSnippetBlock);
    }

    /* Case - No `children` attribute provided, no `setTemplate` used, just a Story */
    // TODO: How do we fill ComponentName? Extract from defineMeta? - it can be optional
    return `<${getDefineMetaComponentName(svelteASTNodes)} {...args} />`;
  }

  /**
   * Case - Story with children - and with a snippet block `children` inside
   *
   * Example:
   *
   * ```svelte
   * <Story name="Default">
   *     {#snippet children(args)}
   *          <SomeComponent {...args} />
   *     {/snippet}
   * </Story>
   * ```
   */
  const storyChildrenSnippetBlock = extractStoryChildrenSnippetBlock(component);

  if (storyChildrenSnippetBlock) {
    return getSnippetBlockBodyRawCode(originalCode, storyChildrenSnippetBlock);
  }

  /**
   * Case - No inner `children`, just Story with a static content
   *
   * Example:
   *
   * ```svelte
   * <Story name="Default">
   *     <SomeComponent foo="bar" />
   * </Story>
   * ```
   */
  const { fragment } = component;
  const { nodes } = fragment;
  const firstNode = nodes[0];
  const lastNode = nodes[nodes.length - 1];
  const rawCode = originalCode.slice(firstNode.start, lastNode.end);

  return sanitizeCodeSlice(rawCode);
}

function findTemplateSnippetBlock(
  name: string,
  svelteASTNodes: Params['svelteASTNodes']
): SnippetBlock | undefined {
  const { snippetBlocks } = svelteASTNodes;

  return snippetBlocks.find((snippetBlock) => name === snippetBlock.expression.name);
}

function findSetTemplateSnippetBlock(
  svelteASTNodes: Params['svelteASTNodes']
): SnippetBlock | undefined {
  const { setTemplateCall } = svelteASTNodes;

  if (!setTemplateCall) {
    return;
  }

  if (setTemplateCall.arguments[0].type !== 'Identifier') {
    throw new Error(
      `Invalid schema - expected 'setTemplate' first argument to be an identifier. Stories file: ${filename}`
    );
  }

  return findTemplateSnippetBlock(setTemplateCall.arguments[0].name, svelteASTNodes);
}

function findChildrenPropSnippetBlock(
  component: Component,
  options: Pick<Params, 'svelteASTNodes' | 'filename'>
) {
  const { svelteASTNodes, filename } = options;
  const { children } = extractStoryAttributesNodes({
    component,
    attributes: ['children'],
  });

  if (!children) {
    return;
  }

  const { value } = children;

  if (value === true || value[0].type === 'Text' || value[0].expression.type !== 'Identifier') {
    throw new Error(
      `Invalid schema. Expected '<Story />'s attribute 'children' to be an expression with identifier to snippet block. Stories file: ${filename}`
    );
  }

  return findTemplateSnippetBlock(value[0].expression.name, svelteASTNodes);
}

/**
 * Extract from the original code a string slice with the body of the svelte's snippet block.
 * Starting from the start of the first node, and ending with the end of the last node.
 *
 * For example, from the following case:
 *
 * ```svelte
 * {#snippet children(args)}
 *   <!-- Some comment... -->
 *   "Static text"
 *   <Component {...args } />
 * {/snippet}
 * ```
 *
 * The result would be:
 *
 * ```txt
 * <!-- Some comment... -->
 * "Static text"
 * <Component {...args } />
 * ```
 */
function getSnippetBlockBodyRawCode(originalCode: string, node: SnippetBlock) {
  const { body } = node;
  const { nodes } = body;
  const firstNode = nodes[0];
  const lastNode = nodes[nodes.length - 1];
  const rawCode = originalCode.slice(firstNode.start, lastNode.end);

  return sanitizeCodeSlice(rawCode);
}

/**
 * WARN: The current solution was written very quickly. Expect bugs.
 * TODO:
 * Need to figure a safer way to remove unwanted leading and ending tabs, spaces, new lines and so on.
 */
function sanitizeCodeSlice(rawCode: string): string {
  return rawCode.replace(/(\n)/g, '').trim();
}

function getDefineMetaComponentName(svelteASTNodes: Params['svelteASTNodes']) {
  const { component } = extractMetaPropertiesNodes({
    nodes: svelteASTNodes,
    properties: ['component'],
  });

  if (!component) {
    return '!unspecified';
  }

  const { value } = component;

  if (value.type !== 'Identifier') {
    throw new Error(`Invalid schema`);
  }

  return value.name;
}
