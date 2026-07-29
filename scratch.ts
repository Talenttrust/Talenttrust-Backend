import { validateCreateAuditEntryInput } from './src/audit/inputValidation';
try {
  console.log(validateCreateAuditEntryInput({ action: 'NOT_AN_ACTION' }));
} catch (e) {
  console.error('ERROR', e);
}
