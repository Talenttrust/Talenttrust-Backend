export interface ContractMetadata {
  id: string;
  contract_id: string;
  key: string;
  value: string;
  data_type: 'string' | 'number' | 'boolean' | 'json';
  is_sensitive: boolean;
  created_by: string;
  updated_by?: string;
  created_at: Date;
  updated_at: Date;
  deleted_at?: Date;
}

export interface Contract {
  id: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  deleted_at?: Date;
}

export interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
}

export interface ApiKey {
  id: string;
  name: string;
  key_hash: string;
  key_selector?: string;
  scope: string[];
  created_by: string;
  created_at: Date;
  updated_at: Date;
  expires_at?: Date;
  last_used_at?: Date;
  is_active: boolean;
}

export interface Database {
  contract_metadata: ContractMetadata[];
  contracts: Contract[];
  users: User[];
  api_keys: ApiKey[];
}
