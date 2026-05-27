# Data Retention Controls

## Overview

The Data Retention Controls module provides a comprehensive system for managing data lifecycle, compliance, and archival requirements. It enables organizations to implement configurable retention policies, automatic archival, and compliance auditing across all data entities.

## Key Features

- **Configurable Retention Policies**: Define retention periods and archival strategies for different data types
- **Automatic Data Lifecycle Management**: Automatically archive and delete data based on policies
- **Compliance Auditing**: Complete audit trail of all retention operations for regulatory compliance
- **Data Classification**: Apply security controls based on data sensitivity levels
- **Flexible Storage Architecture**: Support for multiple storage backends (local, cloud, encrypted, cold storage)
- **GDPR and CCPA Ready**: Built with compliance frameworks in mind

## Architecture

The retention system is composed of four main components:

### 1. **RetentionPolicyEngine** (`src/retention/policies.ts`)
Manages the creation, validation, and enforcement of retention policies. Determines when data should be archived or deleted based on configured rules.

**Key Methods:**
- `createPolicy()` - Create and register a retention policy
- `updatePolicy()` - Update existing policies
- `calculateExpirationDate()` - Compute when data expires
- `determineRetentionStatus()` - Check current retention status
- `shouldArchive()` / `shouldPermanentlyDelete()` - Determine action needed

### 2. **StorageManager** (`src/retention/storage.ts`)
Provides an abstraction layer for data storage with support for multiple backends. Handles data persistence and archival storage operations.

**Key Methods:**
- `store()` - Save data to storage
- `retrieve()` - Fetch data from storage
- `moveData()` - Transfer data between storage types
- `delete()` - Remove data

### 3. **DataArchivalService** (`src/retention/archival.ts`)
Manages the secure archival of data, including encryption, storage management, and restoration of archived data.

**Key Methods:**
- `archiveData()` - Move data to archival storage
- `restoreArchivedData()` - Restore data from archive
- `getArchivedData()` - Retrieve archived data
- `permanentlyDeleteArchived()` - Securely delete archived data

### 4. **ComplianceAuditLogger** (`src/retention/audit.ts`)
Maintains an immutable audit trail of all retention-related operations for compliance verification and forensic investigation.

**Key Methods:**
- `logAction()` - Record retention action
- `getLogsForEntity()` - Retrieve audit trail for data
- `queryLogs()` - Search audit logs with filters
- `getComplianceReport()` - Generate compliance summary

## Usage Examples

### Initialize Data Retention Manager

```typescript
import { DataRetentionManager, RetentionConfig } from './retention';

const config: RetentionConfig = {
  enabled: true,
  storageBasePath: '/data',
  archiveBasePath: '/archive',
  checksIntervalMs: 3600000, // 1 hour
  batchSize: 100,
  automaticArchival: true,
  automaticDeletion: false,
  postArchivalRetentionDays: 30,
  complianceStandard: 'GDPR',
  encryptionEnabled: true,
};

const manager = new DataRetentionManager(config);
```

### Create Retention Policies

```typescript
// Create a policy for contracts with 2-year retention
const contractPolicy = manager.createRetentionPolicy({
  name: 'Contract Retention',
  description: 'Retain contracts for legal compliance',
  entityType: DataEntityType.CONTRACT,
  period: RetentionPeriod.TWO_YEARS,
  classification: DataClassification.CONFIDENTIAL,
  archivalType: ArchivalStorageType.COLD_STORAGE,
  encryptArchive: true,
  allowPermanentRetention: false,
  isActive: true,
});

// Set as default for contracts
manager.setDefaultPolicy(DataEntityType.CONTRACT, contractPolicy.id);
```

### Store Data with Retention

```typescript
const { data, policy } = await manager.storeData(
  {
    entityType: DataEntityType.CONTRACT,
    data: contractDetails,
    classification: DataClassification.CONFIDENTIAL,
    createdAt: new Date(),
  },
  contractPolicy.id,
  'user@example.com' // Actor for audit trail
);

console.log(`Data stored with ID: ${data.id}`);
console.log(`Expires at: ${data.expiresAt}`);
```

### Check Retention Status

```typescript
const status = await manager.getRetentionStatus(dataId);

if (status.needsAction) {
  console.log(`Action required: ${status.actionRequired}`);
  console.log(`Days until expiry: ${status.daysUntilExpiry}`);
}
```

### Archive Expired Data

```typescript
// Manual archival
const result = await manager.archiveData(dataId, 'admin');

if (result.success) {
  console.log(`Data archived at: ${result.archivedAt}`);
  console.log(`Location: ${result.location}`);
}

// Or enable automatic archival
manager.startAutomatedProcessing();
```

### Compliance Auditing

```typescript
// Get audit logs for specific data
const logs = manager.getAuditLogs({ entityId: dataId });

logs.forEach(log => {
  console.log(`${log.action} by ${log.actor} at ${log.timestamp}`);
});

// Generate compliance report
const report = manager.getComplianceReport();
console.log(`GDPR violations: ${report.GDPR.count}`);

// Export for compliance review
const auditTrail = manager.exportAuditTrail({
  compliance: 'GDPR',
  startDate: new Date('2024-01-01'),
});
```

## Configuration Options

### RetentionConfig Interface

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | true | Enable retention controls |
| `storageBasePath` | string | `/data` | Base path for active data storage |
| `archiveBasePath` | string | `/archive` | Base path for archived data |
| `checksIntervalMs` | number | 3600000 | Interval for automated checks (ms) |
| `batchSize` | number | 100 | Records to process per batch |
| `automaticArchival` | boolean | true | Auto-archive expired data |
| `automaticDeletion` | boolean | false | Auto-delete post-archival data |
| `postArchivalRetentionDays` | number | 30 | Days to keep archived data before deletion |
| `complianceStandard` | string | `GDPR` | Primary compliance framework |
| `encryptionEnabled` | boolean | true | Enable encryption for sensitive data |

## Data Classification Levels

```typescript
enum DataClassification {
  PUBLIC = 'public',              // No restrictions
  INTERNAL = 'internal',          // Internal use only
  CONFIDENTIAL = 'confidential',  // Sensitive business data
  RESTRICTED = 'restricted',      // Highest sensitivity (PII, etc.)
}
```

**Security Controls by Classification:**
- **PUBLIC**: Minimal controls, local archival
- **INTERNAL**: Standard controls, cold storage archival
- **CONFIDENTIAL**: Encryption required for archives
- **RESTRICTED**: Mandatory encryption, encrypted archive storage

## Retention Periods

```typescript
enum RetentionPeriod {
  THIRTY_DAYS = '30d',
  NINETY_DAYS = '90d',
  SIX_MONTHS = '6m',
  ONE_YEAR = '1y',
  TWO_YEARS = '2y',
  INDEFINITE = 'indefinite',
}
```

## Storage Types

```typescript
enum ArchivalStorageType {
  LOCAL = 'local',                        // Local filesystem
  CLOUD = 'cloud',                        // Cloud storage
  COLD_STORAGE = 'cold_storage',          // Long-term archive
  ENCRYPTED_ARCHIVE = 'encrypted_archive', // Encrypted archival
}
```

## API Endpoints

### Policy Management

**POST** `/api/v1/retention/policies`
- Create a new retention policy
- Request body: Policy configuration
- Returns: Created policy with ID and timestamps

**GET** `/api/v1/retention/policies`
- Retrieve all active policies
- Returns: Array of active policies

### Data Management

**POST** `/api/v1/retention/data`
- Store data with retention policy
- Request body: `{ data, policyId?, actor }`
- Returns: Stored data with expiration information

**GET** `/api/v1/retention/data/:dataId`
- Retrieve stored data
- Returns: Data and metadata

**GET** `/api/v1/retention/status/:dataId`
- Get retention status and action items
- Returns: Retention status with expiration info

### Compliance

**GET** `/api/v1/retention/audit-logs`
- Retrieve audit logs
- Query params: `entityId?`, `action?`, `startDate?`, `endDate?`
- Returns: Array of audit log entries

**GET** `/api/v1/retention/compliance-report`
- Generate compliance summary
- Returns: Report grouped by compliance standard

## Compliance Features

### GDPR Compliance

- **Data Retention**: Configurable period with indefinite retention option
- **Right to Erasure**: Support for manual deletion and restoration
- **Audit Trail**: Complete history of all data operations
- **Data Classification**: Automatic controls based on sensitivity

### CCPA Compliance

- **Data Inventory**: Track all stored personal information
- **Retention Schedules**: Clear deletion timelines
- **Access Logs**: Who accessed data and when
- **Deletion Verification**: Confirm permanent deletion completion

## Security Considerations

### Encryption

- Restricted and confidential data automatically encrypted when archived
- Encryption enabled by default in `RetentionConfig`
- All encryption happens at archival, original data remains unencrypted

### Audit Logging

- Every retention action is logged immutably
- Actor information captured for accountability
- Timestamp precision for forensic analysis
- Compliance standard tracking

### Storage Isolation

- Active data and archives stored separately
- Cold storage for long-term retention
- Support for dedicated encryption backends
- Storage type mapping based on data classification

## Testing

### Unit Tests (`src/retention/retention.test.ts`)

Comprehensive coverage of individual components:
- RetentionPolicyEngine
- StorageManager
- DataArchivalService
- ComplianceAuditLogger
- DataRetentionManager

**Test Coverage:**
- Policy creation and validation
- Expiration calculation
- Archival workflows
- Audit logging
- Error handling

**Run tests:**
```bash
npm test src/retention/retention.test.ts
```

### Integration Tests (`src/retention/integration.test.ts`)

End-to-end workflows:
- Complete data lifecycle
- Multiple policies
- Archival and restoration
- Compliance reporting
- Classification-based controls
- Error scenarios

**Run tests:**
```bash
npm test src/retention/integration.test.ts
```

**Coverage Goal:** 95%+ for retention module

## Performance Considerations

### Batch Processing

- Configure `batchSize` for large datasets
- Automated checks run at configured `checksIntervalMs`
- Default: 1 hour interval, 100 records per batch

### Storage Optimization

- Cold storage for archived data reduces active storage costs
- Post-archival retention (default 30 days) allows safety period
- Encryption overhead: ~5-10% for archive storage

### Scalability

- In-memory storage suitable for development
- Production should use persistent storage provider
- Streaming support for large-scale exports

## Extending the System

### Custom Storage Providers

```typescript
class CustomStorageProvider implements IStorageProvider {
  async store(data: RetainedData): Promise<string> {
    // Implement storage logic
  }

  async retrieve(id: string): Promise<RetainedData | null> {
    // Implement retrieval logic
  }

  // ... implement other methods
}

const manager = new DataRetentionManager(
  config,
  customLocalProvider,
  customArchiveProvider
);
```

### Custom Policies

Subclass `RetentionPolicyEngine` to add custom business logic:

```typescript
class CustomPolicyEngine extends RetentionPolicyEngine {
  determineRetentionStatus(data: RetainedData): RetentionStatus {
    // Custom logic here
    return super.determineRetentionStatus(data);
  }
}
```

## Maintenance

### Regular Tasks

1. **Monitor archived data**: Track storage usage
2. **Review audit logs**: Quarterly compliance audits
3. **Test restoration**: Verify archive integrity
4. **Update policies**: Adjust retention periods as needed

### Disaster Recovery

- All audit logs are immutable and tamper-proof
- Archive locations tracked in metadata
- Retention status snapshots available for recovery

## Troubleshooting

### Data Not Archiving

1. Check expiration date: `getRetentionStatus()`
2. Verify policy is active
3. Ensure archival storage is writable
4. Check encryption configuration

### Audit Logs Not Found

1. Confirm retention is enabled
2. Check compliance standard matches filter
3. Verify timestamp filters (UTC)
4. Use `exportAuditTrail()` for raw export

### Performance Issues

1. Reduce `batchSize` for slower systems
2. Increase `checksIntervalMs` to reduce frequency
3. Consider async/worker processing for large datasets
4. Monitor storage provider performance

## Future Enhancements

- [ ] Direct database integration
- [ ] Multi-region replication support
- [ ] Advanced encryption with key rotation
- [ ] ML-based retention optimization
- [ ] blockchain-based audit trail immutability
- [ ] Real-time compliance dashboards

## License

MIT

## Support

For issues, questions, or recommendations, please open an issue in the repository.
