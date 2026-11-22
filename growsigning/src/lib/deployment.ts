// DEPLOYMENT_PROFILE: what kind of installation this server is. Unset is the ordinary one. "government" is for a
// public body that runs its own copy. It changes two things, both from the owner's answers of 2026-11-20
// (research/government.json, owner_answers):
//   - the signing record never carries the box "Signed without paper" (trees and paper), whatever an account chose;
//   - the help chat never sends a question to OpenRouter or Moonshot AI. A model answers only once the operator set
//     SUPPORT_CHAT_API_KEY together with SUPPORT_CHAT_BASE_URL, the address of a model they run themselves. The
//     server cannot check where that address leads; whoever sets it answers for that.
// It changes nothing on the screens (research/ux-charter.md, P8): the switches 'Trees on screens and emails' and
// 'AI answers in the help chat' start on, as everywhere, and an admin can switch either off (src/server/tenantpolicy.ts).
// What it does NOT do: it certifies nothing and claims nothing (src/lib/claims.ts).
//
// Reads the environment: server code and server components only.

type Env = Record<string, string | undefined>;

export type DeploymentProfile = 'government' | null;

const raw = (env: Env) => String(env.DEPLOYMENT_PROFILE || '').trim().toLowerCase();

export const deploymentProfile = (env: Env = process.env): DeploymentProfile => (raw(env) === 'government' ? 'government' : null);

export const isGovernment = (env: Env = process.env): boolean => deploymentProfile(env) === 'government';

/**
 * A government server with a hosted AI service in its settings: the chat does not use it, and the operator hears why
 * when the server starts instead of looking for a fault. `hosted` is the setting that holds that key and `modelOn`
 * whether a model answers all the same (chatProvider and chatModelOn in src/lib/chatprovider.ts).
 */
export function governmentChatWarning(hosted: string | null, modelOn: boolean, env: Env = process.env): string | null {
  if (!isGovernment(env) || !hosted || modelOn) return null;
  return `DEPLOYMENT_PROFILE=government: the help chat does not use the AI service set in ${hosted.slice(0, 40)}, because a server set up for a public body never sends what people type to a hosted service. It answers from the built-in help. To have a model answer, set SUPPORT_CHAT_API_KEY together with SUPPORT_CHAT_BASE_URL, the address of a model you run yourself.`;
}

/** A value that is set but is not one we know. The server says so when it starts, and runs as the ordinary profile. */
export function deploymentProfileWarning(env: Env = process.env): string | null {
  const v = raw(env);
  if (!v || v === 'government') return null;
  return `DEPLOYMENT_PROFILE is set to "${v.slice(0, 40)}", which is not a profile this server knows. The only one is "government". The server is running with the ordinary defaults: trees on the signing record, and a hosted AI service allowed for the help chat. Correct the spelling or remove the setting.`;
}
