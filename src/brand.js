// The product this fork presents itself as. Everything user-visible that has to move
// together on a rename reads it from here.
export const PRODUCT_NAME = "Liesel";
export const CLI_NAME = "liesel";
export const STATE_DIR_NAME = ".liesel";
export const BOARD_FILE_NAME = "board.json";
export const ENV_PREFIX = "LIESEL_";
// Where Liesel installs from. Liesel is not published on npm, so nothing may ever
// install or run `liesel` from the npm registry.
export const INSTALL_SOURCE = "github:GeorgeGally/liesel";

// Compatibility for one release, so a supervisor still driving Liesel through the names
// it had before the rename keeps working. Remove all of these in the next release.
// - LEGACY_ENV_PREFIXES: older settings are read as silent fallbacks (see adoptLegacyEnv),
//   newest name first.
// - LEGACY_STATE_DIR_NAME: an existing state directory is kept until the new one exists
//   (see stateDir in paths.js).
// - package.json also installs the CLI as `easel`.
// - SERVER_APP_ID: the identity /health reports and the CLI expects from its own server.
// - POLL_INTERRUPTED_MESSAGE: matched verbatim by a retrying poll wrapper.
export const LEGACY_ENV_PREFIXES = Object.freeze(["EASEL_", "LAVISH_AXI_"]);
export const LEGACY_STATE_DIR_NAME = ".easel";
export const SERVER_APP_ID = "lavish-axi";
export const POLL_INTERRUPTED_MESSAGE = "Lavish Editor poll response was interrupted";

/**
 * Copy each legacy-prefixed setting to its LIESEL_ name when that name is unset, so every
 * reader, and every child process, sees one prefix. Never overrides a LIESEL_ value, and a
 * newer legacy prefix wins over an older one.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function adoptLegacyEnv(env = process.env) {
  for (const prefix of LEGACY_ENV_PREFIXES) {
    for (const [key, value] of Object.entries(env)) {
      if (!key.startsWith(prefix) || value === undefined || value === "") continue;
      const own = `${ENV_PREFIX}${key.slice(prefix.length)}`;
      if (env[own] === undefined || env[own] === "") env[own] = value;
    }
  }
  return env;
}

/**
 * Read a Liesel setting.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
export function productEnv(name, env = process.env) {
  const value = env[`${ENV_PREFIX}${name}`];
  return value === "" ? undefined : value;
}
