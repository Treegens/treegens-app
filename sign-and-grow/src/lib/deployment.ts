// DEPLOYMENT_PROFILE: what kind of installation this server is. Unset is the ordinary one. "government" is for a
// public body that runs its own copy:
//   - the signing record never carries the box "Signed without paper" (trees and paper), whatever an account chose;
//   - an account that has not chosen starts with the tree lines on screens and in emails off, and with AI answers in
//     the help chat off;
//   - the help chat never sends a question to OpenRouter or Moonshot AI. A model answers only when the operator set
//     SUPPORT_CHAT_API_KEY together with SUPPORT_CHAT_BASE_URL, the address of a model of their own choosing. The
//     server cannot check where that address leads; whoever sets it answers for that.
// What it does NOT do: it certifies nothing and claims nothing (src/lib/claims.ts). It is a set of defaults.
//
// Reads the environment: server code and server components only.

type Env = Record<string, string | undefined>;

export type DeploymentProfile = 'government' | null;

const raw = (env: Env) => String(env.DEPLOYMENT_PROFILE || '').trim().toLowerCase();

export const deploymentProfile = (env: Env = process.env): DeploymentProfile => (raw(env) === 'government' ? 'government' : null);

export const isGovernment = (env: Env = process.env): boolean => deploymentProfile(env) === 'government';

/** A value that is set but is not one we know. The server says so when it starts, and runs as the ordinary profile. */
export function deploymentProfileWarning(env: Env = process.env): string | null {
  const v = raw(env);
  if (!v || v === 'government') return null;
  return `DEPLOYMENT_PROFILE is set to "${v.slice(0, 40)}", which is not a profile this server knows. The only one is "government". The server is running with the ordinary defaults: trees on the signing record, and a hosted AI service allowed for the help chat. Correct the spelling or remove the setting.`;
}
