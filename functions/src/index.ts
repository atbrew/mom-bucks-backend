/**
 * Cloud Functions barrel.
 *
 * helloWorld stays as a permanent health probe (Phase 0, issue #8).
 * Every other export is a Phase 4 handler:
 *
 *   #13 acceptInvite             — callable
 *   #14 removeParentFromChildren — callable
 *   #15 onTransactionCreate      — Firestore trigger (balance recompute)
 *   #16 onChildDelete            — Firestore trigger (cascade cleanup)
 *   #17 sendHabitNotifications   — scheduled (replaces APScheduler)
 *   #18 onTransactionPush        — Firestore trigger (FCM fan-out on transaction)
 *   #18 onActivityPush           — Firestore trigger (FCM fan-out on activity)
 */

export { helloWorld } from "./helloWorld";

export { acceptInvite } from "./handlers/acceptInvite";
export { removeParentFromChildren } from "./handlers/removeParentFromChildren";
export { onTransactionCreate } from "./handlers/onTransactionCreate";
export { onChildDelete } from "./handlers/onChildDelete";
export { sendHabitNotifications } from "./handlers/sendHabitNotifications";
export { onTransactionPush, onActivityPush } from "./handlers/sendChildPush";
