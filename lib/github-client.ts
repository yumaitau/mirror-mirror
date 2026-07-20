import type { DiscoveredRepository } from "./contracts";
import { sanitizeError } from "./errors";

export interface GitHubClientConfig {
  organization: string;
  token: string;
}

interface GitHubRepositoryPayload {
  id: number;
  name: string;
  full_name: string;
  clone_url: string;
}

const API_ORIGIN = "https://api.github.com";

function parseRepository(value: unknown): GitHubRepositoryPayload {
  if (!value || typeof value !== "object") {
    throw new Error("GitHub returned a malformed repository record.");
  }

  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.id) || Number(record.id) <= 0) {
    throw new Error("GitHub returned a repository with an invalid id.");
  }
  if (typeof record.name !== "string" || record.name.trim() === "") {
    throw new Error("GitHub returned a repository with an invalid name.");
  }
  if (
    typeof record.full_name !== "string" ||
    record.full_name.trim() === ""
  ) {
    throw new Error("GitHub returned a repository with an invalid full name.");
  }
  if (typeof record.clone_url !== "string") {
    throw new Error("GitHub returned a repository with an invalid clone URL.");
  }

  let cloneUrl: URL;
  try {
    cloneUrl = new URL(record.clone_url);
  } catch {
    throw new Error("GitHub returned a repository with an invalid clone URL.");
  }
  if (
    cloneUrl.protocol !== "https:" ||
    cloneUrl.host !== "github.com" ||
    cloneUrl.username !== "" ||
    cloneUrl.password !== ""
  ) {
    throw new Error("GitHub returned a repository with an unsafe clone URL.");
  }

  return {
    id: Number(record.id),
    name: record.name.trim(),
    full_name: record.full_name.trim(),
    clone_url: cloneUrl.href,
  };
}

function findNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }

  for (const link of linkHeader.split(",")) {
    const match = link.match(/^\s*<([^>]+)>\s*;\s*rel="?([^";]+)"?/);
    if (match?.[2]?.split(/\s+/).includes("next")) {
      return match[1] ?? null;
    }
  }
  return null;
}

function validatePageUrl(value: string, expectedPath: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GitHub returned an invalid pagination URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.host !== "api.github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== expectedPath
  ) {
    throw new Error("GitHub returned an unsafe pagination URL.");
  }
  return url;
}

function httpError(response: Response): Error {
  const details = [
    `GitHub repository discovery failed with HTTP ${response.status}.`,
  ];
  const requestId = response.headers.get("x-github-request-id");
  const rateLimitReset = response.headers.get("x-ratelimit-reset");
  if (requestId) {
    details.push(`Request ID: ${requestId}.`);
  }
  if (rateLimitReset) {
    details.push(`Rate limit reset: ${rateLimitReset}.`);
  }
  return new Error(details.join(" "));
}

/** List every accessible repository after validating the complete result. */
export async function listOrganizationRepositories(
  config: GitHubClientConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredRepository[]> {
  const encodedOrganization = encodeURIComponent(config.organization);
  const expectedPath = `/orgs/${encodedOrganization}/repos`;
  let pageUrl = new URL(
    `${API_ORIGIN}${expectedPath}?type=all&per_page=100`,
  );
  const authorization = `Bearer ${config.token}`;
  const visited = new Set<string>();
  const repositories: DiscoveredRepository[] = [];
  const repositoryIds = new Set<number>();

  try {
    while (true) {
      const normalizedUrl = pageUrl.href;
      if (visited.has(normalizedUrl)) {
        throw new Error("GitHub returned cyclic pagination.");
      }
      visited.add(normalizedUrl);

      const response = await fetchImpl(normalizedUrl, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: authorization,
          "User-Agent": "mirror-mirror",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        redirect: "error",
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new Error("GitHub attempted to redirect repository discovery.");
      }
      if (!response.ok) {
        throw httpError(response);
      }

      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) {
        throw new Error("GitHub returned a malformed repository page.");
      }
      for (const value of payload) {
        const repository = parseRepository(value);
        if (repositoryIds.has(repository.id)) {
          throw new Error(
            `GitHub returned duplicate repository id ${repository.id}.`,
          );
        }
        repositoryIds.add(repository.id);
        repositories.push({
          githubId: repository.id,
          name: repository.name,
          fullName: repository.full_name,
          cloneUrl: repository.clone_url,
        });
      }

      const nextLink = findNextLink(response.headers.get("link"));
      if (!nextLink) {
        return repositories;
      }
      pageUrl = validatePageUrl(nextLink, expectedPath);
    }
  } catch (error) {
    throw new Error(sanitizeError(error, [config.token, authorization]));
  }
}
