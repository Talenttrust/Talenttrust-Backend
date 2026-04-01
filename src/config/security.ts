/**
 * @title Security Configuration
 * @notice Centralized configuration for CORS and Helmet security headers
 * @dev Provides configurable options driven by environment variables
 */
import { CorsOptions } from 'cors';
import { HelmetOptions } from 'helmet';

// Array of allowed origins. Defaults to localhost for development, overridable by env.
const allowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000', 'http://localhost:3001'];

/**
 * @notice CORS configuration options
 * @dev Rejects requests from origins not in the allowed pool
 */
export const corsConfig: CorsOptions = {
    origin: (origin, callback) => {
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
