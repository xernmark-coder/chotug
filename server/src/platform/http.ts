import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import type { Actor } from '../db.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'error',
    public detail?: unknown,
  ) {
    super(message);
  }
  static badRequest(m: string, d?: unknown) { return new ApiError(400, m, 'bad_request', d); }
  static unauthorized(m = 'Please sign in again') { return new ApiError(401, m, 'unauthorized'); }
  static forbidden(m: string, d?: unknown) { return new ApiError(403, m, 'forbidden', d); }
  static notFound(m = 'Not found') { return new ApiError(404, m, 'not_found'); }
  static conflict(m: string, d?: unknown) { return new ApiError(409, m, 'conflict', d); }
  /** A business rule from the spec was violated — shown verbatim to the user. */
  static rule(m: string, d?: unknown) { return new ApiError(422, m, 'rule_violation', d); }
}

export interface Ctx extends Request {
  actor: Actor;
}

export type Handler = (req: Ctx, res: Response) => Promise<unknown>;

/** Wraps an async route so a rejected promise reaches the error middleware. */
export function h(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as Ctx, res))
      .then((out) => {
        if (out !== undefined && !res.headersSent) res.json(out);
      })
      .catch(next);
  };
}

/**
 * Parses and returns the schema's OUTPUT type, so `.default()` values are
 * non-optional to the caller — which is the whole point of declaring them.
 */
export function body<S extends ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw ApiError.badRequest('Some fields need attention', fieldErrors(r.error));
  }
  return r.data;
}

function fieldErrors(e: ZodError) {
  const out: Record<string, string> = {};
  for (const issue of e.issues) out[issue.path.join('.') || '_'] = issue.message;
  return out;
}

/** Maps Postgres constraint failures onto readable, spec-worded messages. */
export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof ApiError) {
    return res
      .status(err.status)
      .json({ error: err.message, code: err.code, detail: err.detail });
  }

  /* An illegal state transition already carries the exact sentence the user
   * needs — "A po in SUBMITTED cannot move to CONFIRMED. Allowed: APPROVED,
   * DRAFT, CANCELLED." Until this was here it fell through to the generic
   * 500 and that sentence was thrown away on every state machine in the app. */
  if (err?.name === 'TransitionError') {
    return res.status(422).json({
      error: err.message,
      code: 'invalid_transition',
      detail: { machine: err.machine, from: err.from, to: err.to },
    });
  }

  const pgCode: string | undefined = err?.code;
  const constraint: string | undefined = err?.constraint;

  if (pgCode === '23505') {
    if (constraint === 'uq_ledger_grn_line') {
      return res.status(409).json({
        error: 'This receipt has already been posted to inventory. Nothing was posted twice.',
        code: 'already_posted',
      });
    }
    return res.status(409).json({
      error: 'That record already exists.',
      code: 'duplicate',
      detail: constraint,
    });
  }

  if (pgCode === '23514') {
    const map: Record<string, string> = {
      ck_po_maker_checker: 'The person who submitted this order cannot also approve it.',
      ck_appr_maker_checker: 'You raised this request, so you cannot approve it.',
      ck_appr_reason: 'A reason is required when holding or rejecting.',
      ck_qc_qty_balance: 'Accepted + rejected + hold cannot exceed the received quantity.',
      ck_grnline_balance: 'Accepted + rejected + hold cannot exceed the received quantity.',
      ck_grnline_reject_reason: 'Select a rejection reason for the rejected quantity.',
      ck_weigh_reweigh_reason: 'A re-weighment needs a reason.',
      ck_qc_ai_override: 'Give a reason when overriding the AI grading suggestion.',
      ck_putaway_mismatch: 'Give a reason when putting stock in a different bin.',
      ck_grn_amend_reason: 'An amendment or reversal needs a reason.',
    };
    return res.status(422).json({
      error: map[constraint ?? ''] ?? 'That value breaks a business rule.',
      code: 'rule_violation',
      detail: constraint,
    });
  }

  if (err?.message?.includes('grn_immutable')) {
    return res.status(422).json({
      error: 'A posted GRN cannot be edited. Use amend or reverse instead.',
      code: 'immutable',
    });
  }
  if (err?.message?.includes('gate_entry_locked')) {
    return res.status(422).json({
      error: 'This gate entry is submitted and locked. Raise an amendment instead.',
      code: 'immutable',
    });
  }
  if (err?.message?.includes('number_series_missing')) {
    return res.status(500).json({
      error: 'Document numbering is not configured for this branch and year.',
      code: 'numbering_missing',
    });
  }

  console.error('[unhandled]', err);
  return res.status(500).json({ error: 'Something went wrong on our side.', code: 'internal' });
}
