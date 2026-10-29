// The product this fork presents itself as. Everything user-visible that has to move
// together on a rename reads it from here, so `upstream` can still be merged without
// resolving the same string in forty places.
export const PRODUCT_NAME = "Easel";
export const CLI_NAME = "easel";
export const LEGACY_CLI_NAME = "lavish-axi";
export const STATE_DIR_NAME = ".easel";
export const BOARD_FILE_NAME = "board.json";

/**
 * Read a setting under this fork's prefix, falling back to the upstream one so an
 * existing environment (and the upstream test suite) keeps working unchanged.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
export function productEnv(name, env = process.env) {
  const own = env[`EASEL_${name}`];
  if (own !== undefined && own !== "") return own;
  return env[`LAVISH_AXI_${name}`];
}
