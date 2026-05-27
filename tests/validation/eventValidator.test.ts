import { EventValidator } from '../../src/validation/eventValidator';
import { ContractEvent } from '../../src/events/types';

describe('EventValidator', () => {
  const validEvent: ContractEvent = {
    contractId: 'contract_123',
    eventId: 'event_456',
    sequence: 1,
    timestamp: Date.now(),
    payload: { data: 'test' }
  };

  describe('validate', () => {
    it('should validate a correct event', () => {
      const result = EventValidator.validate(validEvent);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject event with missing contractId', () => {
      const invalidEvent = { ...validEvent };
      delete (invalidEvent as any).contractId;
      
      const result = EventValidator.validate(invalidEvent);
      expect(result.isValid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].field).toBe('contractId');
    });

    it('should reject event with invalid sequence type', () => {
      const invalidEvent = { ...validEvent, sequence: 'invalid' as any };
      
      const result = EventValidator.validate(invalidEvent);
      expect(result.isValid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].field).toBe('sequence');
    });

    it('should reject event with negative sequence', () => {
      const invalidEvent = { ...validEvent, sequence: -1 };
      
      const result = EventValidator.validate(invalidEvent);
      expect(result.isValid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].field).toBe('sequence');
    });

    it('should reject event with missing payload', () => {
      const invalidEvent = { ...validEvent };
      delete (invalidEvent as any).payload;
      
      const result = EventValidator.validate(invalidEvent);
      expect(result.isValid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].field).toBe('payload');
    });

    it('should collect multiple validation errors', () => {
      const invalidEvent = {
        contractId: '',
        eventId: '',
        sequence: -1,
        timestamp: 'invalid' as any,
        payload: null as any
      };
      
      const result = EventValidator.validate(invalidEvent);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });
  });

  describe('validateContractSpecificEvent', () => {
    describe('talent_contract', () => {
      it('should validate a valid talent contract event', () => {
        const talentEvent = {
          ...validEvent,
          payload: {
            talentId: 'talent_123',
            action: 'created',
            metadata: { source: 'api' }
          }
        };
        
        const result = EventValidator.validateContractSpecificEvent(talentEvent, 'talent_contract');
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should reject talent contract with invalid action', () => {
        const talentEvent = {
          ...validEvent,
          payload: {
            talentId: 'talent_123',
            action: 'invalid_action'
          }
        };
        
        const result = EventValidator.validateContractSpecificEvent(talentEvent, 'talent_contract');
        expect(result.isValid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].field).toBe('payload.action');
      });

      it('should reject talent contract with missing talentId', () => {
        const talentEvent = {
          ...validEvent,
          payload: {
            action: 'created'
          }
        };
        
        const result = EventValidator.validateContractSpecificEvent(talentEvent, 'talent_contract');
        expect(result.isValid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].field).toBe('payload.talentId');
      });
    });

    describe('payment_contract', () => {
      it('should validate a valid payment contract event', () => {
        const paymentEvent = {
          ...validEvent,
          payload: {
            paymentId: 'payment_123',
            amount: 100.50,
            currency: 'USD',
            status: 'completed',
            timestamp: Date.now()
          }
        };
        
        const result = EventValidator.validateContractSpecificEvent(paymentEvent, 'payment_contract');
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should reject payment contract with invalid status', () => {
        const paymentEvent = {
          ...validEvent,
          payload: {
            paymentId: 'payment_123',
            amount: 100.50,
            currency: 'USD',
            status: 'invalid_status',
            timestamp: Date.now()
          }
        };
        
        const result = EventValidator.validateContractSpecificEvent(paymentEvent, 'payment_contract');
        expect(result.isValid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].field).toBe('payload.status');
      });

      it('should reject payment contract with negative amount', () => {
        const paymentEvent = {
          ...validEvent,
          payload: {
            paymentId: 'payment_123',
            amount: -10,
            currency: 'USD',
            status: 'pending',
            timestamp: Date.now()
          }
        };
        
        const result = EventValidator.validateContractSpecificEvent(paymentEvent, 'payment_contract');
        expect(result.isValid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].field).toBe('payload.amount');
      });
    });

    describe('review_contract', () => {
      it('should validate a valid review contract event', () => {
        const reviewEvent = {
          ...validEvent,
          payload: {
            reviewId: 'review_123',
            reviewerId: 'reviewer_456',
            rating: 5,
            comment: 'Excellent work!',
            createdAt: Date.now()
          }
        };
        
        const result = EventValidator.validateContractSpecificEvent(reviewEvent, 'review_contract');
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should reject review contract with invalid rating', () => {
        const reviewEvent = {
          ...validEvent,
          payload: {
            reviewId: 'review_123',
            reviewerId: 'reviewer_456',
            rating: 6,
            createdAt: Date.now()
          }
        };
        
        const result = EventValidator.validateContractSpecificEvent(reviewEvent, 'review_contract');
        expect(result.isValid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].field).toBe('payload.rating');
      });

      it('should reject review contract with rating below 1', () => {
        const reviewEvent = {
          ...validEvent,
          payload: {
            reviewId: 'review_123',
            reviewerId: 'reviewer_456',
            rating: 0,
            createdAt: Date.now()
          }
        };
        
        const result = EventValidator.validateContractSpecificEvent(reviewEvent, 'review_contract');
        expect(result.isValid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].field).toBe('payload.rating');
      });
    });

    it('should reject unknown contract types', () => {
      const result = EventValidator.validateContractSpecificEvent(validEvent, 'unknown_contract');
      expect(result.isValid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].field).toBe('contractId');
      expect(result.errors[0].message).toContain('Unknown contract type');
    });
  });

  describe('validatePayload', () => {
    it('should validate payload against custom schema', () => {
      const schema = require('joi').object({
        name: require('joi').string().required(),
        age: require('joi').number().integer().min(0).required()
      });
      
      const validPayload = { name: 'John', age: 30 };
      const result = EventValidator.validatePayload(validPayload, schema);
      
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject invalid payload against custom schema', () => {
      const schema = require('joi').object({
        name: require('joi').string().required(),
        age: require('joi').number().integer().min(0).required()
      });
      
      const invalidPayload = { name: '', age: -5 };
      const result = EventValidator.validatePayload(invalidPayload, schema);
      
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
