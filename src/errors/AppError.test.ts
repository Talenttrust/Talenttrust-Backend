import { 
  AppError, 
  ValidationError, 
  UnauthorizedError, 
  ForbiddenError, 
  NotFoundError, 
  ConflictError, 
  UnprocessableError 
} from './AppError';

describe('AppError Classes', () => {
  it('should use default values for AppError', () => {
    const error = new AppError('Test');
    expect(error.statusCode).toBe(500);
    expect(error.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('should use default message for ValidationError', () => {
    const error = new ValidationError();
    expect(error.message).toBe('Validation failed');
  });

  it('should use default message for UnauthorizedError', () => {
    const error = new UnauthorizedError();
    expect(error.message).toBe('Unauthorized access');
  });

  it('should use default message for ForbiddenError', () => {
    const error = new ForbiddenError();
    expect(error.message).toBe('Permission denied');
  });

  it('should use default resource for NotFoundError', () => {
    const error = new NotFoundError();
    expect(error.message).toBe('Resource not found');
  });

  it('should accept custom message for ConflictError', () => {
    const error = new ConflictError('User exists');
    expect(error.statusCode).toBe(409);
    expect(error.message).toBe('User exists');
  });

  it('should accept custom message for UnprocessableError', () => {
    const error = new UnprocessableError('Bad data');
    expect(error.statusCode).toBe(422);
  });
});