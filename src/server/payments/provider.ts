/**
 * The payment port. The booking code only knows this interface; the shipped adapter is a mock of
 * M-Pesa STK push (see mockMpesa.ts). Outcomes come back asynchronously through the callback
 * endpoint, never as the return value of `initiateStk`.
 */
export interface StkRequest {
  paymentId: string;
  phone: string;
  amountKes: number;
  accountRef: string;
  description: string;
}

export interface PaymentProvider {
  readonly name: string;
  /** Sends the prompt to the customer's phone. Returns the provider's checkout request id. */
  initiateStk(req: StkRequest): Promise<{ providerRef: string }>;
  /** `idempotencyKey` is stable per refund record, so a retried call cannot refund twice. */
  refund(req: {
    providerRef: string;
    amountKes: number;
    reason: string;
    idempotencyKey: string;
  }): Promise<{ refundRef: string }>;
}
