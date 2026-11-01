// The product this fork presents itself as. Everything user-visible that has to move
// together on a rename reads it from here.
export const PRODUCT_NAME = "Easel";
export const CLI_NAME = "easel";
export const STATE_DIR_NAME = ".easel";
export const BOARD_FILE_NAME = "board.json";
export const ENV_PREFIX = "EASEL_";
// Where Easel installs from. The npm name `easel` belongs to an unrelated package, so
// nothing may ever install or run `easel` from the npm registry.
export const INSTALL_SOURCE = "github:GeorgeGally/lavish-axi";

// Compatibility for one release, so a supervisor still driving Easel through the names
// it had before the rename keeps working. Remove all three in the next release.
// - LEGACY_ENV_PREFIX: older settings are read as silent fallbacks (see adoptLegacyEnv).
// - SERVER_APP_ID: the identity /health reports and the CLI expects from its own server.
// - POLL_INTERRUPTED_MESSAGE: matched verbatim by a retrying poll wrapper.
export const LEGACY_ENV_PREFIX = "LAVISH_AXI_";
export const SERVER_APP_ID = "lavish-axi";
export const POLL_INTERRUPTED_MESSAGE = "Lavish Editor poll response was interrupted";

/**
 * Copy each legacy-prefixed setting to its EASEL_ name when that name is unset, so every
 * reader, and every child process, sees one prefix. Never overrides an EASEL_ value.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function adoptLegacyEnv(env = process.env) {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX) || value === undefined || value === "") continue;
    const own = `${ENV_PREFIX}${key.slice(LEGACY_ENV_PREFIX.length)}`;
    if (env[own] === undefined || env[own] === "") env[own] = value;
  }
  return env;
}

/**
 * Read an Easel setting.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
export function productEnv(name, env = process.env) {
  const value = env[`${ENV_PREFIX}${name}`];
  return value === "" ? undefined : value;
}
