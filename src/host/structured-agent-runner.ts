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

/** Deterministic cap for a transport-supplied terminal outcome echoed into an error. */
const MAX_TRANSPORT_OUTCOME = 160;
/**
 * Neutralize characters that would create extra lines or allow bidi spoofing in
 * an error message: C0/C1 controls (including NEL U+0085), Unicode line/paragraph
 * separators, zero-width and bidi marks (ALM U+061C, LRM/RLM U+200E/U+200F,
 * ZWSP/ZWNJ/ZWJ U+200B-U+200D), the bidi embedding/override block U+202A-U+202E,
 * the isolate block U+2066-U+2069, and the zero-width no-break space U+FEFF.
 */
const UNSAFE_TRANSPORT_OUTCOME = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]+/g;

/** Sanitize (single-line, unspoofed) and bound a port-supplied outcome before it enters an error message. */
function boundedOutcome(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = value.replace(UNSAFE_TRANSPORT_OUTCOME, ' ').trim();
  if (sanitized.length === 0) return undefined;
  if (sanitized.length <= MAX_TRANSPORT_OUTCOME) return sanitized;
  let end = MAX_TRANSPORT_OUTCOME - 12;
  // Do not cut a surrogate pair: a trailing lone high surrogate is invalid text.
  const last = sanitized.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${sanitized.slice(0, end)}…[truncated]`;
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
        if (status.status === 'lost' || status.status === 'failed' || status.status === 'cancelled') {
          // Keep the transport's terminal outcome so journals reveal the specific
          // failure (for example, an exhausted boundary readiness budget), but
          // sanitize and cap it here: the generic port contract does not promise
          // a bounded outcome even though HerdrCliPort happens to bound its own.
          const detail = boundedOutcome(status.outcome);
          throw new Error(`structured agent ended with ${status.status}${detail === undefined ? '' : `: ${detail}`}`);
        }
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
