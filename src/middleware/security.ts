/**
 * @title Security Middleware
 * @notice Composes configured Helmet and CORS middleware for the Express app
 * @dev Use this before defining routes in the Express application
 */
import { Application } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { corsConfig, helmetConfig, createCorsConfig } from '../config/security';

/**
 * @notice Applies security policies to the Express application
 * @dev Attaches CORS and Helmet middlewares with predefined config.
 *      When allowedOrigins is provided, it overrides the environment-based config.
 * @param app The Express Application instance
 * @param allowedOrigins Optional explicit list of allowed CORS origins
 */
export function applySecurityMiddleware(app: Application, allowedOrigins?: string[]): void {
    app.use(helmet(helmetConfig));
    app.use(cors(allowedOrigins ? createCorsConfig(allowedOrigins) : corsConfig));
}
