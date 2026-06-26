import { beforeEach, describe, expect, it, vi } from "vitest";

// Pin-down tests for the single listing-source dispatcher introduced when
// listRepos/listOrgRepos were collapsed onto githubService.listReposForOwner.
// They lock the per-source behavior (App installations / user-token / gh-cli)
// so a future change to the dispatch can't silently regress one source.

const {
  resolveGitHubAuthMode,
  getUserStatus,
  getUserInstallations,
  getInstallationToken,
  githubFetch,
} = vi.hoisted(() => ({
  resolveGitHubAuthMode: vi.fn(),
  getUserStatus: vi.fn(),
  getUserInstallations: vi.fn(),
  getInstallationToken: vi.fn(),
  githubFetch: vi.fn(),
}));

const { ghFetch } = vi.hoisted(() => ({ ghFetch: vi.fn() }));

const { getLocalGhToken, listLocalGhRepos } = vi.hoisted(() => ({
  getLocalGhToken: vi.fn(),
  listLocalGhRepos: vi.fn(),
}));

vi.mock("../../../src/modules/github/github.auth", () => ({
  githubFetch,
  resolveGitHubAuthMode,
  getUserStatus,
  getUserInstallations,
  getInstallationToken,
  getGitHubConnectionState: vi.fn(),
  mapAccounts: vi.fn(),
  getGitHubAuthMode: vi.fn(),
}));

vi.mock("../../../src/modules/github/github.http", () => ({
  ghFetch,
  ghFetchSoft: vi.fn(),
}));

vi.mock("../../../src/modules/github/github.local-auth", () => ({
  getLocalGhToken,
  listLocalGhRepos,
  listLocalGhOrgs: vi.fn(),
  getLocalGhStatus: vi.fn(),
}));

vi.mock("../../../src/config/env", () => ({
  env: {},
  runtimeTarget: { id: "local" },
}));

import { listReposForOwner } from "../../../src/modules/github/github.service";

const ctx = { userId: "user-1", organizationId: "org-1" } as never;

function raw(fullName: string) {
  return { full_name: fullName, name: fullName.split("/")[1], owner: { login: fullName.split("/")[0] } };
}

beforeEach(() => {
  resolveGitHubAuthMode.mockReset();
  getUserStatus.mockReset();
  getUserInstallations.mockReset();
  getInstallationToken.mockReset();
  ghFetch.mockReset();
  githubFetch.mockReset();
  getLocalGhToken.mockReset();
  listLocalGhRepos.mockReset();
});

describe("listReposForOwner — source dispatch", () => {
  describe("user-token (oauth/cli/token mode)", () => {
    it("lists org repos via /orgs/{owner}/repos when owner is not the user", async () => {
      resolveGitHubAuthMode.mockResolvedValue("oauth");
      getUserStatus.mockResolvedValue({ connected: true, login: "me" });
      githubFetch.mockResolvedValue([raw("acme/site")]);

      const repos = await listReposForOwner(ctx, "acme");

      expect(repos).toHaveLength(1);
      expect(repos?.[0].full_name).toBe("acme/site");
      expect(githubFetch).toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.stringContaining("/orgs/acme/repos") }),
      );
    });

    it("lists the user's own repos via /user/repos when owner === login", async () => {
      resolveGitHubAuthMode.mockResolvedValue("oauth");
      getUserStatus.mockResolvedValue({ connected: true, login: "me" });
      githubFetch.mockResolvedValue([raw("me/dotfiles")]);

      await listReposForOwner(ctx, "me");

      expect(githubFetch).toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.stringContaining("/user/repos") }),
      );
    });
  });

  describe("installations (App connected)", () => {
    it("lists the primary installation's repos via the install token + install-scoped endpoint", async () => {
      resolveGitHubAuthMode.mockResolvedValue("cloud-app");
      getUserStatus.mockResolvedValue({ connected: true, login: "me" });
      getUserInstallations.mockResolvedValue([{ account: { login: "acme" }, id: 42 }]);
      // App-installation token (cloud-minted in cloud-app) used against the
      // install-scoped endpoint — NOT the user-OAuth endpoint, which has no
      // local token in cloud-app mode.
      getInstallationToken.mockResolvedValue("ghs_install_token");
      ghFetch.mockResolvedValue({ repositories: [raw("acme/site")] });

      const repos = await listReposForOwner(ctx);

      expect(repos).toHaveLength(1);
      expect(repos?.[0].full_name).toBe("acme/site");
      expect(getInstallationToken).toHaveBeenCalledWith(ctx, "acme", 42);
      expect(ghFetch).toHaveBeenCalledWith(
        "ghs_install_token",
        expect.objectContaining({ url: expect.stringContaining("/installation/repositories") }),
      );
    });

    it("returns null (→ caller 400) when the user has no installations", async () => {
      resolveGitHubAuthMode.mockResolvedValue("cloud-app");
      getUserStatus.mockResolvedValue({ connected: true, login: "me" });
      getUserInstallations.mockResolvedValue([]);

      expect(await listReposForOwner(ctx)).toBeNull();
    });
  });

  describe("gh-cli fallback (App mode, SaaS GitHub NOT connected)", () => {
    it("lists + filters gh CLI repos by owner when a gh token is present", async () => {
      resolveGitHubAuthMode.mockResolvedValue("cloud-app");
      getUserStatus.mockResolvedValue({ connected: false });
      getLocalGhToken.mockResolvedValue("gho_token");
      listLocalGhRepos.mockResolvedValue([raw("acme/site"), raw("other/lib")]);

      const repos = await listReposForOwner(ctx, "acme");

      expect(repos).toHaveLength(1);
      expect(repos?.[0].full_name).toBe("acme/site");
      expect(githubFetch).not.toHaveBeenCalled();
    });

    it("returns null (→ caller 400) when no gh token is available", async () => {
      resolveGitHubAuthMode.mockResolvedValue("cloud-app");
      getUserStatus.mockResolvedValue({ connected: false });
      getLocalGhToken.mockResolvedValue(null);

      expect(await listReposForOwner(ctx, "acme")).toBeNull();
    });
  });
});
