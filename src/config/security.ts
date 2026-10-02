/**
 * @title Security Configuration
 * @notice Centralized configuration for CORS and Helmet security headers
 * @dev Provides configurable options driven by environment variables
 */
import { CorsOptions } from 'cors';
import { HelmetOptions } from 'helmet';

/**
 * @notice Validates CORS allowlist configuration
 * @dev Enforces strict denial of wildcard origins in production mode
 * @param origins Array of allowed origins
 * @throws Error if wildcard is used in production or allowlist is empty
 */
function validateCorsAllowlist(origins: string[]): void {
    const isProduction = process.env.NODE_ENV === 'production';
    
    // Check for wildcard in production
    if (isProduction && origins.includes('*')) {
        throw new Error('Wildcard CORS origin (*) is not allowed in production mode');
    }
    
    // Check for localhost in production
    if (isProduction && origins.some(origin => origin.includes('localhost'))) {
        throw new Error('Localhost CORS origin is not allowed in production mode');
    }
    
    // Warn about invalid origin formats
    origins.forEach(origin => {
        if (origin !== '*' && !origin.startsWith('http://') && !origin.startsWith('https://')) {
            console.warn(`[CORS] Warning: Origin "${origin}" does not start with http:// or https://`);
        }
    });
}

/**
 * @notice Parses and validates CORS allowed origins from environment
 * @dev Production defaults to deny-by-default (empty list).
 *      Non-production defaults to localhost origins for convenience.
 * @returns Array of validated allowed origins
 */
function parseAllowedOrigins(): string[] {
    const isProduction = process.env.NODE_ENV === 'production';
    const hasAllowedOrigins = 'CORS_ALLOWED_ORIGINS' in process.env;
    
    let origins: string[];
    if (hasAllowedOrigins) {
        const raw = process.env.CORS_ALLOWED_ORIGINS!;
        origins = raw ? raw.split(',').map(o => o.trim()).filter(Boolean) : [];
    } else {
        // Production defaults to deny-by-default; development defaults to localhost
        origins = isProduction ? [] : ['http://localhost:3000', 'http://localhost:3001'];
    }
    
    if (origins.length > 0) {
        validateCorsAllowlist(origins);
    } else if (!isProduction) {
        // Warn (do not throw) in non-production when the resolved allowlist is empty —
        // whether CORS_ALLOWED_ORIGINS was explicitly set to an empty/whitespace value or
        // omitted entirely. An empty allowlist blocks all browser cross-origin requests,
        // which is almost certainly a misconfiguration in dev/staging, but it should not
        // hard-crash the process. Production legitimately starts with deny-by-default.
        console.warn(
            '[CORS] Allowlist is empty — all cross-origin requests from browsers will be rejected. ' +
            'Provide at least one allowed origin via CORS_ALLOWED_ORIGINS or remove the variable to use the defaults.',
        );
    }
    
    return origins;
}

// Array of allowed origins. Defaults to localhost for development, overridable by env.
const allowedOrigins = parseAllowedOrigins();

/**
 * @notice Creates a CORS configuration from an explicit allowlist.
 * @dev Used when the validated environment config drives CORS (preferred over process.env).
 * @param origins Array of allowed origins
 */
export function createCorsConfig(origins: string[]): CorsOptions {
    if (origins.length > 0) {
        validateCorsAllowlist(origins);
    }
    return {
        origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
            if (!origin || origins.indexOf(origin) !== -1) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS policy'));
            }
        },
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: true,
        maxAge: 86400,
    };
}

/**
 * @notice CORS configuration options
 * @dev Rejects requests from origins not in the allowed pool.
 *      Never echoes arbitrary origins and never uses wildcard with credentials enabled.
 */
export const corsConfig: CorsOptions = createCorsConfig(allowedOrigins);

/**
 * @notice Helmet configuration options
 * @dev Sets up restrictive Content-Security-Policy and HSTS policy
 */
export const helmetConfig: HelmetOptions = {
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'", "https:", "data:"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"],
        },
    },
    hsts: {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true,
    },
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
};
