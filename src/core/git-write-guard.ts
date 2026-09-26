/**
 * Finds git commands in a shell command string that write history, move
 * branches, or rewrite the working tree, and the directory each would run in.
 *
 * This is a policy guard for the main agent's `bash` tool, not a sandbox: it
 * understands quoting, command separators, `$(...)`/backticks, heredocs, `cd`,
 * `git -C`, and `sh -c`/`eval`, but anything it cannot follow (aliases,
 * scripts, other languages spawning git) is out of reach. A directory it
 * cannot resolve statically is reported as `undefined` so callers fail closed.
 * Pure: no I/O.
 */
import { posix } from 'node:path';

export interface GitWrite {
  /** The git invocation as parsed, e.g. `git commit -m x`. */
  readonly command: string;
  /** Absolute directory git would run in, or undefined when it cannot be resolved statically. */
  readonly directory: string | undefined;
}

type Token =
  | { readonly kind: 'word'; readonly value: string; readonly dynamic: boolean }
  | { readonly kind: 'op'; readonly value: string }
  | { readonly kind: 'redirect' };

interface Tokenized {
  readonly tokens: readonly Token[];
  /** Bodies of `$(...)` and backtick substitutions, scanned as scripts of their own. */
  readonly substitutions: readonly string[];
}

const MAX_DEPTH = 8;

/** Index just past the `)` that closes the group opened before `start`. Quotes are skipped. */
function closeParen(src: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const end = src.indexOf("'", i + 1); i = end < 0 ? src.length : end + 1; continue; }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')' && --depth === 0) return i + 1;
    i++;
  }
  return src.length;
}

function closeBacktick(src: string, start: number): number {
  let i = start;
  while (i < src.length && src[i] !== '`') i += src[i] === '\\' ? 2 : 1;
  return Math.min(i, src.length);
}

function tokenize(src: string): Tokenized {
  const tokens: Token[] = [];
  const substitutions: string[] = [];
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  let heredocNext: { stripTabs: boolean } | undefined;
  let word = '';
  let inWord = false;
  let dynamic = false;

  const endWord = (): void => {
    if (!inWord) return;
    if (heredocNext !== undefined) {
      heredocs.push({ delimiter: word, stripTabs: heredocNext.stripTabs });
      heredocNext = undefined;
    }
    tokens.push({ kind: 'word', value: word, dynamic });
    word = '';
    inWord = false;
    dynamic = false;
  };
  const substitute = (body: string): void => { substitutions.push(body); dynamic = true; inWord = true; };

  /** `$...` starting at src[i] === '$'; returns the next index. */
  const dollar = (i: number): number => {
    const next = src[i + 1];
    if (next === '(') {
      if (src[i + 2] === '(') { dynamic = true; inWord = true; return closeParen(src, i + 3); }
      const end = closeParen(src, i + 2);
      substitute(src.slice(i + 2, end - 1));
      return end;
    }
    if (next === '{') { const end = src.indexOf('}', i + 2); dynamic = true; inWord = true; return end < 0 ? src.length : end + 1; }
    if (next !== undefined && /[A-Za-z0-9_@*#?$!-]/.test(next)) {
      let j = i + 2;
      if (/[A-Za-z_]/.test(next)) while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      dynamic = true;
      inWord = true;
      return j;
    }
    word += '$';
    inWord = true;
    return i + 1;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t') { endWord(); i++; continue; }
    if (c === '\n') {
      endWord();
      tokens.push({ kind: 'op', value: '\n' });
      i++;
      for (const doc of heredocs.splice(0)) {
        while (i < src.length) {
          const eol = src.indexOf('\n', i);
          const line = src.slice(i, eol < 0 ? src.length : eol);
          i = eol < 0 ? src.length : eol + 1;
          if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break;
        }
      }
      continue;
    }
    if (c === '#' && !inWord) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 < src.length) { word += src[i + 1]; inWord = true; }
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      word += src.slice(i + 1, end < 0 ? src.length : end);
      inWord = true;
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === '"') {
      inWord = true;
      i++;
      while (i < src.length && src[i] !== '"') {
        const d = src[i]!;
        if (d === '\\' && i + 1 < src.length && '"\\$`\n'.includes(src[i + 1]!)) { if (src[i + 1] !== '\n') word += src[i + 1]; i += 2; continue; }
        if (d === '$') { i = dollar(i); continue; }
        if (d === '`') { const end = closeBacktick(src, i + 1); substitute(src.slice(i + 1, end)); i = end + 1; continue; }
        word += d;
        i++;
      }
      i++;
      continue;
    }
    if (c === '$') {
      if (src[i + 1] === "'") {
        // ANSI-C quoting; escapes are rare in paths and git subcommands, so keep the raw text.
        let j = i + 2;
        while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
        word += src.slice(i + 2, Math.min(j, src.length));
        inWord = true;
        i = j + 1;
        continue;
      }
      i = dollar(i);
      continue;
    }
    if (c === '`') { const end = closeBacktick(src, i + 1); substitute(src.slice(i + 1, end)); i = end + 1; continue; }
    if (c === '<' || c === '>') {
      if (/^\d+$/.test(word)) { word = ''; inWord = false; dynamic = false; } else endWord();
      if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
        const stripTabs = src[i + 2] === '-';
        heredocNext = { stripTabs };
        i += stripTabs ? 3 : 2;
      } else {
        i++;
        while (i < src.length && '<>|&'.includes(src[i]!)) i++;
      }
      tokens.push({ kind: 'redirect' });
      continue;
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      endWord();
      if (c === '&' && src[i + 1] === '>') { i += 2; if (src[i] === '>') i++; tokens.push({ kind: 'redirect' }); continue; }
      const two = src.slice(i, i + 2);
      const op = ['&&', '||', ';;', '|&'].includes(two) ? two : c;
      tokens.push({ kind: 'op', value: op });
      i += op.length;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endWord();
  return { tokens, substitutions };
}

/** Simple commands: word lists between operators, with redirections and their targets removed. */
function simpleCommands(tokens: readonly Token[]): { value: string; dynamic: boolean }[][] {
  const commands: { value: string; dynamic: boolean }[][] = [];
  let current: { value: string; dynamic: boolean }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === 'op') {
      if (current.length > 0) commands.push(current);
      current = [];
    } else if (token.kind === 'redirect') {
      if (tokens[i + 1]?.kind === 'word') i++;
    } else {
      current.push({ value: token.value, dynamic: token.dynamic });
    }
  }
  if (current.length > 0) commands.push(current);
  return commands;
}

function resolveDir(base: string | undefined, arg: { value: string; dynamic: boolean }, home: string | undefined): string | undefined {
  if (arg.dynamic) return undefined;
  let path = arg.value;
  if (path === '~' || path.startsWith('~/')) {
    if (home === undefined) return undefined;
    path = home + path.slice(1);
  } else if (path.startsWith('~')) {
    return undefined;
  }
  if (posix.isAbsolute(path)) return posix.normalize(path);
  return base === undefined ? undefined : posix.resolve(base, path);
}

const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'stdbuf', 'setsid']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--exec-path']);

/** Is `git <sub> <args>` a write this guard blocks? */
export function isGitWrite(sub: string, args: readonly string[]): boolean {
  const has = (...flags: string[]) => args.some((arg) => flags.includes(arg));
  switch (sub) {
    case 'merge':
    case 'cherry-pick':
    case 'rebase':
    case 'revert':
    case 'am':
      return !has('--abort', '--quit');
    case 'commit':
    case 'reset':
    case 'push':
    case 'pull':
    case 'update-ref':
    case 'switch':
      return true;
    case 'apply':
      return !(has('--check', '--stat', '--numstat', '--summary') && !has('--apply'));
    case 'checkout':
      // `git checkout` alone only reports; `git checkout [<tree>] -- <paths>` restores files without moving HEAD.
      return args.length > 0 && !args.includes('--');
    case 'branch':
      return args.some((arg) => /^-[a-zA-Z]*[fdDmMcC]/.test(arg) || ['--force', '--delete', '--move', '--copy'].includes(arg));
    default:
      return false;
  }
}

/** Git writes found in `command`, which runs in `cwd`. */
export function findGitWrites(command: string, cwd: string, home?: string): readonly GitWrite[] {
  const found: GitWrite[] = [];
  const scan = (src: string, start: string | undefined, depth: number): void => {
    if (depth > MAX_DEPTH) {
      // Nesting this deep is not something to reason about statically; report it as unresolvable.
      if (/\bgit\b/.test(src)) found.push({ command: src.slice(0, 200), directory: undefined });
      return;
    }
    const { tokens, substitutions } = tokenize(src);
    for (const body of substitutions) scan(body, start, depth + 1);
    let dir = start;
    for (const words of simpleCommands(tokens)) {
      let i = 0;
      const skipAssignments = () => { while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!.value)) i++; };
      skipAssignments();
      for (;;) {
        const name = words[i]?.value;
        if (name === undefined) break;
        if (WRAPPERS.has(name)) { i++; while (i < words.length && words[i]!.value.startsWith('-')) i++; continue; }
        if (name === 'env') { i++; while (i < words.length && (words[i]!.value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!.value))) i++; continue; }
        if (name === 'timeout') { i++; while (i < words.length && words[i]!.value.startsWith('-')) i++; i++; continue; }
        break;
      }
      const head = words[i];
      if (head === undefined) continue;
      const name = posix.basename(head.value);
      const args = words.slice(i + 1);
      if (name === 'cd' || name === 'pushd') {
        const target = args.find((arg) => !/^-[LPe@]+$/.test(arg.value));
        dir = target === undefined ? (home === undefined ? undefined : home) : target.value === '-' ? undefined : resolveDir(dir, target, home);
        continue;
      }
      if (name === 'popd') { dir = undefined; continue; }
      if (SHELLS.has(name)) {
        const flag = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg.value));
        const script = flag < 0 ? undefined : args[flag + 1];
        if (script !== undefined) scan(script.value, dir, depth + 1);
        continue;
      }
      if (name === 'eval') { scan(args.map((arg) => arg.value).join(' '), dir, depth + 1); continue; }
      if (name !== 'git') continue;
      let gitDir = dir;
      let j = 0;
      while (j < args.length && args[j]!.value.startsWith('-')) {
        const option = args[j]!.value;
        const [key, inline] = option.startsWith('--') && option.includes('=') ? [option.slice(0, option.indexOf('=')), option.slice(option.indexOf('=') + 1)] : [option, undefined];
        if (!GIT_OPTIONS_WITH_VALUE.has(key)) { j++; continue; }
        const value = inline === undefined ? args[j + 1] : { value: inline, dynamic: args[j]!.dynamic };
        if (key === '-C' && value !== undefined) gitDir = value.value.length === 0 && !value.dynamic ? gitDir : resolveDir(gitDir, value, home);
        if ((key === '--git-dir' || key === '--work-tree') && value !== undefined) gitDir = resolveDir(gitDir, value, home);
        j += inline === undefined ? 2 : 1;
      }
      const sub = args[j];
      if (sub === undefined) continue;
      const rest = args.slice(j + 1);
      if (sub.dynamic || isGitWrite(sub.value, rest.map((arg) => arg.value))) {
        found.push({ command: ['git', sub.value, ...rest.map((arg) => arg.value)].join(' ').slice(0, 200), directory: gitDir });
      }
    }
  };
  scan(command, cwd, 0);
  return found;
}

/** True when `path` is `root` or inside it (both absolute, normalized). */
export function isWithin(path: string, root: string): boolean {
  const rel = posix.relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !posix.isAbsolute(rel));
}
