/**
 * Pure helpers for the status bar progress text.
 *
 * Kept free of obsidian/i18n imports so the layout rules (spacing + percentage
 * punctuation) can be unit-tested without a DOM. The localized
 * `sync.statusbar.progress` template supplies the separator (" · {pct}%"),
 * and this helper guarantees exactly one space between each part.
 */

export interface ProgressParts {
  done: number;
  total: number;
  pct: number;
}

/**
 * Parse "12/300" into parts with a clamped, rounded percentage.
 * Returns undefined when the message is not of the form "<n>/<n>" or total <= 0.
 */
export const parseProgressMessage = (
  message: string
): ProgressParts | undefined => {
  const parts = message.split("/").map(Number);
  if (parts.length !== 2) {
    return undefined;
  }
  const [done, total] = parts;
  if (
    done === undefined ||
    total === undefined ||
    !Number.isFinite(done) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return undefined;
  }
  return {
    done,
    total,
    pct: Math.min(100, Math.round((done / total) * 100)),
  };
};

/** 用单个普通空格拼接各段，忽略空段并剔除首尾空白（避免双空格） */
const joinWithSingleSpace = (...parts: string[]): string =>
  parts
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" ");

/**
 * Compose "<step> <n>/<n> · <pct>%".
 * `suffix` is already localized (both zh/en use " · {pct}%") and its leading
 * space is normalized away by the joiner. When the message is missing or not a
 * progress fraction, it is appended verbatim (or omitted) without the suffix.
 */
export const composeStatusBarProgress = (
  stepLabel: string,
  message: string | undefined,
  suffix: string
): string => {
  if (message === undefined || message.trim() === "") {
    return stepLabel;
  }
  if (parseProgressMessage(message) === undefined) {
    return joinWithSingleSpace(stepLabel, message);
  }
  return joinWithSingleSpace(stepLabel, message, suffix);
};
