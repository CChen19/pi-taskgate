import type { HerdrSpawnRequest, HerdrSubagentPort } from '../adapters/pi-herdr-executor.ts';

export interface StructuredAgentRunnerOptions {
  readonly herdr: HerdrSubagentPort;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly clock: () => number;
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
}

export interface StructuredAgentResult {
  readonly sessionId: string;
  readonly assistantText: string;
}

/** Thin lifecycle helper. It never treats an idle pane as an accepted result. */
export class StructuredAgentRunner {
  private readonly options: StructuredAgentRunnerOptions;
  private readonly active = new Map<string, string>();
  constructor(options: StructuredAgentRunnerOptions) {
    if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0) throw new TypeError('pollIntervalMs must be positive');
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
    this.options = options;
  }

  async run(request: HerdrSpawnRequest): Promise<StructuredAgentResult> {
    const spawned = this.options.herdr.spawn(request) as unknown;
    if (!isObject(spawned) || typeof spawned.sessionId !== 'string' || spawned.sessionId.length === 0) throw new Error('structured agent spawn returned no sessionId');
    const sessionId = spawned.sessionId;
    this.active.set(sessionId, 'structured agent cancelled');
    const started = this.options.clock();
    try {
      for (;;) {
        const status = this.options.herdr.poll(sessionId) as unknown;
        if (!isObject(status) || typeof status.status !== 'string') throw new Error('structured agent poll returned malformed status');
        if (status.status === 'settled') {
          const reader = this.options.herdr.readFinalAssistant;
          if (reader === undefined) throw new Error('HerdrCliPort does not provide readFinalAssistant');
          const assistantText = reader.call(this.options.herdr, sessionId);
          if (typeof assistantText !== 'string' || assistantText.length === 0) throw new Error('structured agent returned an empty assistant result');
          return Object.freeze({ sessionId, assistantText });
        }
        if (status.status === 'lost' || status.status === 'failed' || status.status === 'cancelled') throw new Error(`structured agent ended with ${status.status}`);
        const elapsed = this.options.clock() - started;
        if (!Number.isFinite(elapsed) || elapsed >= this.options.timeoutMs) throw new Error('structured agent timed out');
        await this.options.sleep(this.options.pollIntervalMs);
      }
    } finally {
      this.active.delete(sessionId);
      try { this.options.herdr.close(sessionId); } catch { /* preserve the primary lifecycle error */ }
    }
  }

  /** Interrupt all sessions owned by this runner; run() finally closes them. */
  cancel(reason = 'structured agent cancelled'): void {
    for (const sessionId of this.active.keys()) {
      try { this.options.herdr.interrupt(sessionId, reason); } catch { /* run() still closes the session */ }
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
