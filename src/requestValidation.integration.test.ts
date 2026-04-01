import request from 'supertest';
import app from './index';

describe('request validation middleware integration', () => {
    describe('GET /api/v1/contracts (query validation)', () => {
        it('accepts valid query', async () => {
            const response = await request(app)
                .get('/api/v1/contracts')
                .query({ status: 'active' });

            expect(response.status).toBe(200);
            expect(response.body).toEqual({
                contracts: [],
                filters: { status: 'active' },
            });
        });

        it('rejects unsupported query keys', async () => {
            const response = await request(app)
                .get('/api/v1/contracts')
                .query({ status: 'active', admin: 'true' });

            expect(response.status).toBe(400);
            expect(response.body.error).toBe('Validation failed');
            expect(response.body.details).toContain('query.admin is not allowed');
        });

        it('rejects invalid query enum values', async () => {
            const response = await request(app)
                .get('/api/v1/contracts')
                .query({ status: 'pending' });

            expect(response.status).toBe(400);
            expect(response.body.details).toContain(
                'query.status must be one of: active, completed, disputed'
            );
        });
    });

    describe('GET /api/v1/contracts/:contractId (params validation)', () => {
        it('accepts valid params', async () => {
            const response = await request(app).get('/api/v1/contracts/contract-123');

            expect(response.status).toBe(200);
            expect(response.body).toEqual({ contractId: 'contract-123' });
        });

        it('rejects short contractId values', async () => {
            const response = await request(app).get('/api/v1/contracts/ab');

            expect(response.status).toBe(400);
            expect(response.body.details).toContain('params.contractId must have length >= 3');
        });
    });

    describe('POST /api/v1/contracts/:contractId/metadata (body validation)', () => {
        it('accepts valid body', async () => {
            const response = await request(app)
                .post('/api/v1/contracts/contract-123/metadata')
                .send({ title: 'Milestone 1', description: 'Initial release', budget: 500 });

            expect(response.status).toBe(201);
            expect(response.body).toEqual({
                contractId: 'contract-123',
                metadata: {
                    title: 'Milestone 1',
                    description: 'Initial release',
                    budget: 500,
                },
            });
        });

        it('rejects unsupported body keys', async () => {
            const response = await request(app)
                .post('/api/v1/contracts/contract-123/metadata')
                .send({ title: 'Milestone 1', internalFlag: true });

            expect(response.status).toBe(400);
            expect(response.body.details).toContain('body.internalFlag is not allowed');
        });

        it('rejects invalid body field types', async () => {
            const response = await request(app)
                .post('/api/v1/contracts/contract-123/metadata')
                .send({ title: 'Milestone 1', budget: '1000' });

            expect(response.status).toBe(400);
            expect(response.body.details).toContain('body.budget must be of type number');
        });
    });
});
