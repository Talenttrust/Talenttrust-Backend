import { ObjectSchema, validateSegment } from './requestSchema';

describe('validateSegment', () => {
    const schema: ObjectSchema = {
        id: { type: 'string', required: true, minLength: 3 },
        score: { type: 'number', required: false, min: 0, max: 100 },
        verified: { type: 'boolean', required: false },
    };

    it('accepts valid payload and returns validated value', () => {
        const result = validateSegment(
            { id: 'abc', score: 90, verified: true },
            schema,
            'body'
        );

        expect(result.errors).toEqual([]);
        expect(result.value).toEqual({ id: 'abc', score: 90, verified: true });
    });

    it('rejects unknown keys', () => {
        const result = validateSegment(
            { id: 'abcd', unknown: 'not-allowed' },
            schema,
            'body'
        );

        expect(result.errors).toContain('body.unknown is not allowed');
    });

    it('rejects missing required field and invalid types', () => {
        const result = validateSegment({ score: 'bad' }, schema, 'body');

        expect(result.errors).toContain('body.id is required');
        expect(result.errors).toContain('body.score must be of type number');
    });

    it('rejects out-of-range number values', () => {
        const result = validateSegment({ id: 'user-1', score: 101 }, schema, 'body');

        expect(result.errors).toContain('body.score must be <= 100');
    });

    it('rejects below-min and non-finite number values', () => {
        const belowMin = validateSegment({ id: 'user-1', score: -1 }, schema, 'body');
        const nonFinite = validateSegment({ id: 'user-1', score: Infinity }, schema, 'body');

        expect(belowMin.errors).toContain('body.score must be >= 0');
        expect(nonFinite.errors).toContain('body.score must be a finite number');
    });

    it('rejects invalid string pattern values', () => {
        const patternedSchema: ObjectSchema = {
            id: { type: 'string', required: true, pattern: /^usr_[a-z0-9]+$/ },
        };

        const result = validateSegment({ id: 'INVALID' }, patternedSchema, 'params');

        expect(result.errors).toContain('params.id has invalid format');
    });

    it('rejects non-object segments', () => {
        const result = validateSegment('invalid', schema, 'query');

        expect(result.errors).toEqual(['query must be a JSON object']);
    });
});
