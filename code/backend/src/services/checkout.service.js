// AI-USAGE SUMMARY
// Tools: Claude Code
// Overall AI Contribution: ~90% (skeleton generated from team design documents)
// AI-Assisted Areas: SCRUM-148 submit() asks the approval policy and can create a request APPROVED (unit HELD); the single F4 state-transition table + assertTransition guard with unit side-effects; submit()/approve()/deny()/cancel()/list()/get() implemented; submit() now reserves the unit (AVAILABLE -> REQUESTED) with a compare-and-set, and deny()/cancel() release it back; submit() now enforces restricted-equipment eligibility via group.service.isActiveMember (SCRUM-149); submit() and approve() both check group.service.isEligible over allowedGroupIds (SCRUM-150, AT-3); SCRUM-205 custody confirmation: borrower-recorded pickup, initiateReturn/rejectReturn, canConfirmReturn on every return path, expireApprovals with a system-actor audit entry; SCRUM-225 refactor: Extract Function on the duplicated handler preamble (loadRequest/loadOwnRequest/isRequester, assertMayDecide) and on the compare-and-set (commitTransition) — no behaviour change
// Human Contributions: reviewed by Amber Rastella (PR #7, 2026-09-18); reviewed and approved by Amber Rastella (PR #7, 2026-09-18); latest changes reviewed and approved by Mateus Silva (PR #64, 2026-10-04); CI passed on merge: lint, format, unit + integration tests, npm audit, Docker build, CodeQL
// Notes: Generated from SDD v0.1, SPPP, NFR doc, Sprint 1 backlog.

/**
 * The checkout state machine, and the request handlers built on it.
 *
 * `TRANSITIONS` is the authority on what a checkout request may do next. Every handler goes through
 * `assertTransition()`; nothing else may change `CheckoutRequest.state`. Keeping the table in one
 * place means the legal moves can be read — and tested — without tracing the code that performs them.
 *
 * Each transition also names the AssetUnit side-effect that happens with it: approving holds a unit,
 * checkout sends it out, returning or cancelling frees it. Both writes belong to the same transaction
 * as the state change and its audit event, so a failed step can never leave a unit half-checked-out
 * (NFR-2).
 *
 * `submit`/`approve`/`deny`/`cancel`/`checkout`/`returnUnit`/`get`/`list` are all implemented (see
 * each one's own doc comment for how visibility or ownership is scoped). `approve`/`deny` apply the
 * organisation's approval policy (separation of duties); `cancel` is stricter still — the requester
 * only, no role-based exception.
 *
 * Custody confirmation (SCRUM-205): each change of custody is recorded by the side that can verify
 * it. `checkout` may be recorded by the borrower or by anyone holding `requests:handoff`.
 * `initiateReturn` is the borrower saying the item is back; it moves the request to RETURN_PENDING but
 * leaves the unit OUT. `returnUnit` and `rejectReturn` close or refuse it, and both ask the policy's
 * `canConfirmReturn`, so nobody confirms their own return unless nobody else could.
 * `expireApprovals` frees units whose approval nobody collected.
 *
 * Every handler is assembled from the same four private steps, which sit together above `submit`:
 * `loadRequest`/`loadOwnRequest` read the request or refuse with 404, `assertMayDecide` and
 * `assertMayConfirmReturn` ask the policy who may act, and `commitTransition` performs the
 * compare-and-set. They exist once rather than once per handler, so the 404-not-403 rule, the
 * separation-of-duties check and the race handling each have a single definition to read and to
 * change (SCRUM-225).
 *
 * Exports: `TRANSITIONS`, `TERMINAL_STATES`, `assertTransition`, `canTransition`, and the handlers
 * `submit`, `list`, `get`, `approve`, `deny`, `cancel`, `checkout`, `initiateReturn`, `returnUnit`,
 * `rejectReturn`, `markOverdue`, `expireApprovals`.
 */
import { withTransaction } from '../config/db.js';
import * as assetRepo from '../repositories/asset.repository.js';
import * as assetUnitRepo from '../repositories/assetUnit.repository.js';
import * as checkoutRequestRepo from '../repositories/checkoutRequest.repository.js';
import * as organizationRepo from '../repositories/organization.repository.js';
import * as userRepo from '../repositories/user.repository.js';
import {
  AUDIT_ACTION,
  AUDIT_TARGET_TYPE,
  DEFAULT_PICKUP_GRACE_HOURS,
  REQUEST_STATE as S,
  UNIT_STATUS as U,
} from '../utils/constants.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  StateTransitionError,
} from '../utils/errors.js';
import { PERMISSIONS, ROLES, roleHasPermission } from '../utils/permissions.js';
import * as auditService from './audit.service.js';
import { isEligible } from './group.service.js';
import {
  canConfirmReturn as defaultCanConfirmReturn,
  policyFor,
} from './policies/approvalPolicy.js';

/**
 * THE state machine. Every handler below must go through assertTransition(); nothing else may
 * change CheckoutRequest.state. Each row lists the AssetUnit side-effect that happens in the same
 * transaction (NFR-2: a failed step never leaves a unit half-checked-out).
 *
 * from            → to              unit side-effect   audit action
 * PENDING         → APPROVED        unit HELD          REQUEST_APPROVED
 * PENDING         → DENIED          unit AVAILABLE     REQUEST_DENIED
 * PENDING         → CANCELLED       unit AVAILABLE     REQUEST_CANCELLED
 * APPROVED        → CANCELLED       unit AVAILABLE     REQUEST_CANCELLED
 * APPROVED        → CHECKED_OUT     unit OUT           ASSET_CHECKED_OUT
 * APPROVED        → EXPIRED         unit AVAILABLE     REQUEST_EXPIRED (system; expireApprovals)
 * CHECKED_OUT     → RETURN_PENDING  (none: still OUT)  RETURN_INITIATED
 * CHECKED_OUT     → RETURNED        unit AVAILABLE     ASSET_RETURNED (walk-in return)
 * CHECKED_OUT     → OVERDUE         (none)             (system; markOverdue — not audited, see there)
 * CHECKED_OUT     → LOST            unit RETIRED       (Iteration 2)
 * OVERDUE         → RETURN_PENDING  (none: still OUT)  RETURN_INITIATED
 * OVERDUE         → RETURNED        unit AVAILABLE     ASSET_RETURNED (walk-in return)
 * OVERDUE         → LOST            unit RETIRED       (Iteration 2)
 * RETURN_PENDING  → RETURNED        unit AVAILABLE     ASSET_RETURNED (confirmed)
 * RETURN_PENDING  → CHECKED_OUT     (none: still OUT)  RETURN_REJECTED
 *
 * RETURN_PENDING (SCRUM-205) is the borrower's word that the item is back, waiting for someone else's.
 * The unit stays OUT through it, so accountability does not end until a confirmer says so. A rejected
 * return goes back to CHECKED_OUT even if it had been OVERDUE: the next mark-overdue run flags it
 * again from its unchanged `dueAt`.
 *
 * Creating a request (submit()) is the one step with no row here: it moves a unit from AVAILABLE to
 * REQUESTED (PENDING) — or, when the approval policy auto-approves (SCRUM-148), straight to HELD
 * (APPROVED) — but that is a creation, not a move between two existing request states, so it has no
 * (from, to) pair to sit in this table. See submit()'s own doc comment. PENDING → DENIED and
 * PENDING → CANCELLED both release that reservation back to AVAILABLE — nothing was ever HELD, but
 * something was REQUESTED, and it must stop being so.
 */
export const TRANSITIONS = Object.freeze({
  [S.PENDING]: Object.freeze({
    [S.APPROVED]: Object.freeze({ unitStatus: U.HELD }),
    [S.DENIED]: Object.freeze({ unitStatus: U.AVAILABLE }),
    [S.CANCELLED]: Object.freeze({ unitStatus: U.AVAILABLE }),
  }),
  [S.APPROVED]: Object.freeze({
    [S.CANCELLED]: Object.freeze({ unitStatus: U.AVAILABLE }),
    [S.CHECKED_OUT]: Object.freeze({ unitStatus: U.OUT }),
    [S.EXPIRED]: Object.freeze({ unitStatus: U.AVAILABLE }),
  }),
  [S.CHECKED_OUT]: Object.freeze({
    [S.RETURN_PENDING]: Object.freeze({ unitStatus: null }),
    [S.RETURNED]: Object.freeze({ unitStatus: U.AVAILABLE }),
    [S.OVERDUE]: Object.freeze({ unitStatus: null }),
    [S.LOST]: Object.freeze({ unitStatus: U.RETIRED }),
  }),
  [S.OVERDUE]: Object.freeze({
    [S.RETURN_PENDING]: Object.freeze({ unitStatus: null }),
    [S.RETURNED]: Object.freeze({ unitStatus: U.AVAILABLE }),
    [S.LOST]: Object.freeze({ unitStatus: U.RETIRED }),
  }),
  [S.RETURN_PENDING]: Object.freeze({
    [S.RETURNED]: Object.freeze({ unitStatus: U.AVAILABLE }),
    [S.CHECKED_OUT]: Object.freeze({ unitStatus: null }),
  }),
  // Terminal states: no outgoing transitions.
  [S.DENIED]: Object.freeze({}),
  [S.CANCELLED]: Object.freeze({}),
  [S.RETURNED]: Object.freeze({}),
  [S.LOST]: Object.freeze({}),
  [S.EXPIRED]: Object.freeze({}),
});

/**
 * The states with no outgoing transitions: DENIED, CANCELLED, RETURNED, LOST, EXPIRED.
 *
 * Derived from the table rather than listed separately, so it cannot fall out of step with it.
 */
export const TERMINAL_STATES = Object.freeze(
  Object.keys(TRANSITIONS).filter((state) => Object.keys(TRANSITIONS[state]).length === 0),
);

/**
 * Assert that `from → to` is a legal move, and return its unit side-effect.
 *
 * The guard every transition handler passes through. Lookups use `Object.hasOwn` rather than plain
 * property access so that inherited names — `constructor`, `__proto__`, `toString` — cannot resolve
 * to a row: with a plain lookup, a state string taken from client input could reach Object.prototype
 * and produce a truthy "transition" that was never in the table.
 * @param {string} from current state
 * @param {string} to requested state
 * @returns {{ unitStatus: string|null }} the unit status to apply alongside, or null when there is none
 * @throws {StateTransitionError} (409) for any pair not in the table, including unknown states
 */
export function assertTransition(from, to) {
  // Own-property lookups only: 'constructor', '__proto__' etc. must never resolve to a row.
  const row = Object.hasOwn(TRANSITIONS, from) ? TRANSITIONS[from] : undefined;
  const effect = row && Object.hasOwn(row, to) ? row[to] : undefined;
  if (!effect) {
    throw new StateTransitionError(from, to);
  }
  return effect;
}

/**
 * Is `from → to` a legal move? The non-throwing form of `assertTransition`.
 *
 * For callers that need to *ask* rather than enforce — showing which buttons apply to a request, for
 * instance. Handlers use `assertTransition` instead, so an illegal move fails rather than being
 * skipped.
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  return Object.hasOwn(TRANSITIONS, from) && Object.hasOwn(TRANSITIONS[from], to);
}

/**
 * Is `actor` the person who opened `request`?
 *
 * Both sides are stringified before comparing: `requesterId` is an ObjectId read from the document
 * while `userId` is a string lifted off the access token, and those are never `===` even when they
 * name the same person.
 * @param {object} request
 * @param {{ userId: string }} actor
 * @returns {boolean}
 */
function isRequester(request, actor) {
  return String(request.requesterId) === String(actor.userId);
}

/**
 * Read a request, or refuse with 404 — the first line of almost every handler below.
 *
 * A request belonging to another organisation is already invisible here, because the repository
 * scopes the read by tenant; it arrives as `null` and is reported as missing, not forbidden (SR-2).
 * @param {string} orgId
 * @param {string} requestId
 * @returns {Promise<object>}
 * @throws {NotFoundError} (404) no such request in this organisation
 */
async function loadRequest(orgId, requestId) {
  const request = await checkoutRequestRepo.findById(orgId, requestId);
  if (!request) {
    throw new NotFoundError('Request not found');
  }
  return request;
}

/**
 * Read one of the actor's *own* requests, or refuse with 404.
 *
 * For the handlers the requester alone may use (`cancel`, `initiateReturn`). Someone else's request
 * is reported as missing rather than forbidden: those routes are open to every member, so a 403 would
 * let a member learn which ids exist simply by probing them (SR-2).
 * @param {string} orgId
 * @param {{ userId: string }} actor
 * @param {string} requestId
 * @returns {Promise<object>}
 * @throws {NotFoundError} (404) no such request, or the caller is not its requester
 */
async function loadOwnRequest(orgId, actor, requestId) {
  const request = await loadRequest(orgId, requestId);
  if (!isRequester(request, actor)) {
    throw new NotFoundError('Request not found');
  }
  return request;
}

/**
 * Refuse with 403 unless the organisation's approval policy lets `actor` decide this request.
 *
 * Separation of duties (SDD §6.4) is the policy's call, asked before anything is written. The
 * approve/deny counterpart of `assertMayConfirmReturn`, which does the same for the return pair.
 * @param {string} orgId
 * @param {object} request
 * @param {{ userId: string, role: string }} actor
 * @returns {Promise<void>}
 * @throws {ForbiddenError} (403) the actor's role can't decide, or the actor is the requester
 */
async function assertMayDecide(orgId, request, actor) {
  const org = await organizationRepo.findById(orgId);
  const decision = policyFor(org).canDecide(request, actor);
  if (!decision.allowed) {
    throw new ForbiddenError(decision.reason ?? 'Not allowed to decide this request');
  }
}

/**
 * Write the state change as a compare-and-set, or throw because someone else got there first.
 *
 * The move itself, shared by every handler. `expectedState` is re-checked at the database rather than
 * trusted from the handler's earlier read, so two callers racing to decide one request cannot both
 * win: the loser's update matches no document and is reported as a conflict.
 *
 * `to` is the only place the target state is named — it goes into the patch *and* into the error — so
 * the write and the message it fails with cannot drift apart. `expectedState` stays an explicit
 * argument rather than being inferred from the state already read: it is the handler's own statement
 * of which source state it will move from, and a row added to `TRANSITIONS` later must not quietly
 * widen that.
 * @param {string} orgId
 * @param {string} requestId
 * @param {{ from: string, to: string, expectedState: string, patch?: object, conflictMessage?: string }} move
 *   `from` is the state read before the transaction, named in the error for the client; `patch` is
 *   merged over `{ state: to }`; `conflictMessage` replaces the state-machine wording where a handler
 *   has something plainer to say about losing the race
 * @param {{ session?: import('mongoose').ClientSession }} [options]
 * @returns {Promise<object>} the updated request
 * @throws {ConflictError} (409) when `conflictMessage` is given and the request had moved on
 * @throws {StateTransitionError} (409) otherwise, when the request was no longer in `expectedState`
 */
async function commitTransition(orgId, requestId, move, { session } = {}) {
  const { from, to, expectedState, patch, conflictMessage } = move;
  const updated = await checkoutRequestRepo.transition(
    orgId,
    requestId,
    { expectedState, patch: { state: to, ...patch } },
    { session },
  );
  if (!updated) {
    throw conflictMessage ? new ConflictError(conflictMessage) : new StateTransitionError(from, to);
  }
  return updated;
}

/**
 * Open a checkout request (`POST /api/requests`).
 *
 * The unit is reserved with a compare-and-set write, inside the same transaction as the request
 * insert: if two members submit for the same unit at the same moment, the read they both do can agree
 * it's AVAILABLE, but only one of their writes can actually flip it, because the write itself
 * re-checks the status at the database rather than trusting the earlier read. The loser gets the same
 * 409 a request against an already-unavailable unit gets — from its point of view, it simply lost the
 * race.
 *
 * **Whether a human decides** is the organisation's approval policy's call (SCRUM-148), asked with
 * the unit's asset (for its per-asset override) and the organisation (for its default):
 *
 * - Approval required — the request is PENDING and the unit moves AVAILABLE → REQUESTED, waiting in
 *   the approver queue. This is the Iteration 1 path, unchanged.
 * - Auto-approved — the request is created directly in APPROVED and the unit moves AVAILABLE → HELD,
 *   exactly where an approver's decision would have left it. It does **not** go to CHECKED_OUT:
 *   handing the item over is still a physical event someone records (`checkout()`, SCRUM-120). Two
 *   audit events are written: REQUEST_SUBMITTED, then REQUEST_AUTO_APPROVED naming the policy, with
 *   the requester as actor and `decidedBy` left null, so the log never shows an approval nobody made.
 *
 * The policy is consulted inside the transaction, against the settings as they stand at that moment.
 * Changing a setting later has no effect on a request already created — it is not retroactive.
 *
 * A unit can still never back two open requests at once: whichever status the reservation writes,
 * the compare-and-set only succeeds from AVAILABLE.
 *
 * **Restricted equipment (SCRUM-149, SCRUM-150).** When the asset lists `allowedGroupIds`, the
 * requester must be an active member of at least one of those groups (`isEligible()`) — checked live,
 * here, before the policy is asked, so an auto-approving asset can never let an ineligible member skip
 * the check by having nothing to approve. "Active" excludes a deactivated member even though they
 * remain listed in the group (the user-groups ticket's own answer to that question): a deactivated
 * account must never reach a checkout outcome, privileged or not. The check runs inside this
 * transaction, against the same snapshot the rest of the write sees, so a membership change
 * mid-flight cannot race it. `approve()` asks the same question again (AT-3).
 * @param {string} orgId
 * @param {{ userId: string, role: string }} actor
 * @param {{ unitId: string, neededFrom: Date, neededTo: Date, note?: string, requestId?: string }} [input]
 *   validated `createRequestBody`, plus the HTTP request id for audit correlation
 * @returns {Promise<object>} the new request — PENDING, or APPROVED when auto-approved
 * @throws {NotFoundError} (404) no such unit in this organisation
 * @throws {ConflictError} (409) the unit is not AVAILABLE, including a lost race
 * @throws {ForbiddenError} (403) the asset is restricted to a group the requester is not an active member of
 */
export async function submit(orgId, actor, input = {}) {
  return withTransaction(async (session) => {
    const unit = await assetUnitRepo.findById(orgId, input.unitId, { session });
    if (!unit) {
      throw new NotFoundError('Unit not found');
    }
    if (unit.status !== U.AVAILABLE) {
      throw new ConflictError('That unit is no longer available');
    }

    // Sequential, not Promise.all: operations sharing one transaction session must not run in parallel.
    const asset = await assetRepo.findById(orgId, unit.assetId, { session });
    if (!(await isEligible(orgId, actor.userId, asset, { session }))) {
      throw new ForbiddenError('You are not eligible to request this asset');
    }
    const org = await organizationRepo.findById(orgId, { session });
    const policy = policyFor(org);
    const autoApprove = !policy.requiresApproval({ request: input, asset, org });

    const reserved = await assetUnitRepo.updateStatusIfCurrent(
      orgId,
      input.unitId,
      { from: U.AVAILABLE, to: autoApprove ? U.HELD : U.REQUESTED },
      { session },
    );
    if (!reserved) {
      // Someone else's submit reserved this unit between our read and this write.
      throw new ConflictError('That unit is no longer available');
    }

    const created = await checkoutRequestRepo.create(
      orgId,
      {
        unitId: input.unitId,
        requesterId: actor.userId,
        neededFrom: input.neededFrom,
        neededTo: input.neededTo,
        note: input.note ?? '',
      },
      {
        session,
        approval: autoApprove
          ? { state: S.APPROVED, decidedAt: new Date(), autoApproved: true }
          : undefined,
      },
    );

    await auditService.record(
      orgId,
      {
        actor,
        action: AUDIT_ACTION.REQUEST_SUBMITTED,
        targetType: AUDIT_TARGET_TYPE.CheckoutRequest,
        targetId: created._id,
        before: null,
        after: { state: S.PENDING, unitId: input.unitId },
        requestId: input.requestId,
      },
      { session },
    );

    if (autoApprove) {
      await auditService.record(
        orgId,
        {
          actor,
          action: AUDIT_ACTION.REQUEST_AUTO_APPROVED,
          targetType: AUDIT_TARGET_TYPE.CheckoutRequest,
          targetId: created._id,
          before: { state: S.PENDING },
          after: { state: S.APPROVED, policy: policy.name, decidedBy: null },
          requestId: input.requestId,
        },
        { session },
      );
    }

    return created;
  });
}

/**
 * List checkout requests (`GET /api/requests`).
 *
 * Every role holds `requests:read:own`, so nobody is blocked at the route — what differs is which
 * requests come back. Whether the caller sees the whole organisation is decided by two things
 * together, not by role alone: they must hold `requests:decide` (APPROVER, ORG_ADMIN) **and** have
 * explicitly asked for it with `scope: 'org'`. Omitted or `scope: 'own'` always means "my own
 * requests," for every role — that is what keeps an admin's "My requests" view showing their own
 * requests rather than the whole organisation's, even though the same admin can ask this same
 * endpoint for the organisation-wide view (the approval queue) by passing `scope: 'org'`.
 *
 * A caller who cannot decide requests but sends `scope: 'org'` anyway is not rejected — the flag is
 * simply ignored and they get their own requests, the same way a smuggled `orgId` elsewhere in the
 * API is ignored rather than treated as an error.
 *
 * `scope: 'others'` (SCRUM-205) is the organisation-wide view minus the caller's own requests. The
 * "Pending returns" queue asks for it, because a return is confirmed by someone other than its
 * requester: an approver's own pending return belongs in every queue but theirs.
 * @param {string} orgId
 * @param {{ userId: string, role: string }} actor
 * @param {{ state?: string, overdue?: boolean, page?: number, limit?: number, scope?: 'own'|'org'|'others' }} [query] validated `listQuery`
 * @returns {Promise<{ items: object[], total: number, page: number, limit: number }>}
 */
export async function list(orgId, actor, query = {}) {
  const { state, overdue, page, limit, scope } = query;
  // The server's clock decides what is late, never the caller's — the same rule as `markOverdue`.
  const asOf = new Date();
  const wantsOrgWide =
    (scope === 'org' || scope === 'others') &&
    roleHasPermission(actor.role, PERMISSIONS.REQUESTS_DECIDE);
  const result = wantsOrgWide
    ? await checkoutRequestRepo.list(orgId, {
        state,
        overdue,
        asOf,
        page,
        limit,
        excludeRequesterId: scope === 'others' ? actor.userId : undefined,
      })
    : await checkoutRequestRepo.listForRequester(orgId, actor.userId, {
        state,
        overdue,
        asOf,
        page,
        limit,
      });
  return { ...result, items: await withSummaries(orgId, result.items) };
}

/**
 * Attach the requester, asset and unit a list row needs to be readable.
 *
 * A queue of raw ids tells an approver nothing; the names are what they decide on. Three batched
 * lookups per page (units first, since the asset hangs off the unit), never one per row. Each lookup
 * is tenant-scoped, and a reference that no longer resolves becomes null rather than an error — the
 * same rule `get()` follows.
 * @param {string} orgId
 * @param {object[]} items request documents
 * @returns {Promise<object[]>}
 */
async function withSummaries(orgId, items) {
  if (items.length === 0) {
    return items;
  }
  const units = await assetUnitRepo.findByIds(
    orgId,
    items.map((r) => r.unitId),
  );
  const [assets, users] = await Promise.all([
    assetRepo.findByIds(
      orgId,
      units.map((u) => u.assetId),
    ),
    userRepo.findByIds(
      orgId,
      items.map((r) => r.requesterId),
    ),
  ]);
  const byId = (docs) => new Map(docs.map((d) => [String(d._id), d]));
  const unitById = byId(units);
  const assetById = byId(assets);
  const userById = byId(users);
  return items.map((request) => {
    const plain = typeof request.toJSON === 'function' ? request.toJSON() : request;
    const unit = unitById.get(String(request.unitId));
    const asset = unit ? assetById.get(String(unit.assetId)) : undefined;
    const requester = userById.get(String(request.requesterId));
    return {
      ...plain,
      unit: unit ? { id: String(unit._id), tag: unit.tag } : null,
      asset: asset ? { id: String(asset._id), name: asset.name } : null,
      requester: requester ? publicPerson(requester) : null,
    };
  });
}

/**
 * Read one checkout request with everything the detail screen shows (`GET /api/requests/:id`).
 *
 * Who may see it is decided the same way `list()` decides scope, and for the same reason: holding
 * `requests:decide` means the whole organisation's requests are your business, and everyone else
 * sees only their own.
 *
 * **Someone else's request is a 404, never a 403.** A 403 would confirm that the id exists, which
 * is exactly what a member probing for other people's requests wants to learn (SR-2). The same
 * answer covers an id from another organisation and an id that never existed.
 *
 * The asset, unit, requester and decider are read alongside the request because a detail screen
 * that showed raw ids would be useless, and four concurrent lookups are cheaper than four round
 * trips from the browser. Each is tenant-scoped in its own right, so a dangling reference resolves
 * to null rather than reaching across organisations.
 *
 * The timeline is derived from the request's own timestamps rather than from the audit log: the
 * audit trail needs `audit:read`, which a member does not hold, and the request document already
 * records when each transition happened.
 *
 * `canConfirmReturn` (SCRUM-205) tells the screen whether *this viewer* may confirm or reject the
 * return. The browser cannot work that out alone: the sole-confirmer fallback depends on who else in
 * the organisation could confirm, which only the server can count. It is false whenever the request
 * is in no state a return can close, so the count is only made when it matters.
 * @param {string} orgId
 * @param {{ userId: string, role: string }} actor
 * @param {string} requestId
 * @returns {Promise<{ request: object, asset: object|null, unit: object|null, requester: object|null, decidedBy: object|null, timeline: Array<{ at: Date, event: string }>, canConfirmReturn: boolean }>}
 * @throws {NotFoundError} (404) when no such request is visible to this caller
 */
export async function get(orgId, actor, requestId) {
  const request = await loadRequest(orgId, requestId);
  const maySeeAny = roleHasPermission(actor.role, PERMISSIONS.REQUESTS_DECIDE);
  if (!maySeeAny && !isRequester(request, actor)) {
    throw new NotFoundError('Request not found');
  }

  const unit = await assetUnitRepo.findById(orgId, request.unitId);
  const [asset, requester, decidedBy, confirmation] = await Promise.all([
    unit ? assetRepo.findById(orgId, unit.assetId) : null,
    userRepo.findById(orgId, request.requesterId),
    request.decidedBy ? userRepo.findById(orgId, request.decidedBy) : null,
    canTransition(request.state, S.RETURNED)
      ? returnConfirmation(orgId, request, actor)
      : { allowed: false },
  ]);

  return {
    request,
    asset,
    unit,
    requester: requester ? publicPerson(requester) : null,
    decidedBy: decidedBy ? publicPerson(decidedBy) : null,
    timeline: timelineOf(request),
    canConfirmReturn: confirmation.allowed,
  };
}

/**
 * The roles that can confirm a return: the holders of `requests:handoff`.
 *
 * Derived from the permission matrix rather than listed, so a role that gains the permission later is
 * counted by the sole-confirmer rule without anyone remembering this file.
 */
const CONFIRMER_ROLES = Object.freeze(
  Object.values(ROLES).filter((role) => roleHasPermission(role, PERMISSIONS.REQUESTS_HANDOFF)),
);

/**
 * Ask the organisation's policy whether `actor` may confirm or reject the return of `request`.
 *
 * Counts the *other* active confirmers first, because the policy cannot read the database and the
 * sole-confirmer fallback (AT-8) depends on that number. The count is skipped when the actor is not
 * the requester, where it cannot change the answer.
 * @param {string} orgId
 * @param {object} request
 * @param {{ userId: string, role: string }} actor
 * @param {{ session?: import('mongoose').ClientSession }} [options]
 * @returns {Promise<{ allowed: boolean, selfConfirmed?: boolean, reason?: string }>}
 */
async function returnConfirmation(orgId, request, actor, { session } = {}) {
  const org = await organizationRepo.findById(orgId, { session });
  const actorIsRequester = isRequester(request, actor);
  const otherConfirmers = actorIsRequester
    ? await userRepo.countActiveWithRoles(orgId, CONFIRMER_ROLES, {
        excludeUserId: actor.userId,
        session,
      })
    : undefined;
  const policy = policyFor(org);
  const ask = policy.canConfirmReturn ?? defaultCanConfirmReturn;
  return ask(request, actor, org, { otherConfirmers });
}

/**
 * The fields of a person the detail screen may show.
 *
 * An allow-list rather than the whole document: the requester's role or the date they joined is
 * nobody else's business on this screen, and copying by name means a field added to the user schema
 * later is not exposed here by accident.
 * @param {object} user
 * @returns {{ id: string, name: string, email: string }}
 */
function publicPerson(user) {
  return { id: String(user._id), name: user.name, email: user.email };
}

/**
 * Turn a request's timestamps into what happened to it, oldest first.
 *
 * Only entries whose timestamp exists are included, so the list reads as a history rather than a
 * form with blanks. `dueAt` is deliberately absent: it is a deadline, not something that happened,
 * and the screen shows it next to the state instead.
 * @param {object} request
 * @returns {Array<{ at: Date, event: string }>}
 */
function timelineOf(request) {
  const entries = [
    { at: request.createdAt, event: 'SUBMITTED' },
    request.autoApproved
      ? // SCRUM-148: say "approved automatically" rather than imply a person approved it. Anchored to
        // createdAt, not decidedAt: decidedAt is stamped a moment *before* the insert sets createdAt,
        // and would otherwise sort ahead of SUBMITTED. The sort is stable, so equal times keep this order.
        { at: request.createdAt, event: 'AUTO_APPROVED' }
      : { at: request.decidedAt, event: request.state === S.DENIED ? 'DENIED' : 'APPROVED' },
    { at: request.checkedOutAt, event: 'CHECKED_OUT' },
    // SCRUM-205: the borrower's side of a return. Cleared again if the return is rejected, so a
    // rejected attempt does not read as still waiting.
    { at: request.returnInitiatedAt, event: 'RETURN_INITIATED' },
    { at: request.returnedAt, event: 'RETURNED' },
    { at: request.expiredAt, event: 'EXPIRED' },
  ];
  // A cancellation leaves no timestamp of its own, so the document's last write is the best
  // evidence of when it happened. Only shown when the request actually is cancelled.
  if (request.state === S.CANCELLED) {
    entries.push({ at: request.updatedAt, event: 'CANCELLED' });
  }
  return entries.filter((entry) => Boolean(entry.at)).sort((a, b) => a.at - b.at);
}

/**
 * Approve a request (`POST /api/requests/:id/approve`).
 *
 * Holds the unit for the requester: PENDING -> APPROVED, unit -> HELD, both in one transaction with
 * the REQUEST_APPROVED audit event (SR-9, NFR-2). Separation of duties (SDD §6.4) is enforced by the
 * organisation's approval policy before anything is written.
 *
 * **The requester's eligibility is checked again here (SCRUM-150 AT-3).** A restricted asset's
 * eligibility is checked at submit, but the requester can leave the group, or be deactivated, while
 * the request waits in the queue — a time-of-check to time-of-use gap. So the same `isEligible()`
 * question is asked of the *requester* (not the approver) inside the transaction, and a stale request
 * is refused with 409 and left PENDING, where an approver can still deny it.
 * @param {string} orgId
 * @param {{ userId: string, role: string }} actor
 * @param {string} requestId
 * @param {{ note?: string, requestId?: string }} [input] validated `decisionBody`, plus the HTTP
 *   request id for audit correlation
 * @returns {Promise<object>} the approved request
 * @throws {NotFoundError} (404) no such request in this organisation
 * @throws {ForbiddenError} (403) actor's role can't decide, or actor is the requester
 * @throws {ConflictError} (409) the requester is no longer eligible for this restricted asset
 * @throws {StateTransitionError} (409) the request isn't PENDING (including a lost race)
 */
export async function approve(orgId, actor, requestId, input = {}) {
  const request = await loadRequest(orgId, requestId);
  await assertMayDecide(orgId, request, actor);

  const { unitStatus } = assertTransition(request.state, S.APPROVED);

  return withTransaction(async (session) => {
    const unit = await assetUnitRepo.findById(orgId, request.unitId, { session });
    const asset = unit ? await assetRepo.findById(orgId, unit.assetId, { session }) : null;
    if (asset && !(await isEligible(orgId, String(request.requesterId), asset, { session }))) {
      throw new ConflictError('requester is no longer eligible');
    }

    // Someone else deciding this request between our read and this write loses the compare-and-set.
    const updated = await commitTransition(
      orgId,
      requestId,
      {
        from: request.state,
        to: S.APPROVED,
        expectedState: S.PENDING,
        patch: {
          decidedBy: actor.userId,
          decidedAt: new Date(),
          decisionNote: input.note ?? '',
        },
      },
      { session },
    );

    await assetUnitRepo.updateStatus(orgId, updated.unitId, unitStatus, { session });

    await auditService.record(
      orgId,
      {
        actor,
        action: AUDIT_ACTION.REQUEST_APPROVED,
        targetType: AUDIT_TARGET_TYPE.CheckoutRequest,
        targetId: requestId,
        before: { state: S.PENDING },
        after: { state: S.APPROVED },
        requestId: input.requestId,
      },
      { session },
    );

    return updated;
  });
}

/**
 * Deny a request (`POST /api/requests/:id/deny`).
 *
 * PENDING -> DENIED, releasing the unit `submit()` reserved back to AVAILABLE, plus the
 * REQUEST_DENIED audit event in the same transaction. Same policy check and race protection as
 * `approve`.
 * @param {string} orgId
 * @param {{ userId: string, role: string }} actor
 * @param {string} requestId
 * @param {{ note?: string, requestId?: string }} [input] validated `decisionBody`, plus the HTTP
 *   request id for audit correlation
 * @returns {Promise<object>} the denied request
 * @throws {NotFoundError} (404) no such request in this organisation
 * @throws {ForbiddenError} (403) actor's role can't decide, or actor is the requester
 * @throws {StateTransitionError} (409) the request isn't PENDING (including a lost race)
 */
export async function deny(orgId, actor, requestId, input = {}) {
  const request = await loadRequest(orgId, requestId);
  await assertMayDecide(orgId, request, actor);

  const { unitStatus } = assertTransition(request.state, S.DENIED);

  return withTransaction(async (session) => {
    const updated = await commitTransition(
      orgId,
      requestId,
      {
        from: request.state,
        to: S.DENIED,
        expectedState: S.PENDING,
        patch: {
          decidedBy: actor.userId,
          decidedAt: new Date(),
          decisionNote: input.note ?? '',
        },
      },
      { session },
    );

    await assetUnitRepo.updateStatus(orgId, updated.unitId, unitStatus, { session });

    await auditService.record(
      orgId,
      {
        actor,
        action: AUDIT_ACTION.REQUEST_DENIED,
        targetType: AUDIT_TARGET_TYPE.CheckoutRequest,
        targetId: requestId,
        before: { state: S.PENDING },
        after: { state: S.DENIED },
        requestId: input.requestId,
      },
      { session },
    );

    return updated;
  });
}

/**
 * Withdraw one's own request (`POST /api/requests/:id/cancel`).
 *
 * The requester only — no role-based exception, unlike `get()`. An APPROVER or ORG_ADMIN can see
 * every request in the organisation, but seeing one and being allowed to withdraw it on someone
 * else's behalf are different things, and this ticket grants only the first.
 *
 * **Anyone other than the requester gets 404, never 403** — extending the same reasoning `get()`
 * uses (SR-2): a 403 would confirm to a non-owner that the request exists at all, and the route's
 * permission (`requests:create`) is held by every member, so without this a member could probe any
 * id in their own organisation and learn which ones exist from the 403/404 split alone.
 *
 * PENDING or APPROVED only — the table's own two `→ CANCELLED` rows enforce that: no third row
 * exists, so `assertTransition` throws 409 for anything else (already CHECKED_OUT, already decided
 * one way, or already terminal) without this function needing to special-case it. Either source
 * state releases the unit back to AVAILABLE — REQUESTED for a still-PENDING request, HELD for an
 * APPROVED one — both rows now carry `unitStatus: AVAILABLE`.
 * @param {string} orgId
 * @param {{ userId: string, role: string }} actor
 * @param {string} requestId
 * @param {{ requestId?: string }} [input] the HTTP request id, for audit correlation
 * @returns {Promise<object>} the cancelled request
 * @throws {NotFoundError} (404) no such request, or the caller is not its requester
 * @throws {StateTransitionError} (409) the request isn't PENDING/APPROVED (including a lost race)
 */
export async function cancel(orgId, actor, requestId, input = {}) {
  const request = await loadOwnRequest(orgId, actor, requestId);

  const { unitStatus } = assertTransition(request.state, S.CANCELLED);

  return withTransaction(async (session) => {
    const updated = await commitTransition(
      orgId,
      requestId,
      {
        from: request.state,
        to: S.CANCELLED,
        expectedState: request.state,
      },
      { session },
    );

    if (unitStatus) {
      await assetUnitRepo.updateStatus(orgId, updated.unitId, unitStatus, { session });
    }

    await auditService.record(
      orgId,
      {
        actor,
        action: AUDIT_ACTION.REQUEST_CANCELLED,
        targetType: AUDIT_TARGET_TYPE.CheckoutRequest,
        targetId: requestId,
        before: { state: request.state },
        after: { state: S.CANCELLED },
        requestId: input.requestId,
      },
      { session },
    );

    return updated;
  });
}

/**
 * The states in which the item is with the borrower: what a second attempt to record the same
 * pickup finds (SCRUM-205 AT-1). Used only to word the 409, never to decide anything.
 */
const ALREADY_OUT_STATES = Object.freeze([S.CHECKED_OUT, S.OVERDUE, S.RETURN_PENDING]);

/**
 * Hand the item over (`POST /api/requests/:id/checkout`).
 *
 * APPROVED -> CHECKED_OUT, unit -> OUT, `dueAt` stamped from the request's own `neededTo`.
 * ASSET_CHECKED_OUT audit event in the same transaction.
 *
 * **Who may record it (SCRUM-205).** Either side of the handoff: the borrower ("I've picked it up"),
 * whatever their role, or anyone holding `requests:handoff`. The route is open to every role so a
 * member can reach this, and the check lives here. Members are not given `requests:handoff`, because
 * that permission also covers confirming returns. Another member is refused with 403. The request is
 * in their organisation, so the 404-for-privacy rule `cancel()` follows is the story's explicit
 * exception here (AT-2).
 *
 * The audit entry names whoever recorded it, with `selfReported: true` when that was the requester,
 * so a reader can tell "the desk saw it leave" from "the borrower says they took it".
 *
 * **Recorded once.** The compare-and-set on APPROVED means the second side to click loses, and gets a
 * 409 that says the item is already checked out rather than a raw state-machine message.
 * @param {string} orgId
 * @param {{ userId: string, role: string }} actor
 * @param {string} requestId
 * @param {{ requestId?: string }} [input] the HTTP request id, for audit correlation
 * @returns {Promise<object>} the checked-out request
 * @throws {NotFoundError} (404) no such request in this organisation
 * @throws {ForbiddenError} (403) the caller is neither the requester nor holds `requests:handoff`
 * @throws {ConflictError} (409) the item is already checked out (including a lost race)
 * @throws {StateTransitionError} (409) the request is in some other state that cannot be checked out
 */
export async function checkout(orgId, actor, requestId, input = {}) {
  const request = await loadRequest(orgId, requestId);

  const actorIsRequester = isRequester(request, actor);
  if (!actorIsRequester && !roleHasPermission(actor.role, PERMISSIONS.REQUESTS_HANDOFF)) {
    throw new ForbiddenError('Only the borrower or an approver can record this pickup');
  }

  if (ALREADY_OUT_STATES.includes(request.state)) {
    throw new ConflictError('This item is already checked out');
  }
  const { unitStatus } = assertTransition(request.state, S.CHECKED_OUT);

  return withTransaction(async (session) => {
    // The other side recording the same pickup between our read and this write loses the
    // compare-and-set, and hears that the item is already out rather than a state-machine message.
    const updated = await commitTransition(
      orgId,
      requestId,
      {
        from: request.state,
        to: S.CHECKED_OUT,
        expectedState: S.APPROVED,
        patch: {
          checkedOutAt: new Date(),
          dueAt: request.neededTo,
        },
        conflictMessage: 'This item is already checked out',
      },
      { session },
    );

    await assetUnitRepo.updateStatus(orgId, updated.unitId, unitStatus, { session });

    await auditService.record(
      orgId,
      {
        actor,
        action: AUDIT_ACTION.ASSET_CHECKED_OUT,
        targetType: AUDIT_TARGET_TYPE.AssetUnit,
        targetId: updated.unitId,
        before: { status: U.HELD },
        after: { status: unitStatus, selfReported: actorIsRequester },
        requestId: input.requestId,
      },
      { session },
    );

    return updated;
  });
}

/**
 * Start a return (`POST /api/requests/:id/initiate-return`, SCRUM-205 AT-4).
 *
 * The borrower's half of a return: CHECKED_OUT or OVERDUE -> RETURN_PENDING, with the condition they
 * report. **The unit stays OUT** and nothing about it changes: the borrower's word is not evidence the
 * item arrived, so accountability carries on until a different Approver or Org Admin confirms it
 * (`returnUnit`) or rejects it (`rejectReturn`). The reported condition is kept on the request, not
 * written to the unit, for the same reason.
 *
 * The requester only, whatever their role, and anyone else gets 404, as with `cancel()`: the route is
 * open to every member, so a 403 would let a member learn which ids exist.
 * @param {string} orgId
 * @param {{ userId: string, role: string }} actor
 * @param {string} requestId
 * @param {{ condition: string, note?: string, requestId?: string }} input validated
 *   `initiateReturnBody`, plus the HTTP request id for audit correlation
 * @returns {Promise<object>} the request, now RETURN_PENDING
 * @throws {NotFoundError} (404) no such request, or the caller is not its requester
 * @throws {StateTransitionError} (409) the request isn't CHECKED_OUT/OVERDUE (including a lost race)
 */
export async function initiateReturn(orgId, actor, requestId, input = {}) {
  const request = await loadOwnRequest(orgId, actor, requestId);

  assertTransition(request.state, S.RETURN_PENDING);

  return withTransaction(async (session) => {
    const updated = await commitTransition(
      orgId,
      requestId,
      {
        from: request.state,
        to: S.RETURN_PENDING,
        expectedState: request.state,
        patch: {
          reportedCondition: input.condition,
          reportedNote: input.note ?? '',
          returnInitiatedAt: new Date(),
        },
      },
      { session },
    );

    await auditService.record(
      orgId,
      {
        actor,
        action: AUDIT_ACTION.RETURN_INITIATED,
        targetType: AUDIT_TARGET_TYPE.CheckoutRequest,
        targetId: requestId,
        before: { state: request.state },
        after: {
          state: S.RETURN_PENDING,
          reportedCondition: input.condition,
          ...(input.note ? { reportedNote: input.note } : {}),
        },
        requestId: input.requestId,
      },
      { session },
    );

    return updated;
  });
}

/**
 * Take the item back (`POST /api/requests/:id/return`).
 *
 * Two ways in, one way out, all to RETURNED with the unit AVAILABLE and an ASSET_RETURNED audit event
 * in the same transaction:
 *
 * - **Confirming a pending return (SCRUM-205 AT-5).** RETURN_PENDING -> RETURNED. The confirmer
 *   records the condition they *received*, which becomes the unit's condition. The audit entry keeps
 *   both that and the borrower's reported condition, so a disagreement stays visible.
 * - **A walk-in return (AT-6).** CHECKED_OUT or OVERDUE -> RETURNED, when the borrower hands the item
 *   over without starting a return first, exactly as in Iteration 1.
 *
 * **Who may confirm** is the policy's `canConfirmReturn`: `requests:handoff` (also enforced at the
 * route), and never the requester, unless they are the organisation's only Approver or Org Admin
 * (AT-7, AT-8). That fallback is recorded as `selfConfirmed: true` on the audit entry. The policy is
 * asked again inside the transaction, so a second admin invited mid-flight is counted.
 * @param {string} orgId
 * @param {{ userId: string, role: string }} actor
 * @param {string} requestId
 * @param {{ condition?: string, note?: string, requestId?: string }} [input] validated `returnBody`,
 *   plus the HTTP request id for audit correlation
 * @returns {Promise<object>} the returned request
 * @throws {NotFoundError} (404) no such request in this organisation
 * @throws {ForbiddenError} (403) the caller may not confirm this return (role, or their own request)
 * @throws {StateTransitionError} (409) the request isn't CHECKED_OUT/OVERDUE/RETURN_PENDING (including a lost race)
 */
export async function returnUnit(orgId, actor, requestId, input = {}) {
  const request = await loadRequest(orgId, requestId);

  await assertMayConfirmReturn(orgId, request, actor);
  const { unitStatus } = assertTransition(request.state, S.RETURNED);

  return withTransaction(async (session) => {
    const { selfConfirmed } = await assertMayConfirmReturn(orgId, request, actor, { session });
    const updated = await commitTransition(
      orgId,
      requestId,
      {
        from: request.state,
        to: S.RETURNED,
        expectedState: request.state,
        patch: { returnedAt: new Date() },
      },
      { session },
    );

    await assetUnitRepo.updateStatusAndCondition(
      orgId,
      updated.unitId,
      { status: unitStatus, condition: input.condition },
      { session },
    );

    const wasPending = request.state === S.RETURN_PENDING;
    await auditService.record(
      orgId,
      {
        actor,
        action: AUDIT_ACTION.ASSET_RETURNED,
        targetType: AUDIT_TARGET_TYPE.AssetUnit,
        targetId: updated.unitId,
        before: { status: U.OUT },
        after: {
          status: unitStatus,
          ...(input.condition ? { condition: input.condition } : {}),
          ...(wasPending
            ? {
                reportedCondition: request.reportedCondition,
                receivedCondition: input.condition ?? null,
              }
            : {}),
          ...(input.note ? { note: input.note } : {}),
          selfConfirmed,
        },
        requestId: input.requestId,
      },
      { session },
    );

    return updated;
  });
}

/**
 * Refuse a pending return (`POST /api/requests/:id/reject-return`, SCRUM-205 AT-6).
 *
 * For when the borrower says the item is back and it is not: RETURN_PENDING -> CHECKED_OUT, the unit
 * still OUT, and a RETURN_REJECTED audit entry with the confirmer's reason. The borrower's report is
 * cleared from the request, so the screen no longer shows a return waiting; the audit trail keeps both
 * the RETURN_INITIATED and the RETURN_REJECTED entries.
 *
 * The same people may reject as may confirm (`canConfirmReturn`), for the same reason: the requester
 * rejecting their own return would be pointless, and letting them do it would make the queue
 * something they can tidy away themselves.
 * @param {string} orgId
 * @param {{ userId: string, role: string }} actor
 * @param {string} requestId
 * @param {{ reason: string, requestId?: string }} input validated `rejectReturnBody`, plus the HTTP
 *   request id for audit correlation
 * @returns {Promise<object>} the request, back to CHECKED_OUT
 * @throws {NotFoundError} (404) no such request in this organisation
 * @throws {ForbiddenError} (403) the caller may not confirm this return (role, or their own request)
 * @throws {StateTransitionError} (409) the request isn't RETURN_PENDING (including a lost race)
 */
export async function rejectReturn(orgId, actor, requestId, input = {}) {
  const request = await loadRequest(orgId, requestId);

  await assertMayConfirmReturn(orgId, request, actor);
  if (request.state !== S.RETURN_PENDING) {
    // CHECKED_OUT -> CHECKED_OUT is not a move; without this a rejection of a request nobody started
    // to return would fall through to the table and read as a confusing self-transition.
    throw new StateTransitionError(
      request.state,
      S.CHECKED_OUT,
      'No return is waiting to be confirmed',
    );
  }
  assertTransition(request.state, S.CHECKED_OUT);

  return withTransaction(async (session) => {
    const { selfConfirmed } = await assertMayConfirmReturn(orgId, request, actor, { session });
    const updated = await commitTransition(
      orgId,
      requestId,
      {
        from: request.state,
        to: S.CHECKED_OUT,
        expectedState: S.RETURN_PENDING,
        patch: {
          reportedCondition: null,
          reportedNote: '',
          returnInitiatedAt: null,
        },
      },
      { session },
    );

    await auditService.record(
      orgId,
      {
        actor,
        action: AUDIT_ACTION.RETURN_REJECTED,
        targetType: AUDIT_TARGET_TYPE.CheckoutRequest,
        targetId: requestId,
        before: { state: S.RETURN_PENDING, reportedCondition: request.reportedCondition },
        after: { state: S.CHECKED_OUT, reason: input.reason, selfConfirmed },
        requestId: input.requestId,
      },
      { session },
    );

    return updated;
  });
}

/**
 * Refuse with 403 unless the policy lets `actor` confirm or reject this return.
 * @param {string} orgId
 * @param {object} request
 * @param {{ userId: string, role: string }} actor
 * @param {{ session?: import('mongoose').ClientSession }} [options]
 * @returns {Promise<{ selfConfirmed: boolean }>}
 * @throws {ForbiddenError} (403)
 */
async function assertMayConfirmReturn(orgId, request, actor, { session } = {}) {
  const decision = await returnConfirmation(orgId, request, actor, { session });
  if (!decision.allowed) {
    throw new ForbiddenError(
      decision.reason === 'requester cannot confirm their own return'
        ? 'Someone other than the borrower must confirm this return'
        : 'Not allowed to confirm this return',
    );
  }
  return { selfConfirmed: Boolean(decision.selfConfirmed) };
}

/**
 * Flag one organisation's late checkouts: every CHECKED_OUT request with `dueAt` before `now`
 * becomes OVERDUE. Returns how many moved.
 *
 * **`now` is required and never defaulted.** The caller says what "now" is — the endpoint passes the
 * request time, a future scheduler its own tick, a test a fixed date — so the function never reads
 * the clock and a test never depends on the day it runs.
 *
 * **The tenant is required too.** Mongoose drops an `undefined` filter key, so a missing `orgId`
 * would not match nothing — it would match every organisation (SR-2). That is refused before any
 * query is built.
 *
 * **The move is checked against the state machine** (`assertTransition(CHECKED_OUT, OVERDUE)`), so
 * removing that row from TRANSITIONS switches this off rather than letting it write a state the table
 * no longer allows. The row has no unit side-effect: an overdue item is still with the borrower, so
 * its unit stays OUT.
 *
 * **One bulk write, not one per request.** The filter matches CHECKED_OUT only, which makes each
 * document's update a compare-and-set (a request returned mid-run no longer matches) and a repeated
 * run a no-op. Per-request `transition()` calls would buy nothing without a per-request audit entry
 * to write alongside each one — see below.
 *
 * **Not audited, by decision.** SR-9 audits state changes people make. This one has no actor and
 * decides nothing: OVERDUE is derived entirely from `dueAt`, which the ASSET_CHECKED_OUT event
 * already records, and custody does not change. The audit trail can already answer "was it late?";
 * a system-actor entry (SCRUM-139) can be added here later if the team wants one.
 * @param {string} orgId
 * @param {{ now: Date }} options `now` — the instant to measure lateness against
 * @returns {Promise<number>} how many requests were moved to OVERDUE
 * @throws {TypeError} when `orgId` is missing or `now` is not a valid Date
 */
export async function markOverdue(orgId, { now } = {}) {
  if (!orgId) {
    throw new TypeError('markOverdue: orgId is required');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('markOverdue: now must be a valid Date');
  }
  assertTransition(S.CHECKED_OUT, S.OVERDUE);
  return checkoutRequestRepo.markOverdue(orgId, now);
}

/**
 * Expire one organisation's uncollected approvals (SCRUM-205 AT-3): every APPROVED request whose
 * pickup window has closed becomes EXPIRED, and its unit goes from HELD back to AVAILABLE. Returns how
 * many moved.
 *
 * The pickup window is `neededFrom` plus the organisation's `pickupSettings.graceHours` (48 by
 * default). Without this, an approval nobody collects would hold its unit until someone thought to
 * cancel it.
 *
 * **`now` is required and never defaulted**, for the same reason as `markOverdue`: the caller says
 * what "now" is, so a test never depends on the day it runs. The tenant is required too, since a
 * missing `orgId` would otherwise match every organisation (SR-2).
 *
 * **Audited, unlike `markOverdue`.** Expiry changes custody (it releases a reserved unit), so each
 * request gets a REQUEST_EXPIRED entry with the system actor (`actorId: null`, role SYSTEM). Nobody is
 * named, because nobody decided it. That means one transaction per request rather than one bulk
 * write: the state change, the unit release and the audit entry must commit together (NFR-2). Each
 * write is a compare-and-set on APPROVED, so a request picked up or cancelled mid-sweep is skipped and
 * a repeated run is a no-op.
 * @param {string} orgId
 * @param {{ now: Date, requestId?: string }} options `now` — the instant to measure the window against
 * @returns {Promise<number>} how many requests were moved to EXPIRED
 * @throws {TypeError} when `orgId` is missing or `now` is not a valid Date
 */
export async function expireApprovals(orgId, { now, requestId } = {}) {
  if (!orgId) {
    throw new TypeError('expireApprovals: orgId is required');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('expireApprovals: now must be a valid Date');
  }
  const { unitStatus } = assertTransition(S.APPROVED, S.EXPIRED);

  const org = await organizationRepo.findById(orgId);
  const graceHours = org?.pickupSettings?.graceHours ?? DEFAULT_PICKUP_GRACE_HOURS;
  const cutoff = new Date(now.getTime() - graceHours * 60 * 60 * 1000);
  const candidates = await checkoutRequestRepo.findExpirableApprovals(orgId, cutoff);

  let expired = 0;
  for (const request of candidates) {
    // Sequential: each is its own transaction, and a sweep over a handful of requests gains nothing
    // from racing them against each other.
    const moved = await withTransaction(async (session) => {
      const updated = await checkoutRequestRepo.transition(
        orgId,
        request._id,
        { expectedState: S.APPROVED, patch: { state: S.EXPIRED, expiredAt: now } },
        { session },
      );
      if (!updated) {
        return false; // picked up or cancelled since the read; nothing to expire
      }
      await assetUnitRepo.updateStatus(orgId, updated.unitId, unitStatus, { session });
      await auditService.record(
        orgId,
        {
          actor: auditService.SYSTEM_ACTOR,
          action: AUDIT_ACTION.REQUEST_EXPIRED,
          targetType: AUDIT_TARGET_TYPE.CheckoutRequest,
          targetId: updated._id,
          before: { state: S.APPROVED },
          after: { state: S.EXPIRED, unitStatus, graceHours },
          requestId,
        },
        { session },
      );
      return true;
    });
    if (moved) {
      expired += 1;
    }
  }
  return expired;
}
