export interface CreateContractMetadataRequest {
  key: string;
  value: string;
  data_type?: 'string' | 'number' | 'boolean' | 'json';
  is_sensitive?: boolean;
}

export interface UpdateContractMetadataRequest {
  value?: string;
  is_sensitive?: boolean;
}

export interface ContractMetadataResponse {
  id: string;
  contract_id: string;
  key: string;
  value: string;
  data_type: 'string' | 'number' | 'boolean' | 'json';
  is_sensitive: boolean;
  created_by: string;
  updated_by?: string;
  created_at: string;
  updated_at: string;
}

export interface ContractMetadataListResponse {
  records: ContractMetadataResponse[];
  total: number;
  page: number;
  limit: number;
}

export interface PaginationQuery {
  page?: string;
  limit?: string;
  key?: string;
  data_type?: string;
}
