import 'reflect-metadata';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { IsEmail, IsString, IsNotEmpty, IsInt, Min, ValidateNested, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { IsSanitized } from './sanitize.decorator';
import { validationPipe } from './custom-validation.pipe';

// ── Test DTO Definitions ───────────────────────────────────────────────────

class NestedDto {
  @IsString()
  @IsNotEmpty()
  @IsSanitized()
  role: string;

  @IsEmail({}, { message: 'Nested email must comply with standard format' })
  email: string;
}

class TestUserDto {
  @IsString()
  @IsNotEmpty()
  @IsSanitized()
  username: string;

  @IsEmail({}, { message: 'Email must be a valid RFC 5322 address' })
  email: string;

  @IsInt()
  @Min(1)
  id: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => NestedDto)
  profile?: NestedDto;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => NestedDto)
  contacts?: NestedDto[];
}

// ── Test Express App Setup ─────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Apply our validationPipe middleware with TestUserDto
app.post('/test-validate', validationPipe(TestUserDto), (req: Request, res: Response) => {
  res.status(200).json({ success: true, data: req.body });
});

// Generic error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err.message });
});

// ── Jest Tests ─────────────────────────────────────────────────────────────

describe('Input Validation and Sanitization Pipeline', () => {
  
  describe('Global Configuration and Rejection (HTTP 400)', () => {
    it('should reject with 400 Bad Request if the payload is empty', async () => {
      const response = await request(app)
        .post('/test-validate')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toEqual(
        expect.objectContaining({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation failed',
          details: expect.any(Array),
        })
      );
      // We expect errors for username, email, and id
      expect(response.body.details.length).toBeGreaterThanOrEqual(3);
    });

    it('should reject with 400 Bad Request if non-whitelisted/extra keys are sent', async () => {
      const response = await request(app)
        .post('/test-validate')
        .send({
          username: 'validUser',
          email: 'valid@example.com',
          id: 42,
          unauthorizedField: 'dangerousValue',
        });

      expect(response.status).toBe(400);
      expect(response.body.details).toContainEqual(
        expect.objectContaining({
          field: 'unauthorizedField',
          errors: [expect.stringContaining('property unauthorizedField should not exist')],
        })
      );
    });

    it('should reject with 400 Bad Request if types are incorrect', async () => {
      const response = await request(app)
        .post('/test-validate')
        .send({
          username: 'validUser',
          email: 'valid@example.com',
          id: 'not-an-integer', // invalid type
        });

      expect(response.status).toBe(400);
      const idError = response.body.details.find((d: any) => d.field === 'id');
      expect(idError).toBeDefined();
    });
  });

  describe('Sanitization and Trimming (@IsSanitized)', () => {
    it('should trim string fields and apply Unicode NFC normalization globally', async () => {
      const response = await request(app)
        .post('/test-validate')
        .send({
          username: '  normalUser\u0065\u0301  ', // e + acute accent -> normalized to é
          email: 'test@example.com',
          id: 10,
        });

      expect(response.status).toBe(200);
      // 'normalUseré' has been normalized and trimmed
      expect(response.body.data.username).toBe('normalUseré');
    });

    it('should sanitize HTML/JavaScript XSS tags from string fields', async () => {
      const response = await request(app)
        .post('/test-validate')
        .send({
          username: '<script>alert("XSS")</script>hello<img src=x onerror=alert(1)>',
          email: 'xss@example.com',
          id: 12,
        });

      expect(response.status).toBe(200);
      // Tags script/img should be stripped out completely
      expect(response.body.data.username).toBe('hello');
    });

    it('should neutralize basic SQL Injection characters and comments', async () => {
      const response = await request(app)
        .post('/test-validate')
        .send({
          username: "admin' OR '1'='1' --",
          email: 'sqli@example.com',
          id: 15,
        });

      expect(response.status).toBe(200);
      // Single quotes escaped (to '') and -- comments stripped
      expect(response.body.data.username).toBe("admin'' OR ''1''=''1'' ");
    });

    it('should strip out multi-line SQL comments (/* and */)', async () => {
      const response = await request(app)
        .post('/test-validate')
        .send({
          username: "user /* suspicious comment */ name",
          email: 'sqli2@example.com',
          id: 16,
        });

      expect(response.status).toBe(200);
      expect(response.body.data.username).toBe("user  suspicious comment  name");
    });
  });

  describe('RFC 5322 Email Validation', () => {
    it('should accept valid standard email formats', async () => {
      const response = await request(app)
        .post('/test-validate')
        .send({
          username: 'testUser',
          email: 'user.name+tag@example.co.uk',
          id: 20,
        });

      expect(response.status).toBe(200);
    });

    it('should reject invalid non-standard email formats', async () => {
      const invalidEmails = [
        'plainaddress',
        '#@%^%#$@#$@#.com',
        '@example.com',
        'Joe Smith <email@example.com>',
        'email.example.com',
        'email@example@example.com',
      ];

      for (const email of invalidEmails) {
        const response = await request(app)
          .post('/test-validate')
          .send({
            username: 'testUser',
            email: email,
            id: 21,
          });

        expect(response.status).toBe(400);
        const emailError = response.body.details.find((d: any) => d.field === 'email');
        expect(emailError).toBeDefined();
        expect(emailError.errors[0]).toContain('RFC 5322');
      }
    });
  });

  describe('Recursive Nested Object and Array Validation', () => {
    it('should validate and sanitize nested profile objects', async () => {
      const response = await request(app)
        .post('/test-validate')
        .send({
          username: 'validUser',
          email: 'valid@example.com',
          id: 30,
          profile: {
            role: '  <script>alert("xss")</script>ADMIN  ', // Needs sanitization + trimming
            email: 'profile@example.com',
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.data.profile.role).toBe('ADMIN');
      expect(response.body.data.profile.email).toBe('profile@example.com');
    });

    it('should reject if nested profile validation fails', async () => {
      const response = await request(app)
        .post('/test-validate')
        .send({
          username: 'validUser',
          email: 'valid@example.com',
          id: 31,
          profile: {
            role: '', // Can't be empty
            email: 'invalid-nested-email',
          },
        });

      expect(response.status).toBe(400);
      const roleError = response.body.details.find((d: any) => d.field === 'profile.role');
      const emailError = response.body.details.find((d: any) => d.field === 'profile.email');

      expect(roleError).toBeDefined();
      expect(emailError).toBeDefined();
      expect(emailError.errors[0]).toContain('Nested email must comply with');
    });

    it('should validate and sanitize lists of nested contact objects', async () => {
      const response = await request(app)
        .post('/test-validate')
        .send({
          username: 'validUser',
          email: 'valid@example.com',
          id: 35,
          contacts: [
            { role: ' MANAGER ', email: 'm1@example.com' },
            { role: ' STAFF ', email: 's1@example.com' },
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body.data.contacts[0].role).toBe('MANAGER');
      expect(response.body.data.contacts[1].role).toBe('STAFF');
    });

    it('should reject if any element in a nested array fails validation', async () => {
      const response = await request(app)
        .post('/test-validate')
        .send({
          username: 'validUser',
          email: 'valid@example.com',
          id: 36,
          contacts: [
            { role: 'MANAGER', email: 'm1@example.com' },
            { role: '', email: 'bad-email' }, // fails role and email
          ],
        });

      expect(response.status).toBe(400);
      const roleError = response.body.details.find((d: any) => d.field === 'contacts.1.role');
      const emailError = response.body.details.find((d: any) => d.field === 'contacts.1.email');

      expect(roleError).toBeDefined();
      expect(emailError).toBeDefined();
    });
  });
});
