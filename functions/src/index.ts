/**
 * Cloud Functions barrel.
 *
 * helloWorld stays as a permanent health probe (Phase 0, issue #8).
 * Every other export is a Phase 4 handler:
 *
 *   #13 acceptInvite             — callable
 *       sendInvite               — callable (create, was client write)
 *       revokeInvite             — callable (delete, was client write)
 *   #14 removeParentFromChildren — callable
 *       revertTransaction        — callable
 *   #15 onTransactionCreate      — Firestore trigger (balance recompute)
 *   #16 onChildDelete            — Firestore trigger (cascade cleanup)
 *   #17 sendHabitNotifications   — scheduled (replaces APScheduler)
 *   #18 onTransactionPush        — Firestore trigger (FCM fan-out on transaction)
 *   #18 onActivityPush           — Firestore trigger (FCM fan-out on activity)
 *       onProfileImageUpload     — Storage trigger (resize + photoUrl update)
 *       onUserCreated            — Auth trigger (create users/{uid} doc)
 *       onUserDeleted            — Auth trigger (delete users/{uid}/profile.jpg)
 */

export { helloWorld } from "./helloWorld";

export { acceptInvite } from "./handlers/acceptInvite";
export { sendInvite } from "./handlers/sendInvite";
export { revokeInvite } from "./handlers/revokeInvite";
export { removeParentFromChildren } from "./handlers/removeParentFromChildren";
export { revertTransaction } from "./handlers/revertTransaction";
export { createActivity } from "./handlers/createActivity";
export { updateActivity } from "./handlers/updateActivity";
export { deleteActivity } from "./handlers/deleteActivity";
export { claimActivity } from "./handlers/claimActivity";
export { onTransactionCreate } from "./handlers/onTransactionCreate";
export { onChildDelete } from "./handlers/onChildDelete";
export { sendHabitNotifications } from "./handlers/sendHabitNotifications";
export { onTransactionPush, onActivityPush } from "./handlers/sendChildPush";
export { onProfileImageUpload } from "./handlers/onProfileImageUpload";
export { onUserCreated } from "./handlers/onUserCreated";
export { onUserDeleted } from "./handlers/onUserDeleted";
