/**
 * @notice Contract metadata stored and returned by the TalentTrust API.
 */
export interface ContractRecord {
  id: string;
  title: string;
  clientId: string;
  freelancerId: string;
  budget: number;
  currency: string;
  createdAt: string;
}

/**
 * @notice Input payload required to create a contract record.
 */
export interface CreateContractInput {
  title: string;
  clientId: string;
  freelancerId: string;
  budget: number;
  currency: string;
}
