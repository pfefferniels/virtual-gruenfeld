import { describe, expect, it } from 'vitest';

import { isOriginAllowed, parseAllowedOrigins } from './cors';

describe('parseAllowedOrigins', () => {
    it('splits a comma-separated list and forgives spacing and trailing slashes', () => {
        expect(parseAllowedOrigins('https://play.welte225.org/, https://staging.welte225.org'))
            .toEqual(['https://play.welte225.org', 'https://staging.welte225.org']);
    });

    it('reads unset and empty as no configured origins', () => {
        expect(parseAllowedOrigins(undefined)).toEqual([]);
        expect(parseAllowedOrigins('  ,  ')).toEqual([]);
    });
});

describe('isOriginAllowed', () => {
    const deployed = parseAllowedOrigins('https://play.welte225.org');

    it('lets the configured client origin in, however it is spelled', () => {
        expect(isOriginAllowed('https://play.welte225.org', deployed)).toBe(true);
        expect(isOriginAllowed('https://play.welte225.org/', deployed)).toBe(true);
    });

    it('keeps every other site out once an origin is configured', () => {
        expect(isOriginAllowed('https://evil.example', deployed)).toBe(false);
        // Not a subdomain match, not a scheme downgrade.
        expect(isOriginAllowed('https://play.welte225.org.evil.example', deployed)).toBe(false);
        expect(isOriginAllowed('http://play.welte225.org', deployed)).toBe(false);
        // Configuring a deployment origin ends the localhost convenience.
        expect(isOriginAllowed('http://localhost:3000', deployed)).toBe(false);
    });

    it('falls back to localhost on any port when nothing is configured', () => {
        expect(isOriginAllowed('http://localhost:3000', [])).toBe(true);
        expect(isOriginAllowed('http://127.0.0.1:5173', [])).toBe(true);
        expect(isOriginAllowed('https://play.welte225.org', [])).toBe(false);
    });

    it('leaves non-browser callers alone — they send no Origin', () => {
        expect(isOriginAllowed(undefined, deployed)).toBe(true);
        expect(isOriginAllowed(undefined, [])).toBe(true);
    });

    it('honours an explicit wildcard for anyone who really wants it', () => {
        expect(isOriginAllowed('https://evil.example', parseAllowedOrigins('*'))).toBe(true);
    });
});
