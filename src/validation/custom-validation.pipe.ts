import 'reflect-metadata';
import { Request, Response, NextFunction } from 'express';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';

export interface FormattedErrorDetail {
  field: string;
  errors: string[];
}

export interface ValidationErrorResponse {
  statusCode: number;
  error: string;
  message: string;
  details: FormattedErrorDetail[];
}

/**
 * Recursively format validation errors to retrieve clean, flattened, dot-notated paths.
 */
export function formatErrors(errors: ValidationError[], parentPath = ''): FormattedErrorDetail[] {
  const details: FormattedErrorDetail[] = [];

  for (const error of errors) {
    const fieldPath = parentPath ? `${parentPath}.${error.property}` : error.property;

    if (error.constraints) {
      details.push({
        field: fieldPath,
        errors: Object.values(error.constraints),
      });
    }

    if (error.children && error.children.length > 0) {
      details.push(...formatErrors(error.children, fieldPath));
    }
  }

  return details;
}

/**
 * Recursively trim and normalize (NFC) all string fields in a payload.
 */
export function trimAndNormalizeRecursive(obj: any): any {
  if (typeof obj === 'string') {
    return obj.trim().normalize('NFC');
  }
  if (Array.isArray(obj)) {
    return obj.map(trimAndNormalizeRecursive);
  }
  if (obj !== null && typeof obj === 'object' && !(obj instanceof Date) && !Buffer.isBuffer(obj)) {
    const keys = Object.keys(obj);
    for (const key of keys) {
      obj[key] = trimAndNormalizeRecursive(obj[key]);
    }
  }
  return obj;
}

/**
 * Express middleware acting as a global ValidationPipe.
 *
 * It transforms the request body to the specified target DTO, runs validations
 * using class-validator with whitelist filtering enabled, and formats errors.
 * It also trims and normalizes all string fields globally prior to validation.
 *
 * @param targetDto The class representing the DTO to validate against.
 */
export function validationPipe<T extends object>(targetDto: new () => T) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // 1. Globally trim and normalize strings in req.body
      if (req.body) {
        req.body = trimAndNormalizeRecursive(req.body);
      }

      // 2. Transform the plain request object to a class instance
      const instance = plainToInstance(targetDto, req.body || {});

      // 3. Validate the class instance
      const errors = await validate(instance, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

      if (errors.length > 0) {
        const details = formatErrors(errors);
        const errorResponse: ValidationErrorResponse = {
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation failed',
          details,
        };
        res.status(400).json(errorResponse);
        return;
      }

      // 4. Overwrite req.body with the whitelisted, transformed, and sanitized instance
      req.body = instance;
      next();
    } catch (error) {
      next(error);
    }
  };
}
