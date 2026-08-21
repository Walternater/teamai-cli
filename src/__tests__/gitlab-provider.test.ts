import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Provider modules import the logger; stub it so importing has no side effects.
vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
  }),
}));

import { detectProvider, getProvider } from '../providers/registry.js';
import { GitLabProvider } from '../providers/gitlab/index.js';
import {
  parseGitlabRepoInput,
  getGitlabToken,
  gitlabIsAuthenticated,
  gitlabMrCreate,
  fetchGitlabMR,
  GITLAB_HOST,
} from '../providers/gitlab/gitlab-api.js';

const ENV_KEYS = ['GITLAB_TOKEN', 'GITLAB_PRIVATE_TOKEN', 'TEAMAI_GITLAB_HOST'] as const;

describe('GitLab provider registration', () => {
  it('detects gitlab.com URLs (https and ssh) as the gitlab provider', () => {
    expect(detectProvider('https://gitlab.com/acme/harness')).toBe('gitlab');
    expect(detectProvider('https://gitlab.com/acme/harness.git')).toBe('gitlab');
    expect(detectProvider('git@gitlab.com:acme/harness.git')).toBe('gitlab');
  });

  it('the factory returns a GitLabProvider named "gitlab"', () => {
    const p = getProvider('gitlab');
    expect(p).toBeInstanceOf(GitLabProvider);
    expect(p.name).toBe('gitlab');
    expect(p.getDefaultEmailDomain()).toBeNull();
  });

  it('detects a self-hosted host configured via TEAMAI_GITLAB_HOST', async () => {
    vi.resetModules();
    process.env.TEAMAI_GITLAB_HOST = 'gitlab.mycompany.com';
    const { detectProvider: detect } = await import('../providers/registry.js');
    expect(detect('https://gitlab.mycompany.com/acme/harness')).toBe('gitlab');
    expect(detect('git@gitlab.mycompany.com:acme/harness.git')).toBe('gitlab');
  });
});

describe('parseGitlabRepoInput', () => {
  it('parses a bare owner/repo', () => {
    expect(parseGitlabRepoInput('acme/harness')).toEqual({
      owner: 'acme',
      repo: 'harness',
      httpsUrl: `https://${GITLAB_HOST}/acme/harness.git`,
      projectId: encodeURIComponent('acme/harness'),
    });
  });

  it('parses a full URL and strips scheme/host/.git/trailing slash', () => {
    const r = parseGitlabRepoInput('https://gitlab.com/acme/harness.git/');
    expect(r.owner).toBe('acme');
    expect(r.repo).toBe('harness');
  });

  it('parses an SSH URL with a nested group path', () => {
    const r = parseGitlabRepoInput('git@gitlab.com:acme/backend/harness.git');
    expect(r.owner).toBe('acme/backend');
    expect(r.repo).toBe('harness');
    expect(r.projectId).toBe(encodeURIComponent('acme/backend/harness'));
  });

  it('treats a nested group path as owner = everything but the last segment', () => {
    const r = parseGitlabRepoInput('acme/backend/harness');
    expect(r.owner).toBe('acme/backend');
    expect(r.repo).toBe('harness');
  });

  it('rejects input without an owner', () => {
    expect(() => parseGitlabRepoInput('harness')).toThrow(/Invalid GitLab repo/);
  });
});

describe('GitLab token resolution', () => {
  let tmpHome: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gitlab-test-'));
    process.env.HOME = tmpHome;
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_PRIVATE_TOKEN;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_PRIVATE_TOKEN;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns null when no env token and no stored file', () => {
    expect(getGitlabToken()).toBeNull();
    expect(gitlabIsAuthenticated()).toBe(false);
  });

  it('prefers the env token over the stored file', () => {
    fs.mkdirSync(path.join(tmpHome, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.teamai', 'gitlab-token'), 'file-token\n');
    process.env.GITLAB_TOKEN = 'env-token';
    expect(getGitlabToken()).toBe('env-token');
  });

  it('reads the stored file when no env token is set', () => {
    fs.mkdirSync(path.join(tmpHome, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.teamai', 'gitlab-token'), 'file-token\n');
    expect(getGitlabToken()).toBe('file-token');
    expect(gitlabIsAuthenticated()).toBe(true);
  });
});

describe('gitlabMrCreate', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    process.env.GITLAB_TOKEN = 'test-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    delete process.env.GITLAB_TOKEN;
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('POSTs to the MR API with PRIVATE-TOKEN auth and returns web_url', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ iid: 7, web_url: 'https://gitlab.com/acme/harness/-/merge_requests/7' }), { status: 201 }),
    );

    const url = await gitlabMrCreate({
      repo: 'acme/harness',
      source: 'feat/x',
      target: 'main',
      title: 'Add rules',
      description: 'desc',
    });

    expect(url).toBe('https://gitlab.com/acme/harness/-/merge_requests/7');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://gitlab.com/api/v4/projects/acme%2Fharness/merge_requests');
    expect((init.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe('test-token');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({
      source_branch: 'feat/x',
      target_branch: 'main',
      title: 'Add rules',
      description: 'desc',
    });
  });

  it('throws with the HTTP status when the API rejects the request', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'source branch not found' }), { status: 400 }),
    );

    await expect(
      gitlabMrCreate({ repo: 'acme/harness', source: 'nope', target: 'main', title: 'x' }),
    ).rejects.toThrow(/HTTP 400.*source branch not found/);
  });

  it('throws without leaking the token into error output', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(
      gitlabMrCreate({ repo: 'acme/harness', source: 'a', target: 'main', title: 'x' }),
    ).rejects.toThrow('network down');
  });
});

describe('fetchGitlabMR', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    process.env.GITLAB_TOKEN = 'test-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    delete process.env.GITLAB_TOKEN;
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('fetches MR metadata and diff, handling the /-/ URL layout', async () => {
    const mrUrl = 'https://gitlab.com/acme/backend/harness/-/merge_requests/12';
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 99,
            iid: 12,
            title: 'Fix login',
            description: 'body',
            author: { username: 'alice' },
            merged_at: '2026-08-01T00:00:00Z',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ changes: [{ diff: 'a' }, { diff: 'b' }] }), { status: 200 }),
      );

    const data = await fetchGitlabMR(mrUrl);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://gitlab.com/api/v4/projects/acme%2Fbackend%2Fharness/merge_requests/12',
    );
    expect(data.title).toBe('Fix login');
    expect(data.author).toBe('alice');
    expect(data.mergedAt).toBe('2026-08-01T00:00:00Z');
    expect(data.diff).toBe('a\nb');
    expect(data.url).toBe(mrUrl);
  });

  it('accepts the legacy URL layout without /-/', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 1, iid: 3, title: 't', description: '' }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ changes: [] }), { status: 200 }),
    );
    const data = await fetchGitlabMR('https://gitlab.com/acme/harness/merge_requests/3');
    expect(data.title).toBe('t');
    expect(data.diff).toBe('');
  });

  it('rejects an invalid MR URL', async () => {
    await expect(fetchGitlabMR('https://gitlab.com/acme/harness')).rejects.toThrow(/Invalid GitLab MR URL/);
  });
});
