/**
 * Read-only access to a Pi session file (JSONL) written by the child's own Pi
 * process. Used to check what a reviewer was actually told: every prompt the
 * main agent sends a running subagent lands there as a user message.
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const MAX_SESSION_BYTES = 64 * 1024 * 1024;

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('');
}

/** Text of every user message in the session file, in file order. Throws when the file cannot be read. */
export function readSessionUserMessages(path: string): readonly string[] {
  if (!isAbsolute(path) || !path.endsWith('.jsonl')) throw new Error(`${path} is not an absolute Pi session .jsonl path`);
  if (statSync(path).size > MAX_SESSION_BYTES) throw new Error(`${path} is larger than ${MAX_SESSION_BYTES} bytes`);
  const messages: string[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    const record = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } } | null;
    if (record?.type === 'message' && record.message?.role === 'user') messages.push(contentText(record.message.content));
  }
  return messages;
}
