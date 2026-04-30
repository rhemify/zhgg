/// Credential schema for the 0g-tee-inference plugin.
///
/// KeeperHub passes the user's stored credentials into each step via
/// `input._context`. We declare the required fields here so the
/// hosted credential UI knows what to render.

export interface CredentialField {
  key: string;
  label: string;
  type: 'string' | 'secret';
  default?: string;
  required?: boolean;
}

export interface CredentialSchema {
  type: 'credentials';
  name: string;
  fields: CredentialField[];
}

export const credentials: CredentialSchema = {
  type: 'credentials',
  name: '0g-router',
  fields: [
    {
      key: 'apiKey',
      label: '0G Compute Router API key (sk-...)',
      type: 'secret',
      required: true,
    },
    {
      key: 'baseUrl',
      label: '0G Compute Router base URL',
      type: 'string',
      default: 'https://router-api.0g.ai/v1',
    },
  ],
};
