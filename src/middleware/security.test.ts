import express, { Request, Response } from 'express';
import request from 'supertest';
import { applySecurityMiddleware } from './security';

describe('Security Middleware Unit Tests', () => {
    let app: express.Application;

    beforeEach(() => {
        app = express();
        applySecurityMiddleware(app);
        
        // Setup a dummy route to test headers
        app.get('/test-endpoint', (req: Request, res: Response) => {
            res.status(200).json({ success: true });
        });

        // Error handler to catch CORS errors and return 403 instead of 500
        app.use((err: any, req: Request, res: Response, next: express.NextFunction) => {
            if (err.message === 'Not allowed by CORS policy') {
                res.status(403).json({ error: 'CORS policy violation' });
            } else {
                res.status(500).json({ error: 'Internal Server Error' });
            }
        });
    });

    it('should set Content-Security-Policy header', async () => {
        const response = await request(app).get('/test-endpoint');
        expect(response.headers['content-security-policy']).toBeDefined();
    });

    it('should set Strict-Transport-Security header', async () => {
        const response = await request(app).get('/test-endpoint');
        expect(response.headers['strict-transport-security']).toBeDefined();
    });

    it('should set Access-Control-Allow-Origin for allowed origins', async () => {
        const response = await request(app)
            .get('/test-endpoint')
            .set('Origin', 'http://localhost:3000');
        
        expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    });

    it('should return 403 for disallowed origin', async () => {
        const response = await request(app)
            .get('/test-endpoint')
            .set('Origin', 'http://malicious-site.com');
            
        expect(response.status).toBe(403);
        expect(response.body.error).toBe('CORS policy violation');
    });

    it('should allow requests with no origin', async () => {
        const response = await request(app).get('/test-endpoint');
        expect(response.status).toBe(200);
    });
});
