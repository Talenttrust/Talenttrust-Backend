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
    
    // Check for empty allowlist
    if (origins.length === 0) {
        throw new Error('CORS allowlist cannot be empty');
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
 * @dev Trims whitespace and filters empty strings
 * @returns Array of validated allowed origins
 */
function parseAllowedOrigins(): string[] {
    // Check if ALLOWED_ORIGINS is explicitly set (even if empty)
    const hasAllowedOrigins = 'ALLOWED_ORIGINS' in process.env;
    
    const origins = hasAllowedOrigins
        ? process.env.ALLOWED_ORIGINS!.split(',').map(o => o.trim()).filter(Boolean)
        : ['http://localhost:3000', 'http://localhost:3001'];
    
    validateCorsAllowlist(origins);
    return origins;
}

// Array of allowed origins. Defaults to localhost for development, overridable by env.
const allowedOrigins = parseAllowedOrigins();

/**
 * @notice CORS configuration options
 * @dev Rejects requests from origins not in the allowed pool
 */
export const corsConfig: CorsOptions = {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // Allow requests with no origin (like server-to-server or curl requests) if desired
        // In this secure baseline, we restrict it unless it matches allowed origins.
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS policy'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 86400, // 24 hours
};

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
