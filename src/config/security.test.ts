import { corsConfig, helmetConfig } from './security';
import { CorsOptions } from 'cors';

describe('Security Configuration', () => {
    it('should export corsConfig with expected defaults', () => {
        expect(corsConfig).toBeDefined();
        const options = corsConfig as CorsOptions;
        expect(options.methods).toContain('GET');
        expect(options.methods).toContain('POST');
        expect(options.credentials).toBe(true);
    });

    it('should export helmetConfig with hsts enabled', () => {
        expect(helmetConfig).toBeDefined();
        expect(helmetConfig.hsts).toBeDefined();
        if (helmetConfig.hsts && typeof helmetConfig.hsts !== 'boolean') {
            expect(helmetConfig.hsts.maxAge).toBe(31536000);
            expect(helmetConfig.hsts.includeSubDomains).toBe(true);
        }
    });
});
