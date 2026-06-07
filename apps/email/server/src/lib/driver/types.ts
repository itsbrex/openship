/**
 * Legacy compat shim - the client imports thread types from this path.
 * The real definitions live in `imap-driver.ts`.
 */

import type { ThreadMessage as DriverMessage } from '../imap-driver';

export type { ThreadResponse as IGetThreadResponse, ThreadMessage } from '../imap-driver';
export type ParsedMessage = DriverMessage;
export type ParsedDraft = Pick<
  DriverMessage,
  'id' | 'subject' | 'to' | 'cc' | 'bcc' | 'decodedBody' | 'receivedOn'
> & {
  rawMessage?: {
    internalDate?: string | number;
    [key: string]: unknown;
  };
};
