// src/services/sandbox.ts
import { Context, Effect, Layer } from "effect";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
  SandboxStartupError,
  SandboxConnectionError,
  R2MountError,
  RepositoryCloneError,
} from "../models/errors";

// Re-export Sandbox type for consumers
export type { Sandbox } from "@cloudflare/sandbox";

/**
 * Sandbox binding type - the getSandbox function accepts DurableObjectNamespace
 * but requires it to be typed with Sandbox. We use a more permissive type here
 * and cast internally.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SandboxBinding = DurableObjectNamespace<any>;

/**
 * R2 endpoint format for mounting
 */
const getR2Endpoint = (accountId: string): string =>
  `https://${accountId}.r2.cloudflarestorage.com`;

/**
 * Sandbox service interface
 */
export interface SandboxServiceInterface {
  readonly getSandbox: (
    sandboxId: string
  ) => Effect.Effect<Sandbox<unknown>, SandboxStartupError>;

  readonly mountR2WithPrefix: (
    sandbox: Sandbox<unknown>,
    sessionId: string,
    config: {
      accountId: string;
      accessKeyId: string;
      secretAccessKey: string;
      bucketName: string;
    }
  ) => Effect.Effect<void, R2MountError>;

  readonly cloneRepository: (
    sandbox: Sandbox<unknown>,
    url: string,
    branch?: string
  ) => Effect.Effect<void, RepositoryCloneError>;

  readonly setupGitCredentials: (
    sandbox: Sandbox<unknown>,
    token: string,
    authorName: string,
    authorEmail: string
  ) => Effect.Effect<void, SandboxConnectionError>;

  readonly exposePort: (
    sandbox: Sandbox<unknown>,
    port: number,
    hostname: string
  ) => Effect.Effect<string, SandboxConnectionError>;

  readonly execCommand: (
    sandbox: Sandbox<unknown>,
    command: string
  ) => Effect.Effect<
    { stdout: string; stderr: string; exitCode: number },
    SandboxConnectionError
  >;
}

/**
 * Create sandbox service from environment
 */
export const makeSandboxService = (
  sandboxBinding: SandboxBinding
): SandboxServiceInterface => ({
  getSandbox: (sandboxId) =>
    Effect.try({
      try: () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getSandbox(sandboxBinding as any, sandboxId, {
          normalizeId: true, // Lowercase for preview URL compatibility
          sleepAfter: "10 minutes",
        }),
      catch: (error) =>
        new SandboxStartupError({
          sandboxId,
          cause: String(error),
        }),
    }),

  mountR2WithPrefix: (sandbox, sessionId, config) =>
    Effect.tryPromise({
      try: async () => {
        const endpoint = getR2Endpoint(config.accountId);

        // Use s3fs bucket:/prefix syntax for mounting a subdirectory
        // This mounts only the session's workspace, not the entire bucket
        await sandbox.mountBucket(
          `${config.bucketName}:/${sessionId}/workspace`,
          "/workspace",
          {
            endpoint,
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }
        );
      },
      catch: (error) =>
        new R2MountError({
          sessionId,
          mountPath: "/workspace",
          cause: String(error),
        }),
    }),

  cloneRepository: (sandbox, url, branch) =>
    Effect.tryPromise({
      try: async () => {
        await sandbox.gitCheckout(url, {
          branch: branch ?? "main",
          targetDir: "/workspace",
        });
      },
      catch: (error) =>
        new RepositoryCloneError({
          url,
          branch,
          cause: String(error),
        }),
    }),

  setupGitCredentials: (sandbox, token, authorName, authorEmail) =>
    Effect.tryPromise({
      try: async () => {
        await sandbox.setEnvVars({
          GITHUB_TOKEN: token,
          GIT_AUTHOR_NAME: authorName,
          GIT_AUTHOR_EMAIL: authorEmail,
          GIT_COMMITTER_NAME: authorName,
          GIT_COMMITTER_EMAIL: authorEmail,
        });

        // Configure git credential helper
        await sandbox.exec(
          `git config --global credential.helper '!f() { echo "password=${token}"; }; f'`
        );
      },
      catch: (error) =>
        new SandboxConnectionError({
          sandboxId: "unknown",
          cause: String(error),
        }),
    }),

  exposePort: (sandbox, port, hostname) =>
    Effect.tryPromise({
      try: async () => {
        const result = await sandbox.exposePort(port, { hostname });
        return result.url;
      },
      catch: (error) =>
        new SandboxConnectionError({
          sandboxId: "unknown",
          cause: String(error),
        }),
    }),

  execCommand: (sandbox, command) =>
    Effect.tryPromise({
      try: async () => {
        const result = await sandbox.exec(command);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      },
      catch: (error) =>
        new SandboxConnectionError({
          sandboxId: "unknown",
          cause: String(error),
        }),
    }),
});

/**
 * Sandbox service context tag
 */
export class SandboxService extends Context.Tag("@sandbox-mcp/SandboxService")<
  SandboxService,
  SandboxServiceInterface
>() {}

/**
 * Create sandbox service layer
 */
export const makeSandboxLayer = (
  sandboxBinding: SandboxBinding
): Layer.Layer<SandboxService> =>
  Layer.succeed(SandboxService, makeSandboxService(sandboxBinding));
