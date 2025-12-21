/**
 * R2 bucket access proxy service configuration.
 *
 * This service proxies S3-compatible requests to Cloudflare R2, re-signing them
 * with real R2 credentials. Supports both:
 * - Bearer token authentication (simple HTTP clients)
 * - AWS Signature V4 authentication (s3fs, AWS SDKs)
 *
 * The JWT token is extracted from either the Authorization header (Bearer) or
 * from the Credential portion of AWS Sig V4 headers.
 */

import type { Sandbox } from "@cloudflare/sandbox";
import { AwsClient } from "aws4fetch";

import type { ServiceConfig } from "../types";

/**
 * Extract access key ID from AWS Signature V4 Authorization header.
 *
 * AWS Sig V4 format: AWS4-HMAC-SHA256 Credential={access_key}/{date}/{region}/s3/aws4_request, ...
 */
function extractAccessKeyFromAuth(authHeader: string): string | null {
  const match = authHeader.match(/Credential=([^/]+)\//);
  return match ? match[1] : null;
}

/**
 * Filter headers to only S3-relevant ones.
 *
 * Using an allowlist prevents signature issues from unexpected headers
 * and avoids leaking internal headers to R2.
 */
function filterHeaders(headers: Headers): Headers {
  const allowed = new Set([
    "content-type",
    "content-encoding",
    "content-disposition",
    "content-language",
    "cache-control",
    "expires",
    "range",
    "x-amz-acl",
    "x-amz-storage-class",
    "x-amz-server-side-encryption",
    "x-amz-copy-source",
    "x-amz-copy-source-range",
  ]);

  const filtered = new Headers();
  for (const [key, value] of headers) {
    const lower = key.toLowerCase();
    if (allowed.has(lower) || lower.startsWith("x-amz-meta-")) {
      filtered.set(key, value);
    }
  }
  return filtered;
}

/**
 * R2 S3-compatible proxy service configuration.
 *
 * Accepts tokens from:
 * - AWS Signature V4 headers (access key ID is the JWT token)
 * - Bearer token authentication
 *
 * Path format: /{bucket}/{key}
 */
export const r2: ServiceConfig<Env> = {
  // Target is dynamically constructed from R2_ENDPOINT
  target: "https://unused.example.com",

  validate: (req) => {
    const auth = req.headers.get("Authorization");
    if (auth?.startsWith("AWS4-HMAC-SHA256")) {
      return extractAccessKeyFromAuth(auth);
    }
    if (auth?.startsWith("Bearer ")) {
      return auth.replace("Bearer ", "");
    }
    return null;
  },

  transform: async (req, ctx) => {
    const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT } = ctx.env;
    if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ENDPOINT) {
      return new Response("R2 credentials not configured", { status: 500 });
    }

    const url = new URL(req.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const bucket = pathParts[0];
    const key = pathParts.slice(1).join("/");

    if (!bucket) {
      return new Response("Bucket name required in path", { status: 400 });
    }

    // Build R2 URL and copy query params
    const r2Url = new URL(`/${bucket}/${key}`, R2_ENDPOINT);
    for (const [name, value] of url.searchParams) {
      r2Url.searchParams.set(name, value);
    }

    // Re-sign request with real R2 credentials
    const awsClient = new AwsClient({
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    });

    const hasBody = !["GET", "HEAD"].includes(req.method);
    const requestInit: RequestInit & { duplex?: string } = {
      method: req.method,
      headers: filterHeaders(req.headers),
      body: hasBody ? req.body : null,
    };
    // duplex required for streaming request bodies in Cloudflare Workers
    if (hasBody) {
      requestInit.duplex = "half";
    }
    const newRequest = new Request(r2Url.toString(), requestInit);

    const signedRequest = await awsClient.sign(newRequest, {
      aws: { service: "s3" },
    });
    const response = await fetch(signedRequest);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        ...Object.fromEntries(response.headers),
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};

/**
 * Mount an R2 bucket via the proxy using s3fs.
 *
 * The JWT token is used as the accessKeyId, which the proxy extracts from
 * AWS Sig V4 headers and validates. The secretAccessKey is required by s3fs
 * format but ignored by the proxy.
 *
 * NOTE: Using direct s3fs exec instead of SDK's mountBucket() because
 * mountBucket() validates bucket names and rejects path prefixes like
 * "bucket/sessionId". We need path prefixes for session isolation.
 * TODO: Revisit once SDK supports path prefixes in bucket names.
 *
 * @param sandbox - The sandbox instance to configure
 * @param proxyBase - Base URL of the proxy (e.g., 'https://worker.dev')
 * @param token - JWT proxy token
 * @param bucket - R2 bucket name with optional path prefix (e.g., 'bucket/sessionId')
 * @param mountPath - Path to mount the bucket at in the sandbox
 */
export async function configureR2(
  sandbox: Sandbox,
  proxyBase: string,
  token: string,
  bucket: string,
  mountPath: string,
): Promise<void> {
  const proxyEndpoint = `${proxyBase}/proxy/r2`;
  const passwordFilePath = `/tmp/.passwd-s3fs-${bucket.replace(/\//g, "-")}`;

  // s3fs password file format: bucket:accessKeyId:secretAccessKey
  // JWT token is used as accessKeyId - proxy extracts and validates it
  await sandbox.writeFile(passwordFilePath, `${bucket}:${token}:unused`);
  await sandbox.exec(`chmod 0600 ${passwordFilePath}`);
  await sandbox.exec(`mkdir -p ${mountPath}`);

  const s3fsCmd = [
    `s3fs ${bucket} ${mountPath}`,
    `-o passwd_file=${passwordFilePath}`,
    `-o url=${proxyEndpoint}`,
    `-o use_path_request_style`,
  ].join(" ");

  await sandbox.exec(s3fsCmd);

  // SDK mountBucket() approach - commented out due to bucket name validation issue
  // await sandbox.mountBucket(bucket, mountPath, {
  //   endpoint: proxyEndpoint,
  //   credentials: {
  //     accessKeyId: token,
  //     secretAccessKey: "unused",
  //   },
  //   s3fsOptions: ["use_path_request_style"],
  // });
}
