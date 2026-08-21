import type { GitProvider, RepoInfo, PrCreateOptions } from '../types.js';
import { RepoNotFoundError } from '../types.js';
import {
  gitlabIsAuthenticated,
  gitlabWhoami,
  ensureGitlabAuthenticated,
  parseGitlabRepoInput,
  gitlabRepoClone,
  gitlabCreateRepo,
  gitlabMrCreate,
  fetchGitlabMR,
  GitlabRepoNotFoundError,
} from './gitlab-api.js';

/**
 * GitLab (gitlab.com or self-hosted via TEAMAI_GITLAB_HOST) provider.
 * Pure REST: no platform CLI to install, a personal access token covers both
 * the API (PRIVATE-TOKEN) and git-over-HTTPS clone (in-URL basic auth).
 */
export class GitLabProvider implements GitProvider {
  readonly name = 'gitlab';

  parseRepoInput(input: string): RepoInfo {
    return parseGitlabRepoInput(input);
  }

  isAuthenticated(): boolean {
    return gitlabIsAuthenticated();
  }

  async authenticate(): Promise<string> {
    if (this.isAuthenticated()) {
      const username = await gitlabWhoami();
      if (username) return username;
    }
    return ensureGitlabAuthenticated();
  }

  async ensureInstalled(): Promise<void> {
    // REST + plain git only - nothing to install.
  }

  cloneRepo(repo: string, localPath: string): void {
    try {
      gitlabRepoClone(repo, localPath);
    } catch (e) {
      if (e instanceof GitlabRepoNotFoundError) {
        throw new RepoNotFoundError(repo);
      }
      throw e;
    }
  }

  async createRepo(owner: string, repo: string): Promise<void> {
    await gitlabCreateRepo(owner, repo);
  }

  async createPullRequest(opts: PrCreateOptions): Promise<string> {
    return gitlabMrCreate({
      repo: opts.repo,
      source: opts.source,
      target: opts.target,
      title: opts.title,
      description: opts.description,
      reviewers: opts.reviewers,
    });
  }

  getDefaultEmailDomain(): string | null {
    // GitLab has no fixed corporate email domain - use the user's git global config.
    return null;
  }

  async fetchMergeRequest(url: string): Promise<import('../../types.js').MRData> {
    return fetchGitlabMR(url);
  }
}

export {
  gitlabIsAuthenticated,
  getGitlabToken,
  GITLAB_HOST,
} from './gitlab-api.js';
