/**
 * Human text for the hub's "status" frames. The backend sends one (instead of an aircraft snapshot)
 * when the viewer is in away mode and no away-mode source can answer; the reason is
 * `<source>-unconfigured`, `<source>-budget-exhausted`, `<source>-upstream-error`, or
 * `away-mode-unconfigured` when no source is configured at all (see AwayModeChain).
 */

export function feedStatusMessage(reason: string): string {
  if (reason.endsWith("-budget-exhausted"))
    return "You're outside the home receiver's range, and the away-mode aircraft source has reached its usage limit. It resets automatically.";
  if (reason.endsWith("-upstream-error"))
    return "You're outside the home receiver's range, and the away-mode aircraft source isn't responding. Retrying automatically.";
  if (reason.endsWith("-unconfigured"))
    return "You're outside the home receiver's range, and no away-mode aircraft source is configured.";
  return `No aircraft available right now (${reason}).`;
}
