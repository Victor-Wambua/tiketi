import { createHmac, randomBytes } from 'node:crypto';
import type { PaymentProvider, StkRequest } from './provider.ts';

export type StkOutcome = 'success' | 'cancelled' | 'insufficient_funds' | 'timeout';

/** Daraja-style result codes used by the mock. */
export const RESULT_CODES: Record<StkOutcome, { code: number; desc: string }> = {
  success: { code: 0, desc: 'The service request is processed successfully.' },
  cancelled: { code: 1032, desc: 'Request cancelled by user' },
  insufficient_funds: { code: 1, desc: 'The balance is insufficient for the transaction' },
  timeout: { code: 1037, desc: 'DS timeout user cannot be reached' },
};

export interface PendingPrompt {
  providerRef: string;
  phone: string;
  amountKes: number;
  description: string;
  createdAt: number;
}

export type Deliver = (rawBody: string, signature: string) => Promise<void>;

export function signCallback(secret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/** Builds the Daraja-shaped callback body for a prompt and an outcome. */
export function buildCallbackBody(
  prompt: Pick<PendingPrompt, 'providerRef' | 'phone' | 'amountKes'>,
  outcome: StkOutcome,
  opts: { amountKes?: number; receipt?: string } = {},
): string {
  const r = RESULT_CODES[outcome];
  const stk: Record<string, unknown> = {
    MerchantRequestID: `mr-${prompt.providerRef}`,
    CheckoutRequestID: prompt.providerRef,
    ResultCode: r.code,
    ResultDesc: r.desc,
  };
  if (outcome === 'success') {
    stk.CallbackMetadata = {
      Item: [
        { Name: 'Amount', Value: opts.amountKes ?? prompt.amountKes },
        {
          Name: 'MpesaReceiptNumber',
          Value: opts.receipt ?? `SYN${randomBytes(4).toString('hex').toUpperCase()}`,
        },
        { Name: 'PhoneNumber', Value: Number(prompt.phone) },
      ],
    };
  }
  return JSON.stringify({ Body: { stkCallback: stk } });
}

/**
 * Mock M-Pesa STK push. Prompts stay "on the phone" until a reviewer picks an outcome in the
 * phone-simulator panel (or the prompt times out). The outcome is then delivered to the app's
 * callback endpoint as a signed webhook, exactly as a real provider's callback would arrive.
 * Nothing here talks to a real network or a real payment service.
 */
export class MockMpesaProvider implements PaymentProvider {
  readonly name = 'mock-mpesa';
  private readonly prompts = new Map<string, PendingPrompt & { timer: NodeJS.Timeout }>();
  private deliver: Deliver | null = null;

  constructor(
    private readonly opts: { secret: string; timeoutMs: number; autoOutcome?: StkOutcome | null },
  ) {}

  setDeliver(fn: Deliver): void {
    this.deliver = fn;
  }

  async initiateStk(req: StkRequest): Promise<{ providerRef: string }> {
    const providerRef = `ws_CO_${randomBytes(8).toString('hex')}`;
    const prompt: PendingPrompt = {
      providerRef,
      phone: req.phone,
      amountKes: req.amountKes,
      description: req.description,
      createdAt: Date.now(),
    };
    const timer = setTimeout(() => void this.resolve(providerRef, 'timeout'), this.opts.timeoutMs);
    timer.unref();
    this.prompts.set(providerRef, { ...prompt, timer });
    if (this.opts.autoOutcome) {
      const auto = this.opts.autoOutcome;
      setTimeout(() => void this.resolve(providerRef, auto), 50).unref();
    }
    return { providerRef };
  }

  private readonly refunds = new Map<string, string>();

  async refund(req: {
    providerRef: string;
    amountKes: number;
    reason: string;
    idempotencyKey: string;
  }): Promise<{ refundRef: string }> {
    let ref = this.refunds.get(req.idempotencyKey);
    if (!ref) {
      ref = `RFD${randomBytes(4).toString('hex').toUpperCase()}`;
      this.refunds.set(req.idempotencyKey, ref);
    }
    return { refundRef: ref };
  }

  pending(phone?: string): PendingPrompt[] {
    return [...this.prompts.values()]
      .filter((p) => !phone || p.phone === phone)
      .map(({ timer: _timer, ...p }) => p);
  }

  /** The phone owner's choice. Returns false if the prompt is already gone. */
  async resolve(providerRef: string, outcome: StkOutcome): Promise<boolean> {
    const prompt = this.prompts.get(providerRef);
    if (!prompt) return false;
    clearTimeout(prompt.timer);
    this.prompts.delete(providerRef);
    if (!this.deliver) throw new Error('mock provider has no delivery function');
    const body = buildCallbackBody(prompt, outcome);
    await this.deliver(body, signCallback(this.opts.secret, body));
    return true;
  }

  close(): void {
    for (const p of this.prompts.values()) clearTimeout(p.timer);
    this.prompts.clear();
  }
}
