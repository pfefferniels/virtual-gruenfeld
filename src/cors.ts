import type { CorsOptions } from 'cors';

/**
 * Localhost on any port, so `npm run dev` needs no configuration. The deployed
 * client lives on another origin entirely (Cloudflare Pages talking to the
 * teacher on the renderer host), which is what TEACHER_CORS_ORIGIN is for.
 */
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export const parseAllowedOrigins = (raw: string | undefined): string[] =>
    (raw ?? '').split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean);

/**
 * Whether a browser at `origin` may call this server. A request without an
 * Origin header is not a browser request (curl, a health check, the smoke
 * script) and is never the thing CORS protects against.
 */
export const isOriginAllowed = (origin: string | undefined, allowed: string[]): boolean => {
    if (!origin) return true;
    if (allowed.includes('*')) return true;
    if (allowed.includes(origin.replace(/\/$/, ''))) return true;
    return allowed.length === 0 && LOCALHOST_RE.test(origin);
};

/**
 * Unset TEACHER_CORS_ORIGIN keeps development open to localhost and nothing
 * else; deployments name their client origin (comma-separated for more than
 * one). See DEPLOYMENT.md.
 */
export const corsOptions = (raw = process.env.TEACHER_CORS_ORIGIN): CorsOptions => {
    const allowed = parseAllowedOrigins(raw);
    return {
        origin: (origin, callback) => {
            if (isOriginAllowed(origin, allowed)) return callback(null, true);
            // Refusing the header, not the request: the browser blocks the read.
            callback(null, false);
        },
    };
};
