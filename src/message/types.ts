// Parsed message model (docs/design.md, section 4).

export const MESSAGE_TYPES = ["question", "answer", "info", "decision-needed", "ack"] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

export type RepliesRequirement = "any" | "all" | number;

export type Body =
  | { readonly state: "plain"; readonly lines: readonly string[] }
  /** Encrypted body; decryption is a later slice. */
  | { readonly state: "locked"; readonly armored: string };

export interface Message {
  readonly id: string;
  readonly path: string;
  /** "YYYY-MM-DD HH:MM" from the id, in the repository's time zone. */
  readonly timestamp: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly topic: string;
  /** null when the value is not a known message type. */
  readonly type: MessageType | null;
  readonly replyTo: string | null;
  /** Minimum answer threshold for a question, or null when not specified/valid. */
  readonly replies: RepliesRequirement | null;
  readonly refs: readonly string[];
  /** null when nothing is requested ("none"). */
  readonly needs: string | null;
  readonly due: string | null;
  readonly body: Body;
  /** Non-fatal validation findings. */
  readonly issues: readonly string[];
}

export type ParsedFile =
  | { readonly kind: "message"; readonly message: Message }
  | {
      readonly kind: "malformed";
      readonly path: string;
      readonly errors: readonly string[];
      readonly raw: string;
    };
