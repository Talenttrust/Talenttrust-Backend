import {
  mapLoginRequest,
  mapRegisterRequest,
  mapRefreshRequest,
  mapAuthTokensResponse,
  mapLogoutResponse
} from './auth.dto';

describe('Auth DTO Mappers', () => {
  describe('mapLoginRequest', () => {
    it('maps correctly with all fields', () => {
      const result = mapLoginRequest({ email: 'test@tt.com', password: 'password123' });
      expect(result).toEqual({ email: 'test@tt.com', password: 'password123' });
    });
    
    it('handles missing fields safely', () => {
      const result = mapLoginRequest({});
      expect(result).toEqual({ email: '', password: '' });
    });
  });

  describe('mapRegisterRequest', () => {
    it('maps correctly with all fields', () => {
      const result = mapRegisterRequest({ 
        email: 'test@tt.com', 
        password: 'password123', 
        username: 'testuser',
        role: 'freelancer'
      });
      expect(result).toEqual({ 
        email: 'test@tt.com', 
        password: 'password123', 
        username: 'testuser',
        role: 'freelancer'
      });
    });

    it('handles missing optional fields safely', () => {
      const result = mapRegisterRequest({ 
        email: 'test@tt.com', 
        password: 'password123', 
        username: 'testuser'
      });
      expect(result).toEqual({ 
        email: 'test@tt.com', 
        password: 'password123', 
        username: 'testuser',
        role: undefined
      });
    });
    
    it('handles missing required fields safely', () => {
      const result = mapRegisterRequest({});
      expect(result).toEqual({ 
        email: '', 
        password: '', 
        username: '',
        role: undefined
      });
    });
  });

  describe('mapRefreshRequest', () => {
    it('maps correctly with all fields', () => {
      const result = mapRefreshRequest({ refreshToken: 'some-token' });
      expect(result).toEqual({ refreshToken: 'some-token' });
    });

    it('handles missing fields safely', () => {
      const result = mapRefreshRequest({});
      expect(result).toEqual({ refreshToken: '' });
    });
  });

  describe('mapAuthTokensResponse', () => {
    it('maps tokens correctly', () => {
      const result = mapAuthTokensResponse({ accessToken: 'acc', refreshToken: 'ref' });
      expect(result).toEqual({ accessToken: 'acc', refreshToken: 'ref' });
    });
  });

  describe('mapLogoutResponse', () => {
    it('returns standard logout message', () => {
      const result = mapLogoutResponse();
      expect(result).toEqual({ message: 'Logged out successfully' });
    });
  });
});
