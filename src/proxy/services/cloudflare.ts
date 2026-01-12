import type { ServiceConfig } from "../types";

/**
 * Cloudflare API proxy service.
 *
 * Target: https://api.cloudflare.com/client/v4
 *
 * This service injects the real CLOUDFLARE_API_TOKEN from the environment.
 * Sandbox requests use the proxy token in the Authorization header.
 */
export const cloudflare: ServiceConfig<Env> = {
  target: "https://api.cloudflare.com/client/v4",

  /**
   * Validate the incoming request.
   * The token is passed in the Authorization header as a Bearer token.
   */
  validate: (req) => {
    const auth = req.headers.get("authorization");
    if (!auth || !auth.startsWith("Bearer ")) {
      return null;
    }
    return auth.slice(7);
  },

  /**
   * Transform the request to use real credentials.
   */
  transform: async (req, ctx) => {
    const env = ctx.env as any;
    if (!env.CLOUDFLARE_API_TOKEN) {
      throw new Error("CLOUDFLARE_API_TOKEN not configured on engine");
    }

    // Inject the real token
    req.headers.set("authorization", `Bearer ${env.CLOUDFLARE_API_TOKEN}`);

    return req;
  },
};
