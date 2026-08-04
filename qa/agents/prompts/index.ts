import type { QaRole } from '../../config/roles.ts';
import { ACCOUNTANT_ROLE_PROMPT } from './accountant.ts';
import { KITCHEN_ROLE_PROMPT } from './kitchen.ts';
import { OFFICE_ROLE_PROMPT } from './office.ts';
import { OWNER_ROLE_PROMPT } from './owner.ts';
import { PAYER_ROLE_PROMPT } from './payer.ts';
import { SUPPLIER_ROLE_PROMPT } from './supplier.ts';
import type { RolePrompt } from './common.ts';

export const ROLE_PROMPTS: Readonly<Record<QaRole, RolePrompt>> = {
  supplier: SUPPLIER_ROLE_PROMPT,
  kitchen: KITCHEN_ROLE_PROMPT,
  office: OFFICE_ROLE_PROMPT,
  owner: OWNER_ROLE_PROMPT,
  payer: PAYER_ROLE_PROMPT,
  accountant: ACCOUNTANT_ROLE_PROMPT,
};

export function rolePromptFor(role: QaRole): RolePrompt {
  return ROLE_PROMPTS[role];
}

export { renderRoleInstructions } from './common.ts';
export type { RolePrompt } from './common.ts';
