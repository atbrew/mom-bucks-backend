/**
 * Cloud Functions barrel.
 *
 * Real handlers are added here as they land in Phase 4 issues #13–#18:
 *   acceptInvite, removeParentFromChildren, onTransactionCreate,
 *   onChildDelete, sendHabitNotifications, sendChildPush.
 *
 * helloWorld (issue #8) stays as a permanent health probe.
 */

export { helloWorld } from "./helloWorld";
