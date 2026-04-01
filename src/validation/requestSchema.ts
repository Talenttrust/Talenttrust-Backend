export type PrimitiveType = 'string' | 'number' | 'boolean';

/**
 * Validation rules for a single request field.
 */
export interface FieldSchema {
    type: PrimitiveType;
    required?: boolean;
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
    enum?: ReadonlyArray<string | number | boolean>;
    pattern?: RegExp;
}

/**
 * Map of field names to validation rules.
 */
export type ObjectSchema = Record<string, FieldSchema>;

export interface ValidationResult {
    value: Record<string, unknown>;
    errors: string[];
}

/**
 * Validates a request segment (params/query/body) using a strict schema.
 * Unknown fields are rejected to reduce attack surface.
 */
export function validateSegment(
    input: unknown,
    schema: ObjectSchema,
    segmentName: 'params' | 'query' | 'body'
): ValidationResult {
    const errors: string[] = [];
    const value: Record<string, unknown> = {};

    if (!isPlainObject(input)) {
        return {
            value,
            errors: [`${segmentName} must be a JSON object`],
        };
    }

    const inputObject = input as Record<string, unknown>;

    for (const incomingKey of Object.keys(inputObject)) {
        if (!(incomingKey in schema)) {
            errors.push(`${segmentName}.${incomingKey} is not allowed`);
        }
    }

    for (const [fieldName, rules] of Object.entries(schema)) {
        const rawValue = inputObject[fieldName];
        const fieldPath = `${segmentName}.${fieldName}`;

        if (rawValue === undefined || rawValue === null) {
            if (rules.required) {
                errors.push(`${fieldPath} is required`);
            }
            continue;
        }

        if (!validatePrimitiveType(rawValue, rules.type)) {
            errors.push(`${fieldPath} must be of type ${rules.type}`);
            continue;
        }

        if (rules.type === 'string') {
            const asString = rawValue as string;
            if (rules.minLength !== undefined && asString.length < rules.minLength) {
                errors.push(`${fieldPath} must have length >= ${rules.minLength}`);
            }
            if (rules.maxLength !== undefined && asString.length > rules.maxLength) {
                errors.push(`${fieldPath} must have length <= ${rules.maxLength}`);
            }
            if (rules.pattern && !rules.pattern.test(asString)) {
                errors.push(`${fieldPath} has invalid format`);
            }
        }

        if (rules.type === 'number') {
            const asNumber = rawValue as number;
            if (!Number.isFinite(asNumber)) {
                errors.push(`${fieldPath} must be a finite number`);
            }
            if (rules.min !== undefined && asNumber < rules.min) {
                errors.push(`${fieldPath} must be >= ${rules.min}`);
            }
            if (rules.max !== undefined && asNumber > rules.max) {
                errors.push(`${fieldPath} must be <= ${rules.max}`);
            }
        }

        if (
            rules.enum &&
            !rules.enum.includes(rawValue as string | number | boolean)
        ) {
            errors.push(`${fieldPath} must be one of: ${rules.enum.join(', ')}`);
        }

        value[fieldName] = rawValue;
    }

    return { value, errors };
}

function validatePrimitiveType(value: unknown, type: PrimitiveType): boolean {
    if (type === 'string') {
        return typeof value === 'string';
    }
    if (type === 'number') {
        return typeof value === 'number';
    }
    return typeof value === 'boolean';
}

function isPlainObject(value: unknown): boolean {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
