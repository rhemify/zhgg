/// KeeperHub plugin shape, hoisted to the workflow package.
///
/// Lives outside any specific plugin folder so:
/// (1) the registry doesn't import upward into `plugins/*` (clean dep direction)
/// (2) every plugin imports the same canonical shape from one place
/// (3) when this folder is dropped into KeeperHub via `cp -r`, their own
///     plugin-type module substitutes via tsconfig path resolution
///
/// Structural typing means our shape only has to be a subset of KeeperHub's
/// real `IntegrationPlugin` for drop-in compatibility.

export interface ConfigField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'secret' | 'boolean';
  required?: boolean;
  default?: string | number | boolean;
  helpText?: string;
}

export interface OutputField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'object';
}

export interface Action {
  slug: string;
  label: string;
  description: string;
  category: string;
  stepFunction: ((input: unknown) => unknown) & { maxRetries?: number };
  stepImportPath: string;
  configFields: ConfigField[];
  outputFields: OutputField[];
}

export interface IntegrationPlugin {
  name: string;
  displayName: string;
  description: string;
  version: string;
  actions: Action[];
}
