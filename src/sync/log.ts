/**
 * Uses the loglevel dependency already present in astral-trek instead of
 * upstream's identical loglevel-based module.
 */

import log from "loglevel";

export const syncLog = log.getLogger("astral-trek-sync");

/** Toggle verbose sync logging (wired to the plugin's debug switch). */
export const setSyncDebugEnabled = (enabled: boolean): void => {
  syncLog.setLevel(enabled ? "debug" : "warn");
};

setSyncDebugEnabled(false);
