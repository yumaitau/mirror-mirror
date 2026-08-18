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

/** Canonical id-based repository page path GitHub uses in its Link header. */
const ORGANIZATION_PAGE_PATH = /^\/organizations\/(\d+)\/repos$/;

/**
 * Decide whether a next-page pathname is one this client may send the token to,
 * and report which organization id it pins for the pages that follow.
 *
 * Two pathnames are legitimate, and no others:
 *   - `expectedPath`, the initial name-based `/orgs/{org}/repos`
 *   - the canonical id-based `/organizations/{id}/repos`, which is what GitHub
 *     actually returns in its `Link` header (verified against the live API)
 *
 * Once an id has been seen, every later page must reuse that same id, so a
 * mid-pagination switch to a different organization is refused. The name-based
 * path stays acceptable throughout and never disturbs the pin, because it is the
 * one path this client built itself.
 *
 * @param pathname             - pathname of the candidate next-page URL
 * @param expectedPath         - the initial `/orgs/{org}/repos` path for this run
 * @param pinnedOrganizationId - id seen on an earlier page, or null if none yet
 * @returns the organization id to pin going forward (null when nothing has been
 *          pinned yet and this page used the name-based path)
 * @throws  Error("GitHub returned an unsafe pagination URL.") when the path is
 *          neither legitimate shape
 * @throws  Error("GitHub returned a pagination URL for a different
 *          organization.") when the path names an organization other than the
 *          one an earlier page already pinned
 */
function acceptPagePath(
  pathname: string,
  expectedPath: string,
  pinnedOrganizationId: string | null,
): string | null {
  if (pathname === expectedPath) {
    return pinnedOrganizationId;
  }

  const organizationId = ORGANIZATION_PAGE_PATH.exec(pathname)?.[1];
  if (organizationId === undefined) {
    throw new Error("GitHub returned an unsafe pagination URL.");
  }
  if (
    pinnedOrganizationId !== null &&
    organizationId !== pinnedOrganizationId
  ) {
    throw new Error(
      "GitHub returned a pagination URL for a different organization.",
    );
  }
  return organizationId;
}

/**
 * Validate a next-page URL before it is fetched with the token attached.
 *
 * Transport checks (origin, credentials) are settled here. The path decision is
 * delegated to {@link acceptPagePath}, which also carries the organization-id
 * pinning rule across pages.
 */
function validatePageUrl(
  value: string,
  expectedPath: string,
  pinnedOrganizationId: string | null,
): { url: URL; organizationId: string | null } {
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
    url.password !== ""
  ) {
    throw new Error("GitHub returned an unsafe pagination URL.");
  }

  return {
    url,
    organizationId: acceptPagePath(
      url.pathname,
      expectedPath,
      pinnedOrganizationId,
    ),
  };
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
  let pinnedOrganizationId: string | null = null;
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
      const nextPage = validatePageUrl(
        nextLink,
        expectedPath,
        pinnedOrganizationId,
      );
      pageUrl = nextPage.url;
      pinnedOrganizationId = nextPage.organizationId;
    }
  } catch (error) {
    throw new Error(sanitizeError(error, [config.token, authorization]));
  }
}
