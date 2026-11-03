import twilio from "twilio";

export interface SmsSender {
  send(to: string, body: string): Promise<void>;
}

export function createTwilioSender(opts: { accountSid: string; authToken: string; from: string }): SmsSender {
  const client = twilio(opts.accountSid, opts.authToken);
  return {
    async send(to, body) {
      await client.messages.create({ to, from: opts.from, body });
    },
  };
}

export function verifyTwilioSignature(opts: {
  authToken: string;
  signature: string | undefined;
  url: string;
  params: Record<string, string>;
}): boolean {
  if (!opts.signature) return false;
  return twilio.validateRequest(opts.authToken, opts.signature, opts.url, opts.params);
}

/** Reply with empty TwiML; we send replies through the REST API so slow AI turns don't time out the webhook. */
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
