/**
 * @title Security Middleware
 * @notice Composes configured Helmet and CORS middleware for the Express app
 * @dev Use this before defining routes in the Express application
 */
import { Application } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { corsConfig, helmetConfig } from '../config/security';

/**
 * @notice Applies security policies to the Express application
 * @dev Attaches CORS and Helmet middlewares with predefined config
 * @param app The Express Application instance
 */
export function applySecurityMiddleware(app: Application): void {
    app.use(helmet(helmetConfig));
    app.use(cors(corsConfig));
}
