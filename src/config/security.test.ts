/**
 * @title Security Configuration Tests
 * @notice Tests for CORS allowlist validation and configuration
 */
import { corsConfig, helmetConfig } from './security';

describe('Security Configuration', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('CORS Configuration', () => {
        describe('Wildcard Origin Validation', () => {
            it('should reject wildcard origin in production mode', () => {
                process.env.NODE_ENV = 'production';
                process.env.ALLOWED_ORIGINS = '*';

                expect(() => {
                    jest.isolateModules(() => {
                        require('./security');
                    });
                }).toThrow('Wildcard CORS origin (*) is not allowed in production mode');
            });

            it('should accept wildcard origin in development mode', () => {
                process.env.NODE_ENV = 'development';
                process.env.ALLOWED_ORIGINS = '*';

                expect(() => {
                    jest.isolateModules(() => {
                        require('./security');
                    });
                }).not.toThrow();
            });

            it('should accept wildcard origin when NODE_ENV is not set', () => {
                delete process.env.NODE_ENV;
                process.env.ALLOWED_ORIGINS = '*';

                expect(() => {
                    jest.isolateModules(() => {
                        require('./security');
                    });
                }).not.toThrow();
            });

            it('should reject wildcard mixed with other origins in production', () => {
                process.env.NODE_ENV = 'production';
                process.env.ALLOWED_ORIGINS = 'https://example.com,*,https://other.com';

                expect(() => {
                    jest.isolateModules(() => {
                        require('./security');
                    });
                }).toThrow('Wildcard CORS origin (*) is not allowed in production mode');
            });
        });

        describe('Origin Parsing', () => {
            it('should parse comma-separated origins', () => {
                process.env.ALLOWED_ORIGINS = 'https://example.com,https://other.com,http://localhost:3000';

                expect(() => {
                    jest.isolateModules(() => {
                        require('./security');
                    });
                }).not.toThrow();
            });

            it('should trim whitespace from origins', () => {
                process.env.ALLOWED_ORIGINS = ' https://example.com , https://other.com , http://localhost:3000 ';

                expect(() => {
                    jest.isolateModules(() => {
                        require('./security');
                    });
                }).not.toThrow();
            });

            it('should filter out empty strings', () => {
                process.env.ALLOWED_ORIGINS = 'https://example.com,,https://other.com,,,';

                expect(() => {
                    jest.isolateModules(() => {
                        require('./security');
                    });
                }).not.toThrow();
            });

            it('should use default origins when ALLOWED_ORIGINS is not set', () => {
                delete process.env.ALLOWED_ORIGINS;

                expect(() => {
                    jest.isolateModules(() => {
                        require('./security');
                    });
                }).not.toThrow();
            });
        });

        describe('Empty Allowlist Validation', () => {
            it('should reject empty allowlist', () => {
                process.env.ALLOWED_ORIGINS = '';

                expect(() => {
                    jest.isolateModules(() => {
                        require('./security');
                    });
                }).toThrow('CORS allowlist cannot be empty');
            });

            it('should reject allowlist with only whitespace', () => {
                process.env.ALLOWED_ORIGINS = '   ,  ,  ';

                expect(() => {
                    jest.isolateModules(() => {
                        require('./security');
                    });
                }).toThrow('CORS allowlist cannot be empty');
            });
        });

        describe('Origin Format Validation', () => {
            it('should warn about origins without http:// or https://', () => {
                const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
                process.env.ALLOWED_ORIGINS = 'example.com,localhost:3000';

                jest.isolateModules(() => {
                    require('./security');
                });

                expect(consoleWarnSpy).toHaveBeenCalledWith(
                    expect.stringContaining('example.com')
                );
                expect(consoleWarnSpy).toHaveBeenCalledWith(
                    expect.stringContaining('localhost:3000')
                );

                consoleWarnSpy.mockRestore();
            });

            it('should not warn about valid http:// origins', () => {
                const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
                process.env.ALLOWED_ORIGINS = 'http://localhost:3000,http://example.com';

                jest.isolateModules(() => {
                    require('./security');
                });

                expect(consoleWarnSpy).not.toHaveBeenCalled();
                consoleWarnSpy.mockRestore();
            });

            it('should not warn about valid https:// origins', () => {
                const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
                process.env.ALLOWED_ORIGINS = 'https://example.com,https://other.com';

                jest.isolateModules(() => {
                    require('./security');
                });

                expect(consoleWarnSpy).not.toHaveBeenCalled();
                consoleWarnSpy.mockRestore();
            });

            it('should not warn about wildcard origin', () => {
                const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
                process.env.NODE_ENV = 'development';
                process.env.ALLOWED_ORIGINS = '*';

                jest.isolateModules(() => {
                    require('./security');
                });

                expect(consoleWarnSpy).not.toHaveBeenCalled();
                consoleWarnSpy.mockRestore();
            });
        });

        describe('CORS Origin Callback', () => {
            it('should allow requests from allowed origins', (done) => {
                process.env.ALLOWED_ORIGINS = 'https://example.com,https://other.com';

                jest.isolateModules(() => {
                    const { corsConfig: config } = require('./security');

                    const callback = jest.fn((err, allow) => {
                        expect(err).toBeNull();
                        expect(allow).toBe(true);
                        done();
                    });

                    if (typeof config.origin === 'function') {
                        config.origin('https://example.com', callback);
                    }
                });
            });

            it('should reject requests from disallowed origins', (done) => {
                process.env.ALLOWED_ORIGINS = 'https://example.com';

                jest.isolateModules(() => {
                    const { corsConfig: config } = require('./security');

                    const callback = jest.fn((err) => {
                        expect(err).toBeInstanceOf(Error);
                        expect(err.message).toBe('Not allowed by CORS policy');
                        done();
                    });

                    if (typeof config.origin === 'function') {
                        config.origin('https://malicious.com', callback);
                    }
                });
            });

            it('should allow requests with no origin header', (done) => {
                process.env.ALLOWED_ORIGINS = 'https://example.com';

                jest.isolateModules(() => {
                    const { corsConfig: config } = require('./security');

                    const callback = jest.fn((err, allow) => {
                        expect(err).toBeNull();
                        expect(allow).toBe(true);
                        done();
                    });

                    if (typeof config.origin === 'function') {
                        config.origin(undefined, callback);
                    }
                });
            });

            it('should perform case-sensitive origin matching', (done) => {
                process.env.ALLOWED_ORIGINS = 'https://example.com';

                jest.isolateModules(() => {
                    const { corsConfig: config } = require('./security');

                    const callback = jest.fn((err) => {
                        expect(err).toBeInstanceOf(Error);
                        expect(err.message).toBe('Not allowed by CORS policy');
                        done();
                    });

                    if (typeof config.origin === 'function') {
                        config.origin('https://EXAMPLE.COM', callback);
                    }
                });
            });
        });

        describe('CORS Configuration Properties', () => {
            it('should maintain allowed methods', () => {
                expect(corsConfig.methods).toEqual(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']);
            });

            it('should maintain allowed headers', () => {
                expect(corsConfig.allowedHeaders).toEqual(['Content-Type', 'Authorization']);
            });

            it('should enable credentials', () => {
                expect(corsConfig.credentials).toBe(true);
            });

            it('should set maxAge to 24 hours', () => {
                expect(corsConfig.maxAge).toBe(86400);
            });
        });
    });

    describe('Helmet Configuration', () => {
        it('should have Content-Security-Policy configured', () => {
            expect(helmetConfig.contentSecurityPolicy).toBeDefined();
            if (helmetConfig.contentSecurityPolicy && typeof helmetConfig.contentSecurityPolicy === 'object') {
                expect(helmetConfig.contentSecurityPolicy.directives).toBeDefined();
            }
        });

        it('should have HSTS configured', () => {
            expect(helmetConfig.hsts).toBeDefined();
            expect(helmetConfig.hsts).toMatchObject({
                maxAge: 31536000,
                includeSubDomains: true,
                preload: true,
            });
        });

        it('should have referrer policy configured', () => {
            expect(helmetConfig.referrerPolicy).toEqual({ policy: 'strict-origin-when-cross-origin' });
        });

        it('should have cross-origin resource policy configured', () => {
            expect(helmetConfig.crossOriginResourcePolicy).toEqual({ policy: 'same-origin' });
        });
    });
});
