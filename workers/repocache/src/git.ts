import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);

const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const PULL_TIMEOUT_MS = 60 * 1000;
const REV_PARSE_TIMEOUT_MS = 10 * 1000;

const SHELL_META_RE = /[;&|`$(){}<>\\\n\r\t\s"']/;
const HTTPS_URL_RE = /^https:\/\/[A-Za-z0-9._~%-]+(?::[0-9]+)?(?:\/[A-Za-z0-9._~%/-]+)?(?:\.git)?$/;
const SSH_URL_RE = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+(?:\.git)?$/;
const REF_RE = /^[A-Za-z0-9_./-]+$/;

// Allowlist https:// and git@host:path SSH only. file://, relative paths, and
// any shell metacharacter are rejected before the URL reaches `git`.
export function validateRepoUrl(url: string): void {
  if (typeof url !== 'string' || url.length === 0 || url.length > 512) {
    throw new Error('repo_url: empty or too long');
  }
  if (SHELL_META_RE.test(url)) {
    throw new Error('repo_url: contains disallowed characters');
  }
  if (!HTTPS_URL_RE.test(url) && !SSH_URL_RE.test(url)) {
    throw new Error('repo_url: must be https:// or git@host:path');
  }
}

// Ref must match REF_RE and avoid `..` / leading or trailing `/` so a caller
// can't traverse into a sibling directory or smuggle a relative ref.
export function validateRef(ref: string): void {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 255) {
    throw new Error('ref: empty or too long');
  }
  if (!REF_RE.test(ref)) {
    throw new Error('ref: contains disallowed characters');
  }
  if (ref.includes('..') || ref.startsWith('/') || ref.endsWith('/')) {
    throw new Error('ref: invalid shape');
  }
}

export function cacheKey(repoUrl: string, ref: string): string {
  return createHash('sha1').update(`${repoUrl}#${ref}`).digest('hex').slice(0, 16);
}

// Never forward arbitrary env. Git specifically needs PATH + the two prompt
// disablers so it fails fast on auth instead of hanging forever.
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/true',
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  return env;
}

async function git(args: string[], opts: { cwd?: string; timeout: number }): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: opts.cwd,
    env: gitEnv(),
    timeout: opts.timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export async function cloneRepo(repoUrl: string, ref: string, dest: string): Promise<void> {
  await git(['clone', '--branch', ref, '--single-branch', '--', repoUrl, dest], {
    timeout: CLONE_TIMEOUT_MS,
  });
}

export async function fetchAndFastForward(cwd: string, ref: string): Promise<void> {
  await git(['fetch', '--prune', 'origin', ref], { cwd, timeout: PULL_TIMEOUT_MS });
  await git(['checkout', ref], { cwd, timeout: PULL_TIMEOUT_MS });
  // --ff-only rejects non-fast-forward; that's intentional — the cache must
  // never rewrite history, it can only advance.
  await git(['merge', '--ff-only', `origin/${ref}`], { cwd, timeout: PULL_TIMEOUT_MS });
}

export async function revParseHead(cwd: string): Promise<string> {
  const out = await git(['rev-parse', 'HEAD'], { cwd, timeout: REV_PARSE_TIMEOUT_MS });
  return out.trim();
}

export async function defaultBranch(repoUrl: string): Promise<string> {
  // `ls-remote --symref` prints the HEAD symref even without cloning. Parse
  // out the branch so we have a real ref to pass to --branch.
  const out = await git(['ls-remote', '--symref', '--', repoUrl, 'HEAD'], {
    timeout: PULL_TIMEOUT_MS,
  });
  const match = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  if (!match?.[1]) throw new Error('default branch: could not resolve HEAD symref');
  return match[1];
}
