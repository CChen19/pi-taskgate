import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findGitWrites, isGitWrite, isWithin } from '../src/core/git-write-guard.ts';

const CWD = '/repo';
const HOME = '/home/u';
const writes = (command: string, cwd = CWD) => findGitWrites(command, cwd, HOME).map((write) => [write.command.split(' ').slice(0, 2).join(' '), write.directory]);

describe('git write guard: classification', () => {
  it('flags history, branch and tree writes', () => {
    for (const command of ['git commit -m x', 'git merge feature', 'git cherry-pick abc', 'git rebase main', 'git reset --hard HEAD~1', 'git revert abc', 'git am p.patch', 'git apply p.diff', 'git push', 'git pull', 'git update-ref refs/heads/x abc', 'git switch main', 'git checkout main', 'git checkout -b x', 'git branch -f main abc', 'git branch -D x', 'git branch --move a b']) {
      assert.equal(writes(command).length, 1, command);
    }
  });

  it('lets read-only and recovery commands through', () => {
    for (const command of ['git status', 'git log --oneline --grep=merge', 'git diff HEAD~1', 'git show abc:CMakeLists.txt', 'git merge-base a b', 'git branch -a', 'git branch --list', 'git checkout', 'git checkout -- src/a.cpp', 'git checkout abc -- src/a.cpp', 'git apply --check p.diff', 'git merge --abort', 'git cherry-pick --quit', 'git rev-parse HEAD', 'git worktree list', 'git stash list']) {
      assert.deepEqual(writes(command), [], command);
    }
    assert.equal(isGitWrite('apply', ['--stat', '--apply', 'p']), true, '--apply with --stat still applies');
    assert.equal(isGitWrite('rebase', ['--continue']), true);
  });

  it('does not mistake quoted text, arguments, comments or heredoc bodies for commands', () => {
    assert.deepEqual(writes('echo "git commit -m x"'), []);
    assert.deepEqual(writes("grep -rn 'git merge' docs/"), []);
    assert.deepEqual(writes('ls # then git commit'), []);
    assert.deepEqual(writes("cat > notes.md <<'EOF'\ngit commit -m x\ngit push\nEOF\ngit status"), []);
    assert.deepEqual(writes('cat <<-EOF\n\tgit push\n\tEOF\n'), []);
    assert.deepEqual(writes('mygit commit'), []);
  });
});

describe('git write guard: finding every invocation', () => {
  it('splits on separators, pipes, subshells and newlines', () => {
    assert.deepEqual(writes('make && git add -A && git commit -m x; git push || true'), [['git commit', '/repo'], ['git push', '/repo']]);
    assert.deepEqual(writes('(git merge a) | tee log\ngit status'), [['git merge', '/repo']]);
    assert.deepEqual(writes('true & git reset --hard'), [['git reset', '/repo']]);
  });

  it('sees through wrappers, assignments, absolute paths, git global options and redirections', () => {
    assert.deepEqual(writes('GIT_AUTHOR_NAME=x env -i FOO=1 /usr/bin/git -c user.name=x --no-pager commit -m x 2>&1 >/dev/null'), [['git commit', '/repo']]);
    assert.deepEqual(writes('sudo -E git push'), [['git push', '/repo']]);
    assert.deepEqual(writes('timeout 30 git cherry-pick abc'), [['git cherry-pick', '/repo']]);
    assert.deepEqual(writes('git 2>/dev/null commit -m x'), [['git commit', '/repo']]);
  });

  it('scans nested shells, eval and command substitutions', () => {
    assert.deepEqual(writes('bash -lc "cd /other && git commit -m x"'), [['git commit', '/other']]);
    assert.deepEqual(writes("sh -c 'git merge x'"), [['git merge', '/repo']]);
    assert.deepEqual(writes('eval git reset --hard'), [['git reset', '/repo']]);
    assert.deepEqual(writes('echo $(git commit -m x)'), [['git commit', '/repo']]);
    assert.deepEqual(writes('echo "sha: `git commit -m x`"'), [['git commit', '/repo']]);
  });

  it('treats a dynamic subcommand as a write', () => {
    assert.deepEqual(findGitWrites('git $OP x', CWD, HOME).map((write) => write.directory), ['/repo']);
    assert.equal(writes('git "$(echo commit)"').length, 1);
  });
});

describe('git write guard: target directory', () => {
  it('follows cd, git -C, --git-dir and --work-tree', () => {
    assert.deepEqual(writes('cd /tmp/x && git commit -m x'), [['git commit', '/tmp/x']]);
    assert.deepEqual(writes('cd sub && git commit -m x'), [['git commit', '/repo/sub']]);
    assert.deepEqual(writes('cd ~/scratch; git commit -m x'), [['git commit', '/home/u/scratch']]);
    assert.deepEqual(writes('cd; git commit -m x'), [['git commit', '/home/u']]);
    assert.deepEqual(writes('git -C ../ws/T1 commit -m x'), [['git commit', '/ws/T1']]);
    assert.deepEqual(writes('git -C /a -C b commit -m x'), [['git commit', '/a/b']]);
    assert.deepEqual(writes('git --git-dir=/w/.git commit -m x'), [['git commit', '/w/.git']]);
    assert.deepEqual(writes('git --work-tree /w commit -m x'), [['git commit', '/w']]);
  });

  it('reports unresolvable directories as undefined so callers fail closed', () => {
    assert.deepEqual(writes('cd "$WS" && git commit -m x'), [['git commit', undefined]]);
    assert.deepEqual(writes('cd - && git push'), [['git push', undefined]]);
    assert.deepEqual(writes('pushd /a && popd && git push'), [['git push', undefined]]);
    assert.deepEqual(writes('git -C $(pwd) commit -m x'), [['git commit', undefined]]);
    assert.deepEqual(writes('cd ~other && git push'), [['git push', undefined]]);
  });

  it('isWithin matches the root and its descendants only', () => {
    assert.equal(isWithin('/repo', '/repo'), true);
    assert.equal(isWithin('/repo/a/b', '/repo'), true);
    assert.equal(isWithin('/repository', '/repo'), false);
    assert.equal(isWithin('/', '/repo'), false);
  });
});
