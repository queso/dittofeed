import { SourceType } from "isomorphic-lib/src/constants";
import { err, ok, Result, ResultAsync } from "neverthrow";
import * as R from "remeda";
import { ErrorResponse, Resend } from "resend";
import { v5 as uuidv5 } from "uuid";

import { submitBatch } from "../apps/batch";
import { MESSAGE_METADATA_FIELDS } from "../constants";
import logger from "../logger";
import {
  BatchAppData,
  BatchItem,
  BatchTrackData,
  EmailProviderType,
  EventType,
  InternalEventType,
  MessageMetadataFields,
  ResendEvent,
  ResendEventType,
} from "../types";

function guardResponseError(payload: unknown): ErrorResponse {
  const error = payload as Error;
  return {
    message: error.message,
    name: error.cause as ErrorResponse["name"],
  };
}

export type ResendRequiredData = Parameters<Resend["emails"]["send"]>["0"];
export type ResendResponse = Awaited<ReturnType<Resend["emails"]["send"]>>;

/* 
 Resend's client does not throw an error and instead returns a nullish error 
 object that's why we wrap it out in our wrapper function
 */
const sendMailWrapper = async (
  apiKey: string,
  mailData: ResendRequiredData,
) => {
  const resend = new Resend(apiKey);
  const response = await resend.emails.send(mailData);
  if (response.error) {
    throw new Error(response.error.message, {
      cause: response.error.name,
    });
  }
  return response;
};

/**
 * Resend restricts tag names and values to ASCII letters, digits, underscores
 * and dashes, with a 256 character maximum:
 * https://resend.com/docs/api-reference/emails/send-email
 *
 * Dittofeed's message tags carry `userId`, which is an arbitrary
 * caller-supplied string. Email addresses are a common choice, and they fail
 * that validation, which makes every send for those users fail.
 *
 * The encoding below is identity-preserving: a value that already satisfies
 * Resend's charset is passed through byte for byte. That property is load
 * bearing in two places. `webhooksController` reads `tags.workspaceId` off the
 * raw webhook payload before any decoding happens, and webhooks that arrive
 * for messages sent before this change still need to decode correctly.
 *
 * Values that do need escaping are base64url encoded behind a sentinel prefix,
 * which is itself within the permitted charset.
 */
const RESEND_TAG_ENCODING_PREFIX = "dfb64-";
const RESEND_TAG_SAFE_PATTERN = /^[A-Za-z0-9_-]*$/;
const RESEND_TAG_MAX_LENGTH = 256;

export function encodeResendTagValue(value: string): string {
  if (
    RESEND_TAG_SAFE_PATTERN.test(value) &&
    !value.startsWith(RESEND_TAG_ENCODING_PREFIX)
  ) {
    return value;
  }
  return (
    RESEND_TAG_ENCODING_PREFIX +
    Buffer.from(value, "utf8").toString("base64url")
  );
}

export function decodeResendTagValue(value: string): string {
  if (!value.startsWith(RESEND_TAG_ENCODING_PREFIX)) {
    return value;
  }
  return Buffer.from(
    value.slice(RESEND_TAG_ENCODING_PREFIX.length),
    "base64url",
  ).toString("utf8");
}

/**
 * Builds the `tags` array for a Resend send, encoding values that fall outside
 * Resend's permitted charset. Tags that cannot be represented are dropped with
 * a warning rather than failing the send, since losing attribution for one
 * message is preferable to not delivering it at all.
 */
export function encodeResendTags(
  messageTags: Record<string, string>,
): { name: string; value: string }[] {
  return Object.entries(messageTags).flatMap(([name, value]) => {
    if (
      !RESEND_TAG_SAFE_PATTERN.test(name) ||
      name.length > RESEND_TAG_MAX_LENGTH
    ) {
      logger().warn(
        { name },
        "Dropping Resend tag whose name is outside the permitted charset.",
      );
      return [];
    }
    const encodedValue = encodeResendTagValue(value);
    if (encodedValue.length > RESEND_TAG_MAX_LENGTH) {
      logger().warn(
        { name, encodedLength: encodedValue.length },
        "Dropping Resend tag whose encoded value exceeds the length limit.",
      );
      return [];
    }
    return [{ name, value: encodedValue }];
  });
}

function decodeResendTags(tags: MessageMetadataFields): MessageMetadataFields {
  const decoded: MessageMetadataFields = {};
  for (const field of MESSAGE_METADATA_FIELDS) {
    const value = tags[field];
    if (value !== undefined) {
      decoded[field] = decodeResendTagValue(value);
    }
  }
  return decoded;
}

export async function sendMail({
  apiKey,
  mailData,
}: {
  apiKey: string;
  mailData: ResendRequiredData;
}): Promise<ResultAsync<ResendResponse, ErrorResponse>> {
  return ResultAsync.fromPromise(
    sendMailWrapper(apiKey, mailData),
    guardResponseError,
  ).map((resultArray) => resultArray);
}

export function resendEventToDF({
  workspaceId,
  resendEvent,
}: {
  workspaceId: string;
  resendEvent: ResendEvent;
}): Result<BatchItem, Error> {
  const { type: event } = resendEvent;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const { created_at, email_id, to } = resendEvent.data;

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const email = to[0]!;

  const tags = decodeResendTags(resendEvent.data.tags);

  const { userId } = tags;
  if (!userId) {
    return err(new Error("Missing userId or anonymousId."));
  }
  const messageId = uuidv5(`${event}:${email_id}`, workspaceId);

  let eventName: InternalEventType;

  switch (event) {
    case ResendEventType.Opened:
      eventName = InternalEventType.EmailOpened;
      break;
    case ResendEventType.Clicked:
      eventName = InternalEventType.EmailClicked;
      break;
    case ResendEventType.Bounced:
      eventName = InternalEventType.EmailBounced;
      break;
    case ResendEventType.DeliveryDelayed:
      eventName = InternalEventType.EmailDropped;
      break;
    case ResendEventType.Complained:
      eventName = InternalEventType.EmailMarkedSpam;
      break;
    case ResendEventType.Delivered:
      eventName = InternalEventType.EmailDelivered;
      break;
    default:
      return err(new Error(`Unhandled event type: ${event}`));
  }

  const timestamp = new Date(created_at).toISOString();
  const properties: Record<string, string> = R.merge(
    { email },
    R.pick(tags, MESSAGE_METADATA_FIELDS),
  );
  let item: BatchTrackData;
  if (userId) {
    item = {
      type: EventType.Track,
      event: eventName,
      userId,
      messageId,
      timestamp,
      properties,
    };
  } else {
    return err(new Error("Missing userId and anonymousId."));
  }

  return ok(item);
}

export async function submitResendEvents({
  workspaceId,
  events,
}: {
  workspaceId: string;
  events: ResendEvent[];
}) {
  const data: BatchAppData = {
    context: {
      source: SourceType.Webhook,
      provider: EmailProviderType.Resend,
    },
    batch: events.flatMap((e) =>
      resendEventToDF({ workspaceId, resendEvent: e })
        .mapErr((error) => {
          logger().error(
            { err: error },
            "Failed to convert resend event to DF.",
          );
          return error;
        })
        .unwrapOr([]),
    ),
  };
  await submitBatch({
    workspaceId,
    data,
  });
}
