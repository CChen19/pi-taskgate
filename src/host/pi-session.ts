/**
 * Read-only access to a Pi session file (JSONL) written by the child's own Pi
 * process. Used to check what a reviewer was actually told and read: every
 * prompt the main agent sends a running subagent lands there as a user
 * message, and every `read` call is stored with the text it returned.
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const MAX_SESSION_BYTES = 64 * 1024 * 1024;

export interface SessionReadCall {
  /** Path argument exactly as the model passed it. */
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
  /** Text the tool returned (including any continuation notice). */
  readonly text: string;
  readonly isError: boolean;
}

export interface SubagentSession {
  /** Text of every user message, in file order. */
  readonly userMessages: readonly string[];
  /** Every `read` tool call that has a result, in file order. */
  readonly reads: readonly SessionReadCall[];
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('');
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Parse a subagent's session file. Throws when the file cannot be read. */
export function readSubagentSession(path: string): SubagentSession {
  if (!isAbsolute(path) || !path.endsWith('.jsonl')) throw new Error(`${path} is not an absolute Pi session .jsonl path`);
  if (statSync(path).size > MAX_SESSION_BYTES) throw new Error(`${path} is larger than ${MAX_SESSION_BYTES} bytes`);
  const userMessages: string[] = [];
  const reads: SessionReadCall[] = [];
  const pending = new Map<string, { path: string; offset?: number; limit?: number }>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    const record = entry as { type?: unknown; message?: { role?: unknown; content?: unknown; toolCallId?: unknown; toolName?: unknown; isError?: unknown } } | null;
    if (record?.type !== 'message' || record.message === undefined) continue;
    const message = record.message;
    if (message.role === 'user') userMessages.push(contentText(message.content));
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content as unknown[]) {
        const call = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: { path?: unknown; offset?: unknown; limit?: unknown } } | null;
        if (call?.type !== 'toolCall' || call.name !== 'read' || typeof call.id !== 'string' || typeof call.arguments?.path !== 'string') continue;
        const offset = positive(call.arguments.offset);
        const limit = positive(call.arguments.limit);
        pending.set(call.id, { path: call.arguments.path, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) });
      }
    }
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const call = pending.get(message.toolCallId);
      if (call === undefined) continue;
      pending.delete(message.toolCallId);
      reads.push({ ...call, text: contentText(message.content), isError: message.isError === true });
    }
  }
  return { userMessages, reads };
}
