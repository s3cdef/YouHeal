// Role-based access control (AC-3, AC-6). Roles per CONTRACT §5:
//   admin        clinic owner — superset of practitioner (small clinics: the owner practices) + user/org admin
//   practitioner biomagnetist / MD — patients, sessions, findings, reports
//   assistant    front desk — patients + intake/consents + session summaries; NO findings / clinical detail
//   auditor      read-only audit log + reports; NO patient directory
import { forbidden } from './http.js';

export const ROLES = Object.freeze(['admin', 'practitioner', 'assistant', 'auditor']);

export const PERM = Object.freeze({
  patientRead: ['admin', 'practitioner', 'assistant'],
  patientWrite: ['admin', 'practitioner', 'assistant'],
  consentWrite: ['admin', 'practitioner', 'assistant'],
  sessionList: ['admin', 'practitioner', 'assistant'], // assistant receives summaries only
  clinicalRead: ['admin', 'practitioner'],
  clinicalWrite: ['admin', 'practitioner'],
  reportRead: ['admin', 'practitioner', 'auditor'],
  auditRead: ['admin', 'auditor'],
  admin: ['admin'],
});

export function requireRole(user, roles) {
  if (!user || !roles.includes(user.role)) throw forbidden();
}
export const hasRole = (user, roles) => Boolean(user && roles.includes(user.role));
