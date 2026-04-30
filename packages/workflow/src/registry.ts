/// Plugin registry — flattens IntegrationPlugin[] into a Map of MCP tools.
///
/// Tool naming: `{plugin.name}.{action.slug}` (e.g.
/// `0g-tee-inference.run-inference`). MCP tool names allow dots and dashes.
///
/// JSON schema generation: configFields[] is converted directly (no zod
/// dependency). The structural shape is small enough to map cheaply.

import type { Action, ConfigField, IntegrationPlugin } from './plugin-types.js';

export interface RegisteredTool {
  pluginName: string;
  action: Action;
}

export type PluginRegistry = Map<string, RegisteredTool>;

export function buildRegistry(plugins: IntegrationPlugin[]): PluginRegistry {
  const registry: PluginRegistry = new Map();
  for (const plugin of plugins) {
    for (const action of plugin.actions) {
      registry.set(`${plugin.name}.${action.slug}`, { pluginName: plugin.name, action });
    }
  }
  return registry;
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaField>;
  required: string[];
}

export interface JsonSchemaField {
  type: 'string' | 'number' | 'boolean';
  description?: string;
  default?: string | number | boolean;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export function listTools(registry: PluginRegistry): ToolDescriptor[] {
  const tools: ToolDescriptor[] = [];
  for (const [name, entry] of registry.entries()) {
    tools.push({
      name,
      description: `${entry.action.label} — ${entry.action.description}`,
      inputSchema: configFieldsToJsonSchema(entry.action.configFields),
    });
  }
  return tools;
}

function configFieldsToJsonSchema(fields: ConfigField[]): JsonSchema {
  const properties: Record<string, JsonSchemaField> = {};
  const required: string[] = [];
  for (const field of fields) {
    const jsType = mapFieldType(field.type);
    const prop: JsonSchemaField = { type: jsType };
    if (field.helpText) prop.description = field.helpText;
    if (field.default !== undefined) {
      prop.default = field.default as JsonSchemaField['default'];
    }
    properties[field.key] = prop;
    if (field.required) required.push(field.key);
  }
  return { type: 'object', properties, required };
}

function mapFieldType(t: ConfigField['type']): JsonSchemaField['type'] {
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  // 'secret' and 'string' both map to JSON-schema string.
  return 'string';
}

export async function callTool(
  registry: PluginRegistry,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const entry = registry.get(name);
  if (!entry) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return await entry.action.stepFunction(args);
}
