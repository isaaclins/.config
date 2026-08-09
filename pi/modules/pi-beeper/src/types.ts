export type Direction = "before" | "after";

export interface BeeperInfo {
  app: {
    name: string;
    version: string;
    bundle_id: string;
  };
  platform: {
    os: string;
    arch: string;
    release?: string;
  };
  server: {
    status: string;
    base_url: string;
    port: number;
    hostname: string;
    remote_access: boolean;
    mcp_enabled: boolean;
  };
  endpoints: {
    oauth: {
      authorization_endpoint: string;
      token_endpoint: string;
      introspection_endpoint: string;
      userinfo_endpoint: string;
      revocation_endpoint: string;
      registration_endpoint: string;
    };
    spec: string;
    mcp: string;
    ws_events: string;
  };
}

export interface BeeperUser {
  id: string;
  username?: string;
  phoneNumber?: string;
  email?: string;
  fullName?: string;
  imgURL?: string;
  cannotMessage?: boolean;
  isSelf?: boolean;
}

export interface BeeperAccountBridge {
  id: string;
  type: string;
  provider: "cloud" | "self-hosted" | "local" | "platform-sdk";
}

export type BeeperAccountStatus =
  | "connected"
  | "connecting"
  | "backfilling"
  | "connection_required"
  | "reconnect_required"
  | "attention_required"
  | "disconnected"
  | "disabled";

export interface BeeperAccount {
  accountID: string;
  loginID?: string;
  bridge: BeeperAccountBridge;
  network?: string;
  user: BeeperUser;
  status: BeeperAccountStatus;
  statusText?: string;
  capabilities?: Record<string, unknown>;
}

export interface BeeperParticipant extends BeeperUser {
  isAdmin?: boolean;
  isPending?: boolean;
  isNetworkBot?: boolean;
}

export interface BeeperParticipants {
  items: BeeperParticipant[];
  hasMore: boolean;
  total: number;
}

export interface BeeperChat {
  id: string;
  localChatID?: string | null;
  accountID: string;
  network: string;
  title: string;
  description?: string | null;
  imgURL?: string | null;
  type: "single" | "group";
  isReadOnly?: boolean;
  participants: BeeperParticipants;
  lastActivity?: string;
  unreadCount: number;
  unreadMentionsCount?: number;
  lastReadMessageSortKey?: string;
  isArchived?: boolean;
  isMarkedUnread?: boolean;
  isMuted?: boolean;
  isPinned?: boolean;
  isLowPriority?: boolean;
  messageExpirySeconds?: number | null;
}

export interface BeeperSendStatus {
  reason?: string;
  message?: string;
  status: "SUCCESS" | "PENDING" | "FAIL_RETRIABLE" | "FAIL_PERMANENT";
  timestamp: string;
  deliveredToUsers?: string[];
  internalError?: string;
}

export interface BeeperMessage {
  id: string;
  chatID: string;
  accountID: string;
  senderID: string;
  senderName?: string;
  timestamp: string;
  sortKey: string;
  type?:
    | "TEXT"
    | "NOTICE"
    | "IMAGE"
    | "VIDEO"
    | "VOICE"
    | "AUDIO"
    | "FILE"
    | "STICKER"
    | "LOCATION"
    | "REACTION";
  text?: string;
  editedTimestamp?: string;
  isSender?: boolean;
  sendStatus?: BeeperSendStatus;
  isHidden?: boolean;
  isDeleted?: boolean;
  attachments?: Array<{
    id?: string;
    type: "unknown" | "img" | "video" | "audio";
    srcURL?: string;
    mimeType?: string;
    fileName?: string;
    fileSize?: number;
    isGif?: boolean;
    isSticker?: boolean;
    isVoiceNote?: boolean;
    duration?: number;
  }>;
  isUnread?: boolean;
  linkedMessageID?: string;
  mentions?: string[] | null;
  reactions?: Array<{
    id: string;
    reactionKey: string;
    participantID: string;
    imgURL?: string;
    emoji?: boolean;
  }>;
}

export interface BeeperListChatsOutput {
  items: Array<BeeperChat & { preview?: BeeperMessage }>;
  hasMore: boolean;
  oldestCursor: string | null;
  newestCursor: string | null;
}

export interface BeeperSearchChatsOutput {
  items: BeeperChat[];
  hasMore: boolean;
  oldestCursor: string | null;
  newestCursor: string | null;
}

export interface BeeperListMessagesOutput {
  items: BeeperMessage[];
  hasMore: boolean;
  oldestCursor: string | null;
  newestCursor: string | null;
}

export interface BeeperSearchMessagesOutput {
  items: BeeperMessage[];
  hasMore: boolean;
  oldestCursor: string | null;
  newestCursor: string | null;
  chats: Record<string, BeeperChat>;
}

export interface BeeperAddReactionOutput {
  success: true;
  chatID: string;
  messageID: string;
  reactionKey: string;
  transactionID: string;
}

export interface OAuthClientRegistration {
  client_id: string;
  client_name: string;
  client_uri?: string;
  grant_types: ["authorization_code"];
  response_types: ["code"];
  redirect_uris: string[];
  scope: string;
  token_endpoint_auth_method: "none";
  client_id_issued_at: number;
  authorization_endpoint: string;
  token_endpoint: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

export interface SeenChat {
  id: string;
  title: string;
  network: string;
  accountID: string;
  type: "single" | "group";
  participantCount: number;
  participantCountIsComplete: boolean;
  isReadOnly: boolean;
}

export interface SeenAccount {
  accountID: string;
  network: string;
  status: BeeperAccountStatus;
  statusText?: string;
  userID: string;
  userHandle: string;
  userName: string;
}

export interface SafeMessage {
  id: string;
  chatID: string;
  accountID: string;
  network: string;
  sender: {
    id: string;
    handle: string;
    is_self: boolean;
  };
  timestamp: string;
  type?: BeeperMessage["type"];
  text: string;
  is_deleted: boolean;
  is_unread?: boolean;
  is_edited: boolean;
  has_attachments: boolean;
  attachment_types: string[];
  reply_to_message_id?: string;
}

export interface BeeperPagination {
  hasMore: boolean;
  oldestCursor: string | null;
  newestCursor: string | null;
}
