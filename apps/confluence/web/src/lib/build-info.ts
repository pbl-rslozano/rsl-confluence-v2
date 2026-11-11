export const BUILD_INFO = {
  version: "2.6.0",
  build: 20261107,
  label: "2.6.0",
  releaseDate: "07.11.2026",
  updatedAt: "2026-11-07T00:00:00.000Z",
} as const;

/**
 * v2.6 (US-4): source commit of this build, injected by CI (NEXT_PUBLIC_GIT_COMMIT = github.sha)
 * and shown in About so a user can compare it with the release page. "local" for hand-made builds.
 */
export const BUILD_COMMIT: string = (process.env.NEXT_PUBLIC_GIT_COMMIT ?? "").slice(0, 12) || "local";
