export interface Contract {
  id: string;
  status?: string;
}

export interface ContractsPayload {
  contracts: Contract[];
}
