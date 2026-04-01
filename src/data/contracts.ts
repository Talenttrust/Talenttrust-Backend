/**
 * Contract resource interface.
 */
export interface Contract {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'pending' | 'completed' | 'cancelled';
  value: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Sample contract data for testing and demonstration.
 */
export const contracts: Contract[] = [
  {
    id: '1',
    title: 'Website Redesign',
    description: 'Redesign the corporate website with modern aesthetics.',
    status: 'active',
    value: 5000,
    createdAt: '2023-10-01T10:00:00Z',
    updatedAt: '2023-10-05T12:00:00Z',
  },
  {
    id: '2',
    title: 'Mobile App Development',
    description: 'Develop a cross-platform mobile app for clients.',
    status: 'pending',
    value: 12000,
    createdAt: '2023-11-15T09:30:00Z',
    updatedAt: '2023-11-15T09:30:00Z',
  },
  {
    id: '3',
    title: 'Cloud Migration',
    description: 'Migrate on-premise servers to AWS.',
    status: 'completed',
    value: 8500,
    createdAt: '2023-09-20T14:00:00Z',
    updatedAt: '2023-11-20T16:45:00Z',
  },
  {
    id: '4',
    title: 'Security Audit',
    description: 'Perform a comprehensive security audit of the infrastructure.',
    status: 'active',
    value: 3000,
    createdAt: '2024-01-10T11:00:00Z',
    updatedAt: '2024-01-12T15:00:00Z',
  },
  {
    id: '5',
    title: 'Data Analytics Platform',
    description: 'Build a data analytics dashboard for business intelligence.',
    status: 'active',
    value: 15000,
    createdAt: '2023-12-05T08:00:00Z',
    updatedAt: '2023-12-10T10:00:00Z',
  },
];
