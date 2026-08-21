import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { log } from '../../utils/logger.js';
import { askQuestion } from '../../utils/prompt.js';
import type { MRData } from '../../types.js';
import type { RepoInfo } from '../types.js';

/**
 * GitLab (gitlab.com or self-hosted) REST v4 client.
 *
 * GitLab needs no platform CLI: a personal access token (PAT) is enough for
 * both the REST API (PRIVATE-TOKEN header) and git-over-HTTPS (in-URL
 * `oauth2:<token>` basic auth). Mirrors the GitHub provider's GITHUB_TOKEN
 * handling:
 *   - Interactive (dev laptop): `teamai init` prompts for a PAT once and
 *     stores it in ~/.teamai/gitlab-token (0600, never committed).
 *   - Headless (CI): a `GITLAB_TOKEN` env var is honored directly.
 */

/**
 * Git host for GitLab repos. Defaults to the public gitlab.com; override with
 * `TEAMAI_GITLAB_HOST` for a self-hosted / enterprise instance (e.g.
 * `gitlab.mycompany.com`). The host also feeds provider detection in
 * registry.ts so `teamai init https://gitlab.mycompany.com/group/repo`
 * auto-selects the gitlab provider.
 */
export const GITLAB_HOST =
  process.env.TEAMAI_GITLAB_HOST?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') || 'gitlab.com';

/** Base URL for the GitLab REST API (v4). */
export function gitlabApiBase(): string {
  return `https://${GITLAB_HOST}/api/v4`;
}

// ─── Token resolution ─────────────────────────────────────

/** Path of the locally stored GitLab PAT (0600, outside any repo). */
export function getGitlabTokenPath(): string {
  return path.join(process.env.HOME ?? '', '.teamai', 'gitlab-token');
}

/**
 * Read the GitLab PAT. Env wins over the stored file so CI can override a
 * laptop login (same precedence as the GitHub provider's GITHUB_TOKEN path).
 */
export function getGitlabToken(): string | null {
  const env = process.env.GITLAB_TOKEN ?? process.env.GITLAB_PRIVATE_TOKEN;
  if (env && env.trim()) return env.trim();
  try {
    const content = fs.readFileSync(getGitlabTokenPath(), 'utf-8').trim();
    if (content) return content;
  } catch {
    // no stored token - fall through
  }
  return null;
}

/** Persist a PAT to ~/.teamai/gitlab-token with 0600 permissions. */
export function saveGitlabToken(token: string): void {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('GitLab token must not be empty');
  const tokenPath = getGitlabTokenPath();
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, trimmed + '\n', { mode: 0o600 });
  // Re-assert mode in case the file already existed with looser perms.
  fs.chmodSync(tokenPath, 0o600);
}

/** True when a PAT is available (env or stored file). */
export function gitlabIsAuthenticated(): boolean {
  return getGitlabToken() !== null;
}

// ─── Core REST helper ─────────────────────────────────────

/**
 * Authenticated GET/POST against the GitLab API. Never logs the token.
 * @throws Error with the HTTP status and (truncated) body on non-2xx.
 */
export async function gitlabFetch(
  apiPath: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const token = getGitlabToken();
  if (!token) {
    throw new Error(
      'No GitLab credentials found. Set the GITLAB_TOKEN environment variable ' +
      `(a GitLab personal access token) or run \`teamai init\` interactively.`,
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 30_000);
  try {
    return await fetch(`${gitlabApiBase()}${apiPath}`, {
      ...init,
      headers: {
        'PRIVATE-TOKEN': token,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Authentication ───────────────────────────────────────

/** Current account username via GET /user, or null when not resolvable. */
export async function gitlabWhoami(): Promise<string | null> {
  try {
    const resp = await gitlabFetch('/user');
    if (!resp.ok) return null;
    const user = await resp.json() as { username?: string };
    return user.username ?? null;
  } catch {
    return null;
  }
}

/**
 * Ensure authenticated. If no token is available, prompt for a PAT
 * interactively, validate it against GET /user, and store it locally.
 * Returns the authenticated username.
 */
export async function ensureGitlabAuthenticated(): Promise<string> {
  if (gitlabIsAuthenticated()) {
    const username = await gitlabWhoami();
    if (username) return username;
    // A token exists but was rejected - fall through and ask for a fresh one.
    log.warn('The stored GitLab token was rejected. Please provide a new one.');
  }

  log.info(`Create a personal access token at https://${GITLAB_HOST}/-/user_settings/personal_access_tokens`);
  log.info('(needs the "api" and "read_repository" scopes)');
  const token = (await askQuestion('GitLab personal access token:')).trim();
  if (!token) throw new Error('GitLab authentication aborted: no token provided.');

  saveGitlabToken(token);
  const username = await gitlabWhoami();
  if (!username) {
    throw new Error(
      'GitLab token validation failed (GET /user). Check the token and its scopes, then run `teamai init` again.',
    );
  }
  return username;
}

// ─── Repo input parsing ───────────────────────────────────

export class GitlabRepoNotFoundError extends Error {
  constructor(repo: string) {
    super(`Repo "${repo}" not found on GitLab.`);
    this.name = 'GitlabRepoNotFoundError';
  }
}

/**
 * Parse a GitLab repo URL or bare `owner/repo` into RepoInfo. The owner may be
 * a nested group path (`group/subgroup`), which GitLab treats as part of the
 * project path. Host matching is deliberately loose (any host is stripped):
 * which provider handles an input is decided by detectProvider before this
 * runs, and self-hosted hosts are arbitrary.
 */
export function parseGitlabRepoInput(input: string): RepoInfo {
  const s = input.trim()
    .replace(/^https?:\/\/[^/]+\//i, '')
    .replace(/^git@[^:]+:/i, '')
    .replace(/\/+$/, '') // drop trailing slash(es) first, so `.git` below still anchors
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const segs = s.split('/').filter(Boolean);
  if (segs.length < 2) {
    throw new Error(
      `Invalid GitLab repo: "${input}" (expected owner/repo or a ${GITLAB_HOST} URL)`,
    );
  }
  const repo = segs[segs.length - 1];
  const owner = segs.slice(0, -1).join('/');
  const full = `${owner}/${repo}`;
  return {
    owner,
    repo,
    httpsUrl: `https://${GITLAB_HOST}/${full}.git`,
    projectId: encodeURIComponent(full),
  };
}

// ─── Repository operations ────────────────────────────────

/**
 * Clone via git. With a PAT we embed basic auth in the URL (works in both CI
 * and interactive paths); without one we clone credential-less and let git's
 * own credential helper prompt.
 */
export function gitlabRepoClone(repo: string, localPath: string): void {
  const token = getGitlabToken();
  const cloneUrl = token
    ? `https://oauth2:${token}@${GITLAB_HOST}/${repo}.git`
    : `https://${GITLAB_HOST}/${repo}.git`;
  const result = spawnSync('git', ['clone', cloneUrl, localPath], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  const out = `${result.stderr ?? ''} ${result.stdout ?? ''}`;
  if (/not found|does not exist|Repository not found|404/i.test(out)) {
    throw new GitlabRepoNotFoundError(repo);
  }
  if (result.status !== 0) {
    const sanitized = out.replace(/oauth2:[^@]+@/g, 'oauth2:***@').trim();
    throw new Error(`git clone failed: ${sanitized}`);
  }
}

/**
 * Create a repo via POST /projects. When `owner` is the authenticated user the
 * project lands in the personal namespace; otherwise the owner is looked up as
 * a group namespace first.
 */
export async function gitlabCreateRepo(owner: string, repo: string): Promise<void> {
  let namespaceId: number | undefined;
  const me = await gitlabWhoami();
  if (me && me.toLowerCase() !== owner.toLowerCase()) {
    const nsResp = await gitlabFetch(`/namespaces/${encodeURIComponent(owner)}`);
    if (nsResp.ok) {
      const ns = await nsResp.json() as { id?: number };
      namespaceId = ns.id;
    } else if (nsResp.status === 404) {
      throw new Error(`GitLab namespace "${owner}" not found - cannot create repo there.`);
    }
  }
  const body: Record<string, unknown> = {
    name: repo,
    path: repo,
    visibility: 'private',
    ...(namespaceId !== undefined ? { namespace_id: namespaceId } : {}),
  };
  const resp = await gitlabFetch('/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`GitLab create project failed (HTTP ${resp.status}): ${(await resp.text()).slice(0, 300)}`);
  }
}

// ─── Merge requests ───────────────────────────────────────

export interface GitlabMrCreateOptions {
  repo: string;
  source: string;
  target: string;
  title: string;
  description?: string;
  reviewers?: string[];
}

/**
 * Create a merge request via the MR API. Returns the MR web URL.
 * Reviewer usernames are resolved to IDs via GET /users?username=...; unknown
 * reviewers are skipped (best effort, same as GitHub's --reviewer semantics).
 */
export async function gitlabMrCreate(opts: GitlabMrCreateOptions): Promise<string> {
  const projectId = encodeURIComponent(opts.repo);
  const body: Record<string, unknown> = {
    source_branch: opts.source,
    target_branch: opts.target,
    title: opts.title,
    ...(opts.description ? { description: opts.description } : {}),
  };

  if (opts.reviewers?.length) {
    const reviewerIds: number[] = [];
    for (const username of opts.reviewers) {
      try {
        const resp = await gitlabFetch(`/users?username=${encodeURIComponent(username)}`);
        if (resp.ok) {
          const users = await resp.json() as Array<{ id: number }>;
          if (users[0]?.id) reviewerIds.push(users[0].id);
        }
      } catch {
        // reviewer lookup is best effort - skip on failure
      }
    }
    if (reviewerIds.length) body.reviewer_ids = reviewerIds;
  }

  const resp = await gitlabFetch(`/projects/${projectId}/merge_requests`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`GitLab MR creation failed (HTTP ${resp.status}): ${(await resp.text()).slice(0, 300)}`);
  }
  const mr = await resp.json() as { web_url?: string; iid?: number };
  if (mr.web_url) return mr.web_url;
  if (mr.iid !== undefined) return `https://${GITLAB_HOST}/${opts.repo}/-/merge_requests/${mr.iid}`;
  throw new Error('GitLab MR creation succeeded but returned no web_url/iid.');
}

/** GitLab MR URL 解析结果（group 可为多级路径） */
interface ParsedGitlabMR {
  projectPath: string;
  mrIid: string;
}

/**
 * 从 GitLab MR URL 解析出项目路径与 MR IID。
 * 支持格式（自建 host 任意）：
 *   https://gitlab.com/group/repo/-/merge_requests/123
 *   https://gitlab.com/group/repo/merge_requests/123   （旧版布局，兼容）
 * 解析失败时抛出 Error。
 */
function parseGitlabMRUrl(url: string): ParsedGitlabMR {
  // `.+` is greedy, so for the /-/ layout it captures a trailing "/-";
  // strip it so the project path is exactly group/project.
  const match = url.match(/^https?:\/\/[^/]+\/(.+)\/merge_requests\/(\d+)/);
  if (!match) {
    throw new Error(`Invalid GitLab MR URL: ${url}`);
  }
  return { projectPath: match[1].replace(/\/-$/, ''), mrIid: match[2] };
}

/** GitLab MR API 返回的元信息（仅使用的字段） */
interface GitlabMR {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  author?: { username?: string };
  merged_at?: string | null;
  updated_at?: string | null;
}

/**
 * 通过 GitLab REST API 获取 MR 的完整数据（标题、描述、diff）。
 *   1. GET /projects/{enc}/merge_requests/{iid} 获取元信息
 *   2. GET /projects/{enc}/merge_requests/{iid}/changes 获取 diff
 *      （截断至 50KB，失败非致命）
 */
export async function fetchGitlabMR(url: string): Promise<MRData> {
  const { projectPath, mrIid } = parseGitlabMRUrl(url);
  log.debug(`fetchGitlabMR: ${projectPath}!${mrIid}`);

  const enc = encodeURIComponent(projectPath);
  const resp = await gitlabFetch(`/projects/${enc}/merge_requests/${mrIid}`);
  if (!resp.ok) {
    throw new Error(`GitLab API 返回错误 ${resp.status}：${(await resp.text()).slice(0, 200)}`);
  }
  const mr = await resp.json() as GitlabMR;

  let diff = '';
  try {
    const diffResp = await gitlabFetch(`/projects/${enc}/merge_requests/${mrIid}/changes`);
    if (diffResp.ok) {
      const data = await diffResp.json() as { changes?: Array<{ diff: string }> };
      diff = (data.changes ?? []).map((c) => c.diff).join('\n').slice(0, 50000);
    } else {
      log.debug(`GitLab MR diff 获取失败（${diffResp.status}），diff 将为空`);
    }
  } catch (err) {
    log.debug(`GitLab MR diff 获取异常，diff 将为空：${(err as Error).message}`);
  }

  return {
    title: mr.title,
    description: mr.description ?? '',
    author: mr.author?.username,
    mergedAt: mr.merged_at ?? mr.updated_at ?? undefined,
    commits: [],
    diff,
    url,
  };
}
