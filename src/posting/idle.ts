type IdleSettle = (env: Env, now: number) => Promise<void>;

let idleSettle: IdleSettle | null = null;

export function registerIdleSettle(fn: IdleSettle): void {
  idleSettle = fn;
}

// Runs the account-switch exit for rows that are not in the middle of a send.
// dispatch.ts registers the implementation next to settle so this file does
// not import the dispatcher.
export async function settleIdleAccountSwitches(
  env: Env,
  now: number,
): Promise<void> {
  if (!idleSettle) return;
  await idleSettle(env, now);
}
