/**
 * Host-owned review brief files under `<workspaceRoot>/.briefs/`, outside
 * every worktree, so writing one never dirties a candidate.
 */
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export class BriefStore {
  private readonly dir: string;

  constructor(workspaceRoot: string) {
    this.dir = join(workspaceRoot, '.briefs');
  }

  write(reviewId: string, text: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(reviewId)) throw new Error(`review id ${reviewId} is not a safe file name`);
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, `${reviewId}.md`);
    writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' });
    return canonical(path);
  }

  read(path: string): string {
    return readFileSync(path, 'utf8');
  }

  /** Mirror Pi's read-tool path resolution (leading `@`, `~`, relative to cwd), then canonicalize. */
  resolve(path: string, cwd: string): string {
    let target = path.startsWith('@') ? path.slice(1) : path;
    if (target === '~' || target.startsWith('~/')) target = homedir() + target.slice(1);
    return canonical(isAbsolute(target) ? target : resolve(cwd, target));
  }
}
