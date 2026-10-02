export interface LoginRequestDto {
  email: string;
  password: string;
}

export interface RegisterRequestDto {
  email: string;
  password: string;
  username: string;
  role?: string;
}

export interface RefreshRequestDto {
  refreshToken: string;
}

export interface AuthTokensResponseDto {
  accessToken: string;
  refreshToken: string;
}

export interface LogoutResponseDto {
  message: string;
}

export function mapLoginRequest(body: unknown): LoginRequestDto {
  const data = body as Record<string, unknown>;
  return {
    email: String(data.email || ''),
    password: String(data.password || ''),
  };
}

export function mapRegisterRequest(body: unknown): RegisterRequestDto {
  const data = body as Record<string, unknown>;
  return {
    email: String(data.email || ''),
    password: String(data.password || ''),
    username: String(data.username || ''),
    role: data.role !== undefined ? String(data.role) : undefined,
  };
}

export function mapRefreshRequest(body: unknown): RefreshRequestDto {
  const data = body as Record<string, unknown>;
  return {
    refreshToken: String(data.refreshToken || ''),
  };
}

export function mapAuthTokensResponse(tokens: { accessToken: string; refreshToken: string }): AuthTokensResponseDto {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  };
}

export function mapLogoutResponse(): LogoutResponseDto {
  return {
    message: 'Logged out successfully',
  };
}
