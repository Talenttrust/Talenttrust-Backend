import { v4 as uuidv4 } from 'uuid';

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

export interface Database {
  contract_metadata: ContractMetadata[];
  contracts: Contract[];
  users: User[];
}
