import type { Playbook, PlaybookId } from './types.js';
import { disableUser } from './playbooks/disable-user.js';
import { revokeSessions } from './playbooks/revoke-sessions.js';
import { deleteInboxRule } from './playbooks/delete-inbox-rule.js';
import { blockIp } from './playbooks/block-ip.js';
import { forcePasswordReset } from './playbooks/force-password-reset.js';
import { isolateDevice } from './playbooks/isolate-device.js';

export const PLAYBOOKS: Readonly<Record<PlaybookId, Playbook>> = {
  disable_user: disableUser,
  revoke_sessions: revokeSessions,
  delete_inbox_rule: deleteInboxRule,
  block_ip: blockIp,
  force_password_reset: forcePasswordReset,
  isolate_device: isolateDevice,
};

export function getPlaybook(id: string): Playbook | undefined {
  return Object.prototype.hasOwnProperty.call(PLAYBOOKS, id) ? PLAYBOOKS[id as PlaybookId] : undefined;
}
