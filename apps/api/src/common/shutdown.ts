// Adapted from the reference project's backend/src/lib/shutdown.ts (MIT, see
// THIRD_PARTY_NOTICES.md). Change from the original: the timeout is a parameter so the behaviour
// can be tested with real timers instead of a fake-timer library.

/** Upper bound for graceful shutdown before the process is forced to exit. */
export const FORCE_EXIT_TIMEOUT_MS = 50_000;

/**
 * Schedules a forced exit as a safety net for graceful shutdown. The timer is unref'ed so it never
 * keeps the process alive on its own; callers `clearTimeout` it once shutdown completes.
 */
export function scheduleForceExit(
  exit: () => void = () => process.exit(1),
  timeoutMs: number = FORCE_EXIT_TIMEOUT_MS,
): NodeJS.Timeout {
  const timer = setTimeout(exit, timeoutMs);
  timer.unref();
  return timer;
}

export interface ShutdownHandlerOptions {
  /** Closes the app: stops accepting connections, runs shutdown hooks, closes pools. */
  close: () => Promise<void>;
  log: (message: string, fields?: Record<string, unknown>) => void;
  /** Called with 1 when shutdown failed or overran its deadline. Defaults to process.exit. */
  exit?: (code: number) => void;
  /** Called with 0 when shutdown completed; the process then ends on its own once nothing keeps it alive. */
  setExitCode?: (code: number) => void;
  timeoutMs?: number;
}

/**
 * Builds the signal handler used for SIGINT/SIGTERM, following the contract of scheduleForceExit:
 *  - the force-exit timer starts when shutdown starts
 *  - it is cleared as soon as shutdown completes (success or failure), so it can never fire afterwards
 *  - a repeated signal while shutting down is ignored (it must not start a second shutdown or timer)
 *  - if close() hangs, the timer exits the process with code 1 after `timeoutMs`
 */
export function createShutdownHandler(options: ShutdownHandlerOptions): (signal: string) => Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const setExitCode = options.setExitCode ?? ((code: number) => void (process.exitCode = code));
  let started = false;

  return async (signal: string): Promise<void> => {
    if (started) {
      options.log("shutdown already in progress; ignoring repeated signal", { signal });
      return;
    }
    started = true;
    options.log("shutting down", { signal });

    const timer = scheduleForceExit(() => {
      options.log("graceful shutdown timed out; forcing exit");
      exit(1);
    }, options.timeoutMs ?? FORCE_EXIT_TIMEOUT_MS);

    try {
      await options.close();
      clearTimeout(timer);
      options.log("shutdown complete");
      setExitCode(0);
    } catch (error) {
      clearTimeout(timer);
      options.log("shutdown failed", { error: error instanceof Error ? error.message : String(error) });
      exit(1);
    }
  };
}
