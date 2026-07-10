/**
 * settings — the centralized store + probe for the four user-supplied API keys.
 * tools is the only layer that may hold a secret or call a provider, so both the
 * at-rest store and the "test before save" probe live here; routes delegate down.
 */

export {
  loadSecretsIntoEnv,
  loadDotEnvKeys,
  getKeyPresence,
  setKey,
  clearKey,
  UnknownSecretKeyError,
  SECRET_KEY_IDS,
  type SecretKeyId,
  type KeyPresence,
  type KeyPresenceMap,
} from "./secretsStore.js";

export {
  testKey,
  __setSecretsProbeForTests,
  __resetSecretsProbeForTests,
  type KeyProbeResult,
  type SecretsProbeDeps,
} from "./keyProbe.js";

export {
  getEnvConfig,
  setEnvConfig,
  loadEnvConfigIntoEnv,
  ENV_DESCRIPTORS,
  EDITABLE_IDS,
  UnknownEnvVarError,
  NonEditableEnvVarError,
  InvalidEnvValueError,
  type EnvVarId,
  type EnvVarClass,
  type EnvVarDescriptor,
  type EnvVarState,
} from "./envConfigStore.js";
