import { ContractMetadataController } from './contractMetadata.controller';
import { contractMetadataService } from './contractMetadata.service';
import { AuthenticatedRequest } from '../../middleware/auth';

jest.mock('./contractMetadata.service', () => ({
  contractMetadataService: {
    list: jest.fn(),
    getById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn()
  }
}));

function createMockResponse() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.end = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  return res;
}

describe('ContractMetadataController ETag support', () => {
  const controller = new ContractMetadataController();
  const mockedService = contractMetadataService as jest.Mocked<typeof contractMetadataService>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns ETag for list and responds 304 when If-None-Match matches', async () => {
    const payload = {
      records: [
        {
          id: 'meta-1',
          contract_id: 'contract-1',
          key: 'k',
          value: 'v',
          data_type: 'string' as const,
          is_sensitive: false,
          created_by: 'demo-user-id',
          updated_by: undefined,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z'
        }
      ],
      total: 1,
      page: 1,
      limit: 20
    };

    mockedService.list.mockResolvedValue(payload);

    const req1 = {
      user: { id: 'demo-user-id', role: 'user' },
      params: { contractId: 'contract-1' },
      query: {}
    } as unknown as AuthenticatedRequest;
    const res1 = createMockResponse();

    await controller.list(req1, res1);

    expect(res1.setHeader).toHaveBeenCalledWith('ETag', expect.any(String));
    expect(res1.json).toHaveBeenCalledWith(payload);

    const etag = res1.setHeader.mock.calls[0][1] as string;

    const req2 = {
      user: { id: 'demo-user-id', role: 'user' },
      params: { contractId: 'contract-1' },
      query: {},
      headers: { 'if-none-match': etag }
    } as unknown as AuthenticatedRequest;
    const res2 = createMockResponse();

    await controller.list(req2, res2);

    expect(res2.status).toHaveBeenCalledWith(304);
    expect(res2.end).toHaveBeenCalled();
    expect(res2.json).not.toHaveBeenCalled();
  });

  it('returns ETag for getById and responds 304 when If-None-Match matches', async () => {
    const payload = {
      id: 'meta-1',
      contract_id: 'contract-1',
      key: 'k',
      value: 'v',
      data_type: 'string' as const,
      is_sensitive: false,
      created_by: 'demo-user-id',
      updated_by: undefined,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z'
    };

    mockedService.getById.mockResolvedValue(payload);

    const req1 = {
      user: { id: 'demo-user-id', role: 'user' },
      params: { id: 'meta-1' },
      headers: {}
    } as unknown as AuthenticatedRequest;
    const res1 = createMockResponse();

    await controller.getById(req1, res1);

    expect(res1.setHeader).toHaveBeenCalledWith('ETag', expect.any(String));
    expect(res1.json).toHaveBeenCalledWith(payload);

    const etag = res1.setHeader.mock.calls[0][1] as string;
    const req2 = {
      user: { id: 'demo-user-id', role: 'user' },
      params: { id: 'meta-1' },
      headers: { 'if-none-match': etag }
    } as unknown as AuthenticatedRequest;
    const res2 = createMockResponse();

    await controller.getById(req2, res2);

    expect(res2.status).toHaveBeenCalledWith(304);
    expect(res2.end).toHaveBeenCalled();
    expect(res2.json).not.toHaveBeenCalled();
  });
});
