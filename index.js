import {
  Generate,
  addOneMessage,
  chat,
  chat_metadata,
  characters,
  default_user_avatar,
  eventSource,
  event_types,
  getCharacters,
  getCurrentChatId,
  getRequestHeaders,
  getThumbnailUrl,
  isGenerating,
  name1,
  online_status,
  reloadCurrentChat,
  saveChatConditional,
  saveSettingsDebounced,
  selectCharacterById,
  setOnlineStatus,
  this_chid,
} from "../../../../script.js";
import { Handlebars } from "../../../../lib.js";
import { extension_settings } from "../../../extensions.js";
import { power_user } from "../../../power-user.js";
import { user_avatar } from "../../../personas.js";
import { getMessageTimeStamp } from "../../../RossAscends-mods.js";
import { copyText, uuidv4 } from "../../../utils.js";

const EXTENSION_ID = "silly_friends";
const PLUGIN_ID = "silly-friends";
const MAX_MESSAGE_LENGTH = 4000;
const RELAY_REQUEST_TIMEOUT_MS = 15000;
const PENDING_CONTAINER_ID = "silly_friends_pending_messages";
const MODEL_EDIT_CONTAINER_ID = "silly_friends_model_edit_proposals";
const COMMIT_BUTTON_ID = "silly_friends_commit_turn";
const { toastr, jQuery } = globalThis;
const $ = jQuery;

const defaultSettings = Object.freeze({
  relayUrl: "",
  accessCode: "",
  tunnelProvider: "localhostrun",
  tunnelCommand: "ssh",
  promptGrouping: true,
  debug: false,
});

const runtime = {
  connected: false,
  isHost: false,
  committing: false,
  tunnelProvider: defaultSettings.tunnelProvider,
  tunnelCommand: defaultSettings.tunnelCommand,
  relayUrl: "",
  localRelayUrl: "",
  tunnelUrl: "",
  accessCode: "",
  partyId: "",
  token: "",
  memberId: "",
  hostMemberId: "",
  appliedHostSnapshotVersion: 0,
  appliedHostSnapshotKey: "",
  lastPersonaSnapshotKey: "",
  personaSnapshotTimer: null,
  personaSnapshotBusy: false,
  personaSnapshotQueued: false,
  hostSnapshotSyncTimer: null,
  hostSnapshotSyncBusy: false,
  hostSnapshotSyncQueued: false,
  typingState: new Map(),
  typingSendTimer: null,
  typingStopTimer: null,
  typingLastSentAt: 0,
  typingLastText: "",
  modelPublishTimer: null,
  modelPublishBusy: false,
  modelPublishQueued: false,
  modelPublishMinIndex: 0,
  modelGenerationStartIndex: null,
  modelSwipePublishTimer: null,
  modelSwipePublishBusy: false,
  modelSwipePublishQueued: false,
  modelSwipePublishIndex: null,
  lastPublishedModelSwipeKeys: new Map(),
  promptMacroOverride: null,
  promptMacroPreviousHelpers: null,
  previousOnlineStatus: null,
  setStatusOverride: false,
  lastSeq: 0,
  members: new Map(),
  pending: [],
  modelEditProposals: [],
  turn: {
    mode: "freeform",
    currentMemberId: "",
    durationSec: 0,
    endsAt: "",
  },
  turnControlsDirty: false,
  turnControlsFocused: false,
  editingClientMsgId: "",
  editingModelClientMsgId: "",
  seenSeq: new Set(),
  seenClientMsgIds: new Set(),
  seenModelClientMsgIds: new Set(),
  eventStream: null,
  pollTimer: null,
  pollBusy: false,
  reconnectTimer: null,
  reconnectAttempts: 0,
};

function ensureSettings() {
  extension_settings[EXTENSION_ID] = Object.assign(
    {},
    defaultSettings,
    extension_settings[EXTENSION_ID] || {},
  );
  extension_settings[EXTENSION_ID].tunnelProvider = normalizeTunnelProvider(
    extension_settings[EXTENSION_ID].tunnelProvider,
  );
  extension_settings[EXTENSION_ID].tunnelCommand =
    String(extension_settings[EXTENSION_ID].tunnelCommand || "").trim() ||
    getDefaultTunnelCommand(extension_settings[EXTENSION_ID].tunnelProvider);
  return extension_settings[EXTENSION_ID];
}

function saveSettings() {
  saveSettingsDebounced();
}

function normalizeTunnelProvider(value) {
  return String(value || "").toLowerCase() === "cloudflare"
    ? "cloudflare"
    : "localhostrun";
}

function getDefaultTunnelCommand(provider) {
  return normalizeTunnelProvider(provider) === "cloudflare"
    ? "cloudflared"
    : "ssh";
}

function logDebug(...args) {
  if (ensureSettings().debug) {
    console.debug("[silly-friends]", ...args);
  }
}

function notifyError(message) {
  if (toastr) {
    toastr.error(message, "silly-friends");
  } else {
    console.error(`[silly-friends] ${message}`);
  }
}

function notifyInfo(message) {
  if (toastr) {
    toastr.info(message, "silly-friends");
  } else {
    console.info(`[silly-friends] ${message}`);
  }
}

function renderSettings() {
  if ($("#silly_friends_settings").length) {
    return;
  }

  const settings = ensureSettings();
  const html = `
        <div id="silly_friends_settings" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>silly-friends</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="silly-friends-stack">
                    <div class="silly-friends-section">
                        <b>Party</b>
                        <div id="silly_friends_status">Disconnected</div>
                        <div id="silly_friends_roster"></div>
                        <div id="silly_friends_model_edit_panel" class="displayNone">
                            <div class="silly-friends-model-edit-title">Bot edit proposals (host approval)</div>
                            <div id="silly_friends_model_edit_list"></div>
                        </div>
                    </div>

                    <div class="silly-friends-section">
                        <b>My controls</b>
                        <div class="silly-friends-row silly-friends-row-controls">
                            <button id="silly_friends_ready_toggle" class="menu_button">Ready</button>
                        </div>
                    </div>

                    <div class="silly-friends-section">
                        <div class="silly-friends-row">
                            <label class="checkbox_label">
                                <input id="silly_friends_prompt_grouping" type="checkbox" ${settings.promptGrouping ? "checked" : ""}>
                                <span>Group party turns in prompts</span>
                            </label>
                            <label class="checkbox_label">
                                <input id="silly_friends_debug" type="checkbox" ${settings.debug ? "checked" : ""}>
                                <span>Debug logs</span>
                            </label>
                        </div>
                    </div>

                    <div id="silly_friends_host_session_submenu" class="inline-drawer displayNone">
                        <div class="inline-drawer-toggle inline-drawer-header">
                            <b>Host session controls</b>
                            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                        </div>
                        <div class="inline-drawer-content">
                            <div class="silly-friends-host-session-stack">
                                <div class="silly-friends-row silly-friends-row-controls">
                                    <button id="silly_friends_delete_all_pending" class="menu_button">Clear all pending</button>
                                    <button id="silly_friends_party_start" class="menu_button">Start party</button>
                                </div>
                                <div class="silly-friends-row">
                                    <label class="silly-friends-field">
                                        Turn mode
                                        <select id="silly_friends_turn_mode" class="text_pole">
                                            <option value="freeform">Freeform</option>
                                            <option value="turn">Turn-based</option>
                                            <option value="initiative">Initiative</option>
                                        </select>
                                    </label>
                                    <label class="silly-friends-field">
                                        Turn sec
                                        <input id="silly_friends_turn_duration" class="text_pole" type="number" min="0" max="3600" step="1" value="0">
                                    </label>
                                </div>
                                <div class="silly-friends-row silly-friends-row-controls">
                                    <button id="silly_friends_turn_apply" class="menu_button">Apply turn mode</button>
                                    <button id="silly_friends_turn_next" class="menu_button">Next turn</button>
                                </div>
                            </div>
                        </div>
                    </div>
                    <hr>
                    <div class="silly-friends-stack">
                        <b>Host</b>
                        <div class="silly-friends-row">
                            <label class="silly-friends-field">
                                Tunnel provider
                                <select id="silly_friends_tunnel_provider" class="text_pole">
                                    <option value="localhostrun" ${settings.tunnelProvider === "localhostrun" ? "selected" : ""}>localhost.run (ssh)</option>
                                    <option value="cloudflare" ${settings.tunnelProvider === "cloudflare" ? "selected" : ""}>Cloudflare quick tunnel</option>
                                </select>
                            </label>
                            <label class="silly-friends-field">
                                Command
                                <input id="silly_friends_tunnel_command" class="text_pole" type="text" value="${escapeAttribute(settings.tunnelCommand)}" placeholder="${escapeAttribute(getDefaultTunnelCommand(settings.tunnelProvider))}">
                            </label>
                            <div class="silly-friends-actions">
                                <button id="silly_friends_host_start" class="menu_button">Start party</button>
                                <button id="silly_friends_host_reload" class="menu_button">Reload</button>
                                <button id="silly_friends_host_stop" class="menu_button">Stop</button>
                            </div>
                        </div>
                        <div class="silly-friends-row">
                            <label class="silly-friends-field">
                                Invite tunnel
                                <input id="silly_friends_invite_url" class="text_pole" type="text" readonly>
                            </label>
                            <label class="silly-friends-field">
                                Code
                                <input id="silly_friends_invite_code" class="text_pole" type="text" readonly>
                            </label>
                        </div>
                    </div>
                    <hr>
                    <div class="silly-friends-stack">
                        <b>Join</b>
                        <div class="silly-friends-row">
                            <label class="silly-friends-field">
                                Tunnel URL
                                <input id="silly_friends_relay_url" class="text_pole" type="text" value="${escapeAttribute(settings.relayUrl)}" placeholder="https://example.lhr.life">
                            </label>
                            <label class="silly-friends-field">
                                Code
                                <input id="silly_friends_access_code" class="text_pole" type="password" value="${escapeAttribute(settings.accessCode)}">
                            </label>
                            <div class="silly-friends-actions">
                                <button id="silly_friends_join" class="menu_button">Join party</button>
                                <button id="silly_friends_leave" class="menu_button">Leave</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;

  $("#extensions_settings").append(html);

  $("#silly_friends_prompt_grouping").on("change", function () {
    ensureSettings().promptGrouping = !!this.checked;
    saveSettings();
  });

  $("#silly_friends_debug").on("change", function () {
    ensureSettings().debug = !!this.checked;
    saveSettings();
  });

  $("#silly_friends_tunnel_provider").on("change", function () {
    const settings = ensureSettings();
    settings.tunnelProvider = normalizeTunnelProvider($(this).val());
    settings.tunnelCommand = getDefaultTunnelCommand(settings.tunnelProvider);
    $("#silly_friends_tunnel_command")
      .val(settings.tunnelCommand)
      .attr("placeholder", settings.tunnelCommand);
    saveSettings();
  });

  $("#silly_friends_tunnel_command").on("input", function () {
    const settings = ensureSettings();
    settings.tunnelCommand =
      String($(this).val() || "").trim() ||
      getDefaultTunnelCommand(settings.tunnelProvider);
    saveSettings();
  });

  $("#silly_friends_relay_url").on("input", function () {
    ensureSettings().relayUrl = String($(this).val() || "").trim();
    saveSettings();
  });

  $("#silly_friends_access_code").on("input", function () {
    ensureSettings().accessCode = String($(this).val() || "").trim();
    saveSettings();
  });

  $("#silly_friends_host_start").on("click", () =>
    startHosting().catch(handleActionError),
  );
  $("#silly_friends_host_reload").on("click", () =>
    reloadHostSnapshot().catch(handleActionError),
  );
  $("#silly_friends_host_stop").on("click", () =>
    stopHosting().catch(handleActionError),
  );
  $("#silly_friends_join").on("click", () =>
    joinParty().catch(handleActionError),
  );
  $("#silly_friends_leave").on("click", () =>
    leaveParty().catch(handleActionError),
  );
  $("#silly_friends_ready_toggle").on("click", () =>
    toggleReady().catch(handleActionError),
  );
  $("#silly_friends_delete_all_pending").on("click", () =>
    deletePendingBatch("all").catch(handleActionError),
  );
  $("#silly_friends_turn_apply").on("click", () =>
    applyTurnConfig().catch(handleActionError),
  );
  $("#silly_friends_turn_next").on("click", () =>
    advanceTurn().catch(handleActionError),
  );
  $("#silly_friends_turn_mode, #silly_friends_turn_duration")
    .on("focusin", () => {
      runtime.turnControlsFocused = true;
    })
    .on("focusout", () => {
      runtime.turnControlsFocused = false;
    })
    .on("input change", () => {
      runtime.turnControlsDirty = true;
      updateUi();
    });
  $("#silly_friends_party_start").on("click", () =>
    startPartySession().catch(handleActionError),
  );
  $("#silly_friends_relay_url, #silly_friends_access_code").on(
    "keydown",
    (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        joinParty().catch(handleActionError);
      }
    },
  );
}

function installCommitButton() {
  const existingButton = document.getElementById(COMMIT_BUTTON_ID);
  if (existingButton) {
    if (existingButton.tagName === "DIV") {
      return;
    }
    existingButton.remove();
  }

  const sendButton = document.getElementById("send_but");
  if (!sendButton) {
    return;
  }

  const button = document.createElement("div");
  button.id = COMMIT_BUTTON_ID;
  button.className = "fa-solid fa-check interactable displayNone";
  button.role = "button";
  button.tabIndex = 0;
  button.title = "Commit party turn and generate";
  button.setAttribute("aria-label", "Commit party turn and generate");
  button.setAttribute("aria-disabled", "true");
  button.addEventListener("click", () => {
    if (button.getAttribute("aria-disabled") === "true") {
      return;
    }
    commitTurnAndGenerate().catch(handleActionError);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    if (button.getAttribute("aria-disabled") === "true") {
      return;
    }
    commitTurnAndGenerate().catch(handleActionError);
  });
  sendButton.insertAdjacentElement("afterend", button);
}

function installInputCapture() {
  const sendButton = document.getElementById("send_but");
  const textarea = document.getElementById("send_textarea");

  sendButton?.addEventListener("click", interceptSendClick, true);
  textarea?.addEventListener("keydown", interceptTextareaEnter, true);
  textarea?.addEventListener("input", handleTextareaInput);
}

function handleTextareaInput() {
  updateUi();
  scheduleTypingPublish();
}

function interceptSendClick(event) {
  if (!shouldInterceptNativeSend()) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();
  submitTextareaAsPending().catch(handleActionError);
}

function interceptTextareaEnter(event) {
  if (
    !shouldInterceptNativeSend() ||
    event.key !== "Enter" ||
    event.shiftKey ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey
  ) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();
  submitTextareaAsPending().catch(handleActionError);
}

function shouldInterceptNativeSend() {
  return runtime.connected && !!runtime.token && !!runtime.relayUrl;
}

async function startHosting() {
  const settings = ensureSettings();
  const hostProfile = await getCurrentPersonaProfile();
  const snapshot = await buildHostSnapshot();
  const tunnelProvider = normalizeTunnelProvider(settings.tunnelProvider);
  const tunnelCommand =
    String(settings.tunnelCommand || "").trim() ||
    getDefaultTunnelCommand(tunnelProvider);
  setBusy(true);

  try {
    await assertHostPluginAvailable();
    setStatusText("Starting party tunnel...");
    const response = await fetch(`/api/plugins/${PLUGIN_ID}/host/start`, {
      method: "POST",
      headers: getRequestHeaders(),
      body: JSON.stringify({
        tunnelProvider,
        tunnelCommand,
        hostName: hostProfile.personaName,
        hostDescription: hostProfile.personaDescription,
        avatarDataUrl: hostProfile.avatarDataUrl,
        snapshot,
      }),
    });
    const data = await readJsonResponse(response);

    disconnectRuntime({ keepHostRelay: true });
    runtime.connected = true;
    runtime.isHost = true;
    runtime.tunnelProvider = data.tunnelProvider || tunnelProvider;
    runtime.tunnelCommand = data.tunnelCommand || tunnelCommand;
    runtime.localRelayUrl = normalizeRelayUrl(data.localRelayUrl);
    runtime.tunnelUrl = normalizeRelayUrl(data.tunnelUrl);
    runtime.relayUrl = runtime.tunnelUrl || runtime.localRelayUrl;
    runtime.accessCode = data.accessCode;
    runtime.partyId = data.partyId;
    runtime.token = data.hostToken;
    runtime.memberId = data.hostMemberId;
    runtime.hostMemberId = data.hostMemberId;
    runtime.lastPersonaSnapshotKey = getPersonaSnapshotKey(hostProfile);
    hydrateSeenFromChat(runtime.partyId);
    await applySnapshot(data);
    connectEventStream();

    settings.relayUrl = runtime.tunnelUrl;
    settings.accessCode = runtime.accessCode;
    settings.tunnelProvider = runtime.tunnelProvider;
    settings.tunnelCommand = runtime.tunnelCommand;
    saveSettings();
    notifyInfo("Party tunnel started.");
  } finally {
    setBusy(false);
    updateUi();
  }
}

async function assertHostPluginAvailable() {
  const response = await fetch(`/api/plugins/${PLUGIN_ID}/host/status`, {
    method: "GET",
    headers: getRequestHeaders({ omitContentType: true }),
  });

  if (response.status === 404) {
    throw new Error(
      "silly-friends server plugin endpoint was not found. Set enableServerPlugins: true in config.yaml, restart SillyTavern, then try hosting again.",
    );
  }

  await readJsonResponse(response);
}

async function assertRelayAvailable(relayUrl) {
  const data = await relayGet("/health", {}, relayUrl);
  if (!data?.ok || !data.partyId) {
    throw new Error(
      "This URL is reachable, but it is not a silly-friends relay.",
    );
  }
}

async function stopHosting() {
  if (!runtime.isHost) {
    disconnectRuntime();
    return;
  }

  setBusy(true);
  try {
    await fetch(`/api/plugins/${PLUGIN_ID}/host/stop`, {
      method: "POST",
      headers: getRequestHeaders(),
      body: JSON.stringify({}),
    });
    disconnectRuntime();
    notifyInfo("Party stopped.");
  } finally {
    setBusy(false);
    updateUi();
  }
}

function parseInviteInput(rawRelayUrl, rawAccessCode) {
  let relayUrl = normalizeRelayUrl(rawRelayUrl);
  let accessCode = String(rawAccessCode || "").trim();

  if (relayUrl && !accessCode) {
    const parts = relayUrl.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      relayUrl = normalizeRelayUrl(parts[0]);
      accessCode = parts[1];
    }
  }

  if (relayUrl) {
    try {
      const url = new URL(relayUrl);
      const codeFromQuery = url.searchParams.get("code");
      if (!accessCode && codeFromQuery) {
        accessCode = codeFromQuery.trim();
      }
      url.search = "";
      url.hash = "";
      relayUrl = normalizeRelayUrl(url.toString());
    } catch {
      throw new Error("Tunnel URL is invalid.");
    }
  }

  $("#silly_friends_relay_url").val(relayUrl);
  $("#silly_friends_access_code").val(accessCode);

  return { relayUrl, accessCode };
}

async function joinParty() {
  const settings = ensureSettings();
  const parsedInvite = parseInviteInput(
    String(
      $("#silly_friends_relay_url").val() || settings.relayUrl || "",
    ).trim(),
    String(
      $("#silly_friends_access_code").val() || settings.accessCode || "",
    ).trim(),
  );
  const relayUrl = parsedInvite.relayUrl;
  const accessCode = parsedInvite.accessCode;

  if (!relayUrl || !accessCode) {
    throw new Error("Tunnel URL and code are required.");
  }

  const profile = await getCurrentPersonaProfile();
  setBusy(true);

  try {
    setStatusText("Checking party tunnel...");
    await assertRelayAvailable(relayUrl);
    setStatusText("Joining party...");
    const data = await relayPost(
      "/join",
      {
        accessCode,
        personaName: profile.personaName,
        personaDescription: profile.personaDescription,
        avatarDataUrl: profile.avatarDataUrl,
      },
      relayUrl,
    );

    disconnectRuntime({ keepHostRelay: true });
    runtime.connected = true;
    runtime.isHost = false;
    runtime.relayUrl = relayUrl;
    runtime.tunnelUrl = relayUrl;
    runtime.accessCode = accessCode;
    runtime.partyId = data.partyId;
    runtime.token = data.token;
    runtime.memberId = data.memberId;
    runtime.hostMemberId = data.hostMemberId;
    runtime.lastPersonaSnapshotKey = getPersonaSnapshotKey(profile);
    hydrateSeenFromChat(runtime.partyId);
    setGuestOnlineStatus();
    await applySnapshot(data);
    connectEventStream();

    settings.relayUrl = relayUrl;
    settings.accessCode = accessCode;
    saveSettings();
    notifyInfo("Joined party.");
  } catch (error) {
    disconnectRuntime();
    throw error;
  } finally {
    setBusy(false);
    updateUi();
  }
}

async function leaveParty() {
  if (runtime.isHost) {
    await stopHosting();
    return;
  }

  disconnectRuntime();
  notifyInfo("Left party.");
}

async function toggleReady() {
  if (!runtime.connected || !runtime.token || !runtime.memberId) {
    throw new Error("Not connected to a party.");
  }

  const me = runtime.members.get(runtime.memberId);
  const ready = !me?.ready;
  const data = await relayPost("/member/ready", {
    token: runtime.token,
    ready,
  });
  if (data.event) {
    await handleRelayEvent(data.event);
  } else if (data.member) {
    runtime.members.set(data.member.id, data.member);
    updateUi();
  }
}

async function deletePendingBatch(scope = "own") {
  if (!runtime.connected || !runtime.token) {
    throw new Error("Not connected to a party.");
  }

  const normalizedScope =
    String(scope || "own").toLowerCase() === "all" ? "all" : "own";
  if (normalizedScope === "all" && !canModerateActions()) {
    throw new Error("Only host/cohost can clear all pending.");
  }

  const data = await relayPost("/message/delete-all", {
    token: runtime.token,
    scope: normalizedScope,
  });

  if (data.event) {
    await handleRelayEvent(data.event);
  } else if (Array.isArray(data.removed)) {
    removePendingByClientIds(data.removed);
    renderPendingMessages();
    updateUi();
  }
}

async function applyTurnConfig() {
  if (!runtime.connected || !runtime.token) {
    throw new Error("Not connected to a party.");
  }

  if (!canCommitActions()) {
    throw new Error("Only host/cohost can change turn config.");
  }

  const mode =
    normalizeTurnMode($("#silly_friends_turn_mode").val()) || "freeform";
  const durationSec = normalizeTurnDuration(
    $("#silly_friends_turn_duration").val(),
  );
  const data = await relayPost("/turn/config", {
    token: runtime.token,
    mode,
    durationSec,
  });

  if (data.event) {
    await handleRelayEvent(data.event);
  } else if (data.turn) {
    runtime.turn = normalizeTurnState(data.turn);
    runtime.turnControlsDirty = false;
    syncTurnControls({ force: true });
    updateUi();
  }
}

async function advanceTurn() {
  if (!runtime.connected || !runtime.token) {
    throw new Error("Not connected to a party.");
  }

  if (!canCommitActions()) {
    throw new Error("Only host/cohost can advance turns.");
  }

  const data = await relayPost("/turn/next", {
    token: runtime.token,
  });

  if (data.event) {
    await handleRelayEvent(data.event);
  } else if (data.turn) {
    runtime.turn = normalizeTurnState(data.turn);
    runtime.turnControlsDirty = false;
    syncTurnControls({ force: true });
    updateUi();
  }
}

async function startPartySession() {
  if (!runtime.connected || !runtime.token) {
    throw new Error("Not connected to a party.");
  }

  if (!canCommitActions()) {
    throw new Error("Only host/cohost can start the party.");
  }

  const data = await relayPost("/party/start", {
    token: runtime.token,
  });

  if (data.event) {
    await handleRelayEvent(data.event);
  }
}

async function setMemberRole(memberId, role) {
  if (!runtime.connected || !runtime.token) {
    throw new Error("Not connected to a party.");
  }

  if (!canModerateActions()) {
    throw new Error("Only host/cohost can change roles.");
  }

  const id = sanitizeRelayId(memberId);
  const normalizedRole = normalizeMemberRole(role);
  if (!id || !normalizedRole) {
    throw new Error("Invalid member role request.");
  }

  const data = await relayPost("/member/role", {
    token: runtime.token,
    memberId: id,
    role: normalizedRole,
  });

  if (data.event) {
    await handleRelayEvent(data.event);
  } else if (data.member) {
    runtime.members.set(data.member.id, data.member);
    updateUi();
  }
}

async function setMemberMuted(memberId, muted) {
  if (!runtime.connected || !runtime.token) {
    throw new Error("Not connected to a party.");
  }

  if (!canModerateActions()) {
    throw new Error("Only host/cohost can mute members.");
  }

  const id = sanitizeRelayId(memberId);
  if (!id) {
    throw new Error("Invalid member id.");
  }

  const data = await relayPost("/member/mute", {
    token: runtime.token,
    memberId: id,
    muted: !!muted,
  });

  if (data.event) {
    await handleRelayEvent(data.event);
  } else if (data.member) {
    runtime.members.set(data.member.id, data.member);
    updateUi();
  }
}

async function kickMember(memberId) {
  if (!runtime.connected || !runtime.token) {
    throw new Error("Not connected to a party.");
  }

  if (!canModerateActions()) {
    throw new Error("Only host/cohost can kick members.");
  }

  const id = sanitizeRelayId(memberId);
  if (!id) {
    throw new Error("Invalid member id.");
  }

  const data = await relayPost("/member/kick", {
    token: runtime.token,
    memberId: id,
  });

  if (Array.isArray(data.events)) {
    for (const event of data.events) {
      await handleRelayEvent(event);
    }
  } else if (data.event) {
    await handleRelayEvent(data.event);
  }
}

function scheduleTypingPublish() {
  if (!runtime.connected || !runtime.token || !runtime.relayUrl) {
    return;
  }

  const textarea = document.getElementById("send_textarea");
  const text = String(textarea?.value || "");
  const isTyping = text.trim().length > 0;
  const now = Date.now();

  if (runtime.typingStopTimer) {
    clearTimeout(runtime.typingStopTimer);
    runtime.typingStopTimer = null;
  }

  if (!isTyping) {
    runtime.typingLastText = "";
    void publishTyping(false);
    return;
  }

  runtime.typingLastText = text;
  runtime.typingStopTimer = setTimeout(() => {
    runtime.typingStopTimer = null;
    runtime.typingLastText = "";
    void publishTyping(false);
  }, 2500);

  if (now - runtime.typingLastSentAt < 1200) {
    if (!runtime.typingSendTimer) {
      runtime.typingSendTimer = setTimeout(() => {
        runtime.typingSendTimer = null;
        void publishTyping(true);
      }, 1200);
    }
    return;
  }

  void publishTyping(true);
}

async function publishTyping(isTyping) {
  if (!runtime.connected || !runtime.token || !runtime.relayUrl) {
    return;
  }

  runtime.typingLastSentAt = Date.now();
  try {
    const data = await relayPost("/typing", {
      token: runtime.token,
      typing: !!isTyping,
    });
    if (data.event) {
      await handleRelayEvent(data.event);
    }
  } catch (error) {
    logDebug("Failed to publish typing state", error);
  }
}

async function submitTextareaAsPending({ allowEmpty = false } = {}) {
  const textarea = document.getElementById("send_textarea");
  const text = String(textarea?.value || "").trim();

  if (!text) {
    return null;
  }

  if (text.length > MAX_MESSAGE_LENGTH) {
    throw new Error(
      `Party move is too long. Limit: ${MAX_MESSAGE_LENGTH} characters.`,
    );
  }

  if (!runtime.connected || !runtime.token) {
    if (allowEmpty) {
      return null;
    }
    throw new Error("Not connected to a party.");
  }

  if (runtime.editingClientMsgId) {
    return updatePendingFromTextarea(text, textarea);
  }

  if (runtime.editingModelClientMsgId) {
    return submitModelEditProposalFromTextarea(text, textarea);
  }

  const originalText = textarea?.value || "";

  const clientMsgId = uuidv4();
  let data;
  try {
    if (textarea) {
      textarea.value = "";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }

    const profile = await getCurrentPersonaProfile();
    data = await relayPost("/message", {
      token: runtime.token,
      text,
      clientMsgId,
      personaName: profile.personaName,
      personaDescription: profile.personaDescription,
      avatarDataUrl: profile.avatarDataUrl,
    });
  } catch (error) {
    if (textarea && !textarea.value) {
      textarea.value = originalText;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    throw error;
  }

  if (data.event) {
    await handleRelayEvent(data.event);
  }

  return data.event || null;
}

async function updatePendingFromTextarea(text, textarea) {
  const pending = runtime.pending.find(
    (item) => item.clientMsgId === runtime.editingClientMsgId,
  );
  if (!pending) {
    runtime.editingClientMsgId = "";
    throw new Error("Pending move no longer exists.");
  }

  if (pending.memberId !== runtime.memberId) {
    runtime.editingClientMsgId = "";
    throw new Error("You can only edit your own pending messages.");
  }

  const originalText = textarea?.value || "";
  let data;
  try {
    if (textarea) {
      textarea.value = "";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }

    const profile = await getCurrentPersonaProfile();
    data = await relayPost("/message/edit", {
      token: runtime.token,
      clientMsgId: pending.clientMsgId,
      text,
      personaName: profile.personaName,
      personaDescription: profile.personaDescription,
      avatarDataUrl: profile.avatarDataUrl,
    });
    runtime.editingClientMsgId = "";
  } catch (error) {
    if (textarea && !textarea.value) {
      textarea.value = originalText;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    throw error;
  }

  if (data.event) {
    await handleRelayEvent(data.event);
  }

  return data.event || null;
}

async function submitModelEditProposalFromTextarea(text, textarea) {
  const targetModelClientMsgId = sanitizeRelayId(
    textarea?.dataset?.sillyFriendsModelClientMsgId,
  );
  if (!targetModelClientMsgId) {
    runtime.editingModelClientMsgId = "";
    if (textarea) {
      delete textarea.dataset.sillyFriendsModelClientMsgId;
    }
    throw new Error("No target bot message selected for edit proposal.");
  }

  const proposalClientMsgId =
    sanitizeRelayId(runtime.editingModelClientMsgId) || uuidv4();

  const originalText = textarea?.value || "";
  let data;
  try {
    if (textarea) {
      textarea.value = "";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }

    data = await proposeModelEdit({
      modelClientMsgId: targetModelClientMsgId,
      text,
      proposalClientMsgId,
    });

    runtime.editingModelClientMsgId = "";
    if (textarea) {
      delete textarea.dataset.sillyFriendsModelClientMsgId;
    }
    notifyInfo("Bot edit proposal sent to host for approval.");
    renderModelEditProposals();
    decoratePartyMessages();
    updateUi();
  } catch (error) {
    if (textarea && !textarea.value) {
      textarea.value = originalText;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    throw error;
  }

  return data?.event || null;
}

async function commitTurnAndGenerate() {
  if (
    !runtime.connected ||
    !runtime.isHost ||
    runtime.committing ||
    isGenerating()
  ) {
    return;
  }

  runtime.committing = true;
  updateUi();

  try {
    await submitTextareaAsPending({ allowEmpty: true });

    const clientMsgIds = runtime.pending
      .map((pending) => pending.clientMsgId)
      .filter(Boolean);
    if (!clientMsgIds.length) {
      return;
    }

    const data = await relayPost("/commit-turn", {
      token: runtime.token,
      clientMsgIds,
    });

    for (const event of data.events || []) {
      await handleRelayEvent(event);
    }

    const beforeLength = chat.length;
    runtime.modelGenerationStartIndex = beforeLength;
    await Generate("normal");
    await publishLatestModelMessage({
      minIndex: beforeLength,
      reason: "commitTurn",
    });
  } finally {
    runtime.committing = false;
    updateUi();
  }
}

async function reloadHostSnapshot() {
  if (!runtime.connected || !runtime.isHost || !runtime.token) {
    throw new Error("Only the host can reload the party snapshot.");
  }

  setBusy(true);
  try {
    setStatusText("Reloading party snapshot...");
    await publishHostSnapshot();
    notifyInfo("Party snapshot reloaded.");
  } finally {
    setBusy(false);
    updateUi();
  }
}

async function publishHostSnapshot() {
  if (!runtime.connected || !runtime.isHost || !runtime.token) {
    return;
  }

  const snapshot = await buildHostSnapshot();
  snapshot.seq = runtime.lastSeq;
  const data = await relayPost("/snapshot", {
    token: runtime.token,
    snapshot,
  });
  if (data.event) {
    await handleRelayEvent(data.event);
  }
}

function scheduleHostSnapshotSync(reason = "chatChanged") {
  if (!runtime.connected || !runtime.isHost || !runtime.token) {
    return;
  }

  runtime.hostSnapshotSyncQueued = true;
  clearTimeout(runtime.hostSnapshotSyncTimer);
  runtime.hostSnapshotSyncTimer = setTimeout(() => {
    runtime.hostSnapshotSyncTimer = null;
    publishQueuedHostSnapshot(reason).catch((error) => {
      logDebug("Failed to sync host snapshot", error);
    });
  }, 350);
}

async function publishQueuedHostSnapshot(reason = "chatChanged") {
  if (!runtime.connected || !runtime.isHost || !runtime.token) {
    return;
  }

  if (runtime.hostSnapshotSyncBusy) {
    runtime.hostSnapshotSyncQueued = true;
    return;
  }

  runtime.hostSnapshotSyncBusy = true;
  runtime.hostSnapshotSyncQueued = true;
  try {
    while (
      runtime.connected &&
      runtime.isHost &&
      runtime.token &&
      runtime.hostSnapshotSyncQueued
    ) {
      runtime.hostSnapshotSyncQueued = false;
      logDebug("Publishing host snapshot sync", reason);
      await publishHostSnapshot();
    }
  } finally {
    runtime.hostSnapshotSyncBusy = false;
    if (runtime.hostSnapshotSyncQueued) {
      scheduleHostSnapshotSync(reason);
    }
  }
}

function schedulePersonaSnapshot() {
  if (!runtime.connected || !runtime.token) {
    return;
  }

  runtime.personaSnapshotQueued = true;
  clearTimeout(runtime.personaSnapshotTimer);
  runtime.personaSnapshotTimer = setTimeout(() => {
    runtime.personaSnapshotTimer = null;
    publishPersonaSnapshot().catch((error) => {
      logDebug("Failed to publish persona snapshot", error);
    });
  }, 250);
}

async function publishPersonaSnapshot() {
  if (!runtime.connected || !runtime.token) {
    return;
  }

  if (runtime.personaSnapshotBusy) {
    runtime.personaSnapshotQueued = true;
    return;
  }

  runtime.personaSnapshotQueued = true;
  runtime.personaSnapshotBusy = true;
  try {
    while (runtime.connected && runtime.token && runtime.personaSnapshotQueued) {
      runtime.personaSnapshotQueued = false;
      const profile = await getCurrentPersonaProfile();
      const profileKey = getPersonaSnapshotKey(profile);
      if (profileKey === runtime.lastPersonaSnapshotKey) {
        continue;
      }

      const data = await relayPost("/profile", {
        token: runtime.token,
        personaName: profile.personaName,
        personaDescription: profile.personaDescription,
        avatarDataUrl: profile.avatarDataUrl,
      });

      runtime.lastPersonaSnapshotKey = profileKey;
      if (data.event) {
        await handleRelayEvent(data.event);
      } else if (data.member) {
        runtime.members.set(data.member.id, data.member);
        updateUi();
      }
    }
  } finally {
    runtime.personaSnapshotBusy = false;
    if (runtime.personaSnapshotQueued) {
      schedulePersonaSnapshot();
    }
  }
}

function normalizeChatIndex(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    const fallbackNumber = Number(fallback);
    return Number.isFinite(fallbackNumber)
      ? Math.max(0, Math.floor(fallbackNumber))
      : 0;
  }

  return Math.max(0, Math.floor(number));
}

function findLatestUnpublishedModelMessage(minIndex = 0) {
  const startIndex = normalizeChatIndex(minIndex);

  for (let index = chat.length - 1; index >= startIndex; index -= 1) {
    const message = chat[index];
    if (
      !message ||
      message.is_user ||
      message.is_system ||
      !String(message.mes || "").trim()
    ) {
      continue;
    }

    const modelMeta = message.extra?.sillyFriendsModel;
    if (
      modelMeta?.partyId === runtime.partyId &&
      sanitizeRelayId(modelMeta.clientMsgId)
    ) {
      return null;
    }

    return { index, message };
  }

  return null;
}

function scheduleModelMessagePublish({ minIndex = 0, reason = "" } = {}) {
  if (!runtime.isHost || !runtime.connected || !runtime.token) {
    return;
  }

  const nextMinIndex = normalizeChatIndex(minIndex);
  runtime.modelPublishMinIndex = runtime.modelPublishQueued
    ? Math.min(runtime.modelPublishMinIndex, nextMinIndex)
    : nextMinIndex;
  runtime.modelPublishQueued = true;
  clearTimeout(runtime.modelPublishTimer);
  runtime.modelPublishTimer = setTimeout(() => {
    runtime.modelPublishTimer = null;
    publishLatestModelMessage({
      minIndex: runtime.modelPublishMinIndex,
      reason,
    }).catch((error) => {
      logDebug("Failed to publish generated model message", error);
    });
  }, 150);
}

async function publishLatestModelMessage({ minIndex = 0, reason = "" } = {}) {
  if (!runtime.isHost || !runtime.connected || !runtime.token) {
    return;
  }

  const nextMinIndex = normalizeChatIndex(minIndex);
  if (runtime.modelPublishBusy) {
    runtime.modelPublishMinIndex = runtime.modelPublishQueued
      ? Math.min(runtime.modelPublishMinIndex, nextMinIndex)
      : nextMinIndex;
    runtime.modelPublishQueued = true;
    return;
  }

  runtime.modelPublishBusy = true;
  runtime.modelPublishQueued = true;
  runtime.modelPublishMinIndex = nextMinIndex;

  try {
    while (
      runtime.isHost &&
      runtime.connected &&
      runtime.token &&
      runtime.modelPublishQueued
    ) {
      const currentMinIndex = runtime.modelPublishMinIndex;
      runtime.modelPublishQueued = false;
      runtime.modelPublishMinIndex = chat.length;

      const generatedEntry = findLatestUnpublishedModelMessage(currentMinIndex);
      if (!generatedEntry) {
        logDebug("No generated model message to mirror.", {
          minIndex: currentMinIndex,
          reason,
          chatLength: chat.length,
        });
        if (reason === "generationEnded") {
          runtime.modelGenerationStartIndex = null;
        }
        continue;
      }

      const { index, message: generated } = generatedEntry;
      const clientMsgId = uuidv4();
      const previousExtra = generated.extra || {};
      const hadModelMeta = Object.prototype.hasOwnProperty.call(
        previousExtra,
        "sillyFriendsModel",
      );
      const previousModelMeta = hadModelMeta
        ? cloneJson(previousExtra.sillyFriendsModel)
        : null;
      generated.extra = generated.extra || {};
      generated.extra.sillyFriendsModel = {
        partyId: runtime.partyId,
        clientMsgId,
      };
      chat_metadata.tainted = true;
      await saveChatConditional();
      runtime.seenModelClientMsgIds.add(clientMsgId);

      let data;
      try {
        data = await relayPost("/model-message", {
          token: runtime.token,
          clientMsgId,
          name: generated.name,
          text: generated.mes,
          sendDate: generated.send_date || getMessageTimeStamp(),
          extra: generated.extra,
          forceAvatar: isShareableAvatarUrl(generated.force_avatar)
            ? generated.force_avatar
            : "",
        });
      } catch (error) {
        if (hadModelMeta) {
          generated.extra.sillyFriendsModel = previousModelMeta;
        } else {
          delete generated.extra.sillyFriendsModel;
        }
        runtime.seenModelClientMsgIds.delete(clientMsgId);
        chat_metadata.tainted = true;
        await saveChatConditional();
        throw error;
      }

      if (data.event?.seq) {
        generated.extra.sillyFriendsModel.seq = data.event.seq;
        chat_metadata.tainted = true;
        await saveChatConditional();
        runtime.modelGenerationStartIndex = null;
        logDebug("Published generated model message", {
          index,
          seq: data.event.seq,
          clientMsgId,
          reason,
        });
        await handleRelayEvent(data.event);
      }
    }
  } finally {
    runtime.modelPublishBusy = false;
    if (runtime.modelPublishQueued) {
      scheduleModelMessagePublish({
        minIndex: runtime.modelPublishMinIndex,
        reason,
      });
    }
  }
}

function isPendingGeneratedSwipe(message) {
  const swipeId = Number(message?.swipe_id);
  return (
    Number.isInteger(swipeId) &&
    Array.isArray(message?.swipes) &&
    swipeId >= message.swipes.length
  );
}

function getModelClientMsgId(message) {
  return sanitizeRelayId(message?.extra?.sillyFriendsModel?.clientMsgId);
}

function getModelSwipePublishKey(message) {
  const clientMsgId = getModelClientMsgId(message);
  const swipeId = Number.isInteger(Number(message?.swipe_id))
    ? Number(message.swipe_id)
    : 0;
  const swipesLength = Array.isArray(message?.swipes)
    ? message.swipes.length
    : 0;
  return [
    clientMsgId,
    swipeId,
    swipesLength,
    stableHash(String(message?.mes || "")),
  ].join(":");
}

function normalizeMessageSwipes(message) {
  const swipes = Array.isArray(message?.swipes)
    ? message.swipes.map((swipe) => String(swipe ?? ""))
    : [];
  if (!swipes.length) {
    swipes.push(String(message?.mes || ""));
  }
  return swipes;
}

function normalizeMessageSwipeInfo(message, swipesLength) {
  const swipeInfo = Array.isArray(message?.swipe_info)
    ? message.swipe_info.slice(0, swipesLength)
    : [];
  while (swipeInfo.length < swipesLength) {
    swipeInfo.push({});
  }
  return cloneJson(swipeInfo);
}

function scheduleModelSwipePublish({ messageIndex, reason = "" } = {}) {
  if (!runtime.isHost || !runtime.connected || !runtime.token) {
    return;
  }

  const index = normalizeChatIndex(messageIndex, chat.length - 1);
  runtime.modelSwipePublishIndex = index;
  runtime.modelSwipePublishQueued = true;
  clearTimeout(runtime.modelSwipePublishTimer);
  runtime.modelSwipePublishTimer = setTimeout(() => {
    runtime.modelSwipePublishTimer = null;
    publishModelSwipe({
      messageIndex: runtime.modelSwipePublishIndex,
      reason,
    }).catch((error) => {
      logDebug("Failed to publish model swipe", error);
    });
  }, 150);
}

async function publishModelSwipe({ messageIndex, reason = "" } = {}) {
  if (!runtime.isHost || !runtime.connected || !runtime.token) {
    return;
  }

  if (runtime.modelSwipePublishBusy) {
    runtime.modelSwipePublishIndex = normalizeChatIndex(
      messageIndex,
      chat.length - 1,
    );
    runtime.modelSwipePublishQueued = true;
    return;
  }

  runtime.modelSwipePublishBusy = true;
  runtime.modelSwipePublishQueued = true;
  runtime.modelSwipePublishIndex = normalizeChatIndex(
    messageIndex,
    chat.length - 1,
  );

  try {
    while (
      runtime.isHost &&
      runtime.connected &&
      runtime.token &&
      runtime.modelSwipePublishQueued
    ) {
      const index = normalizeChatIndex(
        runtime.modelSwipePublishIndex,
        chat.length - 1,
      );
      runtime.modelSwipePublishQueued = false;
      runtime.modelSwipePublishIndex = null;

      const message = chat[index];
      if (
        !message ||
        message.is_user ||
        message.is_system ||
        isPendingGeneratedSwipe(message)
      ) {
        logDebug("No publishable model swipe state.", { index, reason });
        continue;
      }

      const clientMsgId = getModelClientMsgId(message);
      if (!clientMsgId) {
        await publishLatestModelMessage({
          minIndex: index,
          reason: reason || "swipeWithoutModelId",
        });
        continue;
      }

      const publishKey = getModelSwipePublishKey(message);
      if (runtime.lastPublishedModelSwipeKeys.get(clientMsgId) === publishKey) {
        continue;
      }

      const swipeId = Number.isInteger(Number(message.swipe_id))
        ? Number(message.swipe_id)
        : 0;
      const swipes = normalizeMessageSwipes(message);
      const swipeInfo = normalizeMessageSwipeInfo(message, swipes.length);
      const extra = cloneJson(message.extra || {});
      extra.sillyFriendsModel = Object.assign(
        {},
        extra.sillyFriendsModel || {},
        {
          partyId: runtime.partyId,
          clientMsgId,
        },
      );

      const data = await relayPost("/model-swipe", {
        token: runtime.token,
        clientMsgId,
        targetModelSeq: Number(message.extra?.sillyFriendsModel?.seq) || 0,
        name: message.name,
        text: message.mes,
        sendDate: message.send_date || getMessageTimeStamp(),
        extra,
        forceAvatar: isShareableAvatarUrl(message.force_avatar)
          ? message.force_avatar
          : "",
        swipeId,
        swipes,
        swipeInfo,
      });

      if (data.event?.seq) {
        message.extra = message.extra || {};
        message.extra.sillyFriendsModel = Object.assign(
          {},
          message.extra.sillyFriendsModel || {},
          {
            partyId: runtime.partyId,
            clientMsgId,
            seq: data.event.seq,
            lastSwipeSeq: data.event.seq,
          },
        );
        chat_metadata.tainted = true;
        await saveChatConditional();
        runtime.lastPublishedModelSwipeKeys.set(clientMsgId, publishKey);
        logDebug("Published model swipe", {
          index,
          seq: data.event.seq,
          clientMsgId,
          swipeId,
          reason,
        });
        await handleRelayEvent(data.event);
      }
    }
  } finally {
    runtime.modelSwipePublishBusy = false;
    if (runtime.modelSwipePublishQueued) {
      scheduleModelSwipePublish({
        messageIndex: runtime.modelSwipePublishIndex,
        reason,
      });
    }
  }
}

async function proposeModelEdit({
  modelClientMsgId,
  text,
  proposalClientMsgId = "",
}) {
  if (!runtime.connected || !runtime.token) {
    throw new Error("Not connected to a party.");
  }

  const profile = await getCurrentPersonaProfile();
  const targetId = sanitizeRelayId(modelClientMsgId);
  const payload = {
    token: runtime.token,
    modelClientMsgId: targetId,
    targetModelSeq: getModelMessageSeqByClientMsgId(targetId),
    text,
    proposalClientMsgId: sanitizeRelayId(proposalClientMsgId) || uuidv4(),
    personaName: profile.personaName,
    personaDescription: profile.personaDescription,
    avatarDataUrl: profile.avatarDataUrl,
  };

  if (!payload.modelClientMsgId) {
    throw new Error("Target bot message id is missing.");
  }

  const data = await relayPost("/model-edit/propose", payload);
  if (data.event) {
    await handleRelayEvent(data.event);
  }

  return data;
}

async function approveModelEdit(proposalClientMsgId) {
  if (!runtime.connected || !runtime.token || !runtime.isHost) {
    throw new Error("Only host can approve bot edits.");
  }

  const id = sanitizeRelayId(proposalClientMsgId);
  if (!id) {
    throw new Error("Proposal id is missing.");
  }

  const data = await relayPost("/model-edit/approve", {
    token: runtime.token,
    proposalClientMsgId: id,
  });

  if (data.event) {
    await handleRelayEvent(data.event);
  }

  return data;
}

async function rejectModelEdit(proposalClientMsgId, reason = "") {
  if (!runtime.connected || !runtime.token || !runtime.isHost) {
    throw new Error("Only host can reject bot edits.");
  }

  const id = sanitizeRelayId(proposalClientMsgId);
  if (!id) {
    throw new Error("Proposal id is missing.");
  }

  const data = await relayPost("/model-edit/reject", {
    token: runtime.token,
    proposalClientMsgId: id,
    reason: String(reason || "")
      .trim()
      .slice(0, 500),
  });

  if (data.event) {
    await handleRelayEvent(data.event);
  }

  return data;
}

function connectEventStream() {
  closeEventStream();

  if (!runtime.connected || !runtime.token || !runtime.relayUrl) {
    return;
  }

  if (shouldPollRelayEvents()) {
    startPollingEvents();
    return;
  }

  const url = `${runtime.relayUrl}/events?token=${encodeURIComponent(runtime.token)}&cursor=${encodeURIComponent(runtime.lastSeq)}`;
  runtime.eventStream = new EventSource(url);

  runtime.eventStream.onopen = () => {
    runtime.reconnectAttempts = 0;
    updateUi();
  };

  runtime.eventStream.onmessage = (message) => {
    try {
      void handleRelayEvent(JSON.parse(message.data)).catch((error) => {
        console.error("[silly-friends] Failed to process relay event", error);
      });
    } catch (error) {
      console.error("[silly-friends] Failed to process relay event", error);
    }
  };

  runtime.eventStream.onerror = () => {
    closeEventStream();
    scheduleReconnect();
    updateUi();
  };
}

function closeEventStream() {
  if (runtime.eventStream) {
    runtime.eventStream.close();
    runtime.eventStream = null;
  }

  if (runtime.pollTimer) {
    clearTimeout(runtime.pollTimer);
    runtime.pollTimer = null;
  }
  runtime.pollBusy = false;
}

function shouldPollRelayEvents() {
  return true;
}

function startPollingEvents() {
  const poll = async () => {
    runtime.pollTimer = null;

    if (!runtime.connected || !runtime.token || !runtime.relayUrl) {
      return;
    }

    if (!runtime.pollBusy) {
      runtime.pollBusy = true;
      try {
        await refreshState();
      } catch (error) {
        logDebug("Party polling failed", error);
      } finally {
        runtime.pollBusy = false;
      }
    }

    if (runtime.connected) {
      runtime.pollTimer = setTimeout(poll, 1200);
    }
  };

  runtime.pollTimer = setTimeout(poll, 250);
}

function scheduleReconnect() {
  if (!runtime.connected || runtime.reconnectTimer) {
    return;
  }

  const delay = Math.min(15000, 1000 * (runtime.reconnectAttempts + 1));
  runtime.reconnectAttempts += 1;
  runtime.reconnectTimer = setTimeout(async () => {
    runtime.reconnectTimer = null;
    try {
      await refreshState();
    } catch (error) {
      logDebug("State refresh failed during reconnect", error);
    }
    connectEventStream();
  }, delay);
}

async function refreshState() {
  if (!runtime.connected || !runtime.token || !runtime.relayUrl) {
    return;
  }

  const data = await relayGet("/state", {
    token: runtime.token,
    cursor: String(runtime.lastSeq),
  });
  await applySnapshot(data);
}

async function applySnapshot(snapshot) {
  if (snapshot.partyId) {
    runtime.partyId = snapshot.partyId;
  }

  if (snapshot.hostMemberId) {
    runtime.hostMemberId = snapshot.hostMemberId;
  }

  if (Array.isArray(snapshot.members)) {
    runtime.members.clear();
    for (const member of snapshot.members) {
      runtime.members.set(member.id, member);
    }
  }

  if (Array.isArray(snapshot.pending)) {
    runtime.pending = snapshot.pending.slice();
    if (
      runtime.editingClientMsgId &&
      !runtime.pending.some(
        (pending) => pending.clientMsgId === runtime.editingClientMsgId,
      )
    ) {
      runtime.editingClientMsgId = "";
    }
  }

    if (Array.isArray(snapshot.modelEditProposals)) {
    runtime.modelEditProposals = snapshot.modelEditProposals.slice();
    if (
      runtime.editingModelClientMsgId &&
      !runtime.modelEditProposals.some(
        (proposal) =>
          proposal.proposalClientMsgId === runtime.editingModelClientMsgId,
      )
    ) {
      runtime.editingModelClientMsgId = "";
    }
  }

  if (snapshot.turn && typeof snapshot.turn === "object") {
    runtime.turn = normalizeTurnState(snapshot.turn);
  }

  if (snapshot.typing && typeof snapshot.typing === "object") {
    runtime.typingState.clear();
    for (const [memberId, typing] of Object.entries(snapshot.typing)) {
      if (typing?.typing) {
        runtime.typingState.set(memberId, typing);
      }
    }
    pruneTypingState();
  }

  if (!runtime.isHost && snapshot.snapshot) {
    await applyHostSnapshot(snapshot.snapshot);
  }

  for (const event of snapshot.events || []) {
    await handleRelayEvent(event);
  }

  renderPendingMessages();
  renderModelEditProposals();
  updateUi();
}

async function handleRelayEvent(event) {
  if (!event || typeof event.seq !== "number") {
    return;
  }

  if (runtime.seenSeq.has(event.seq)) {
    return;
  }

  runtime.seenSeq.add(event.seq);
  runtime.lastSeq = Math.max(runtime.lastSeq, event.seq);

  switch (event.type) {
    case "memberJoined":
      runtime.members.set(event.payload.member.id, event.payload.member);
      break;
    case "memberUpdated":
      runtime.members.set(event.payload.member.id, event.payload.member);
      break;
    case "memberKicked":
      handleMemberKicked(event.payload || {});
      break;
    case "memberTyping":
      handleMemberTyping(event.payload || {});
      break;
    case "pendingAdded":
      upsertPending(event.payload.pending);
      break;
    case "pendingUpdated":
      upsertPending(event.payload.pending);
      break;
    case "pendingCleared":
      removePendingByClientIds(event.payload.clientMsgIds || []);
      break;
    case "playerMessage":
      removePendingByClientIds([event.payload.message.clientMsgId]);
      await applyPlayerMessage(event);
      break;
    case "modelMessage":
      await applyModelMessage(event);
      break;
    case "modelSwiped":
      await applyModelSwipe(event);
      break;
    case "modelEditProposalAdded":
      upsertModelEditProposal(event.payload.proposal);
      break;
    case "modelEditProposalUpdated":
      upsertModelEditProposal(event.payload.proposal);
      break;
    case "modelEditProposalCleared":
      removeModelEditProposalsByIds(event.payload.proposalIds || []);
      break;
    case "modelEditApproved":
      await applyApprovedModelEdit(event);
      break;
    case "modelEditRejected":
      handleRejectedModelEdit(event);
      break;
    case "turnUpdated":
      if (event.payload?.turn) {
        runtime.turn = normalizeTurnState(event.payload.turn);
        runtime.turnControlsDirty = false;
        syncTurnControls({ force: true });
      }
      break;
    case "partyStarted":
      notifyInfo("Party started.");
      break;
    case "snapshotUpdated":
      if (!runtime.isHost) {
        await refreshState();
      }
      break;
    case "keepAlive":
      break;
    case "partyStopped":
      notifyInfo("Party host stopped the relay.");
      disconnectRuntime();
      break;
    default:
      logDebug("Unhandled relay event", event);
      break;
  }

  renderPendingMessages();
  renderModelEditProposals();
  updateUi();
}

function handleMemberKicked(payload) {
  const memberId = sanitizeRelayId(payload.memberId);
  if (!memberId) {
    return;
  }

  runtime.members.delete(memberId);
  runtime.typingState.delete(memberId);
  runtime.pending = runtime.pending.filter(
    (pending) => pending.memberId !== memberId,
  );

  if (memberId === runtime.memberId) {
    notifyInfo("You were kicked from the party.");
    disconnectRuntime();
  }
}

function handleMemberTyping(payload) {
  const memberId = sanitizeRelayId(payload.memberId);
  if (!memberId || memberId === runtime.memberId) {
    return;
  }

  if (payload.typing) {
    runtime.typingState.set(memberId, {
      memberId,
      typing: true,
      updatedAt: payload.updatedAt || new Date().toISOString(),
    });
  } else {
    runtime.typingState.delete(memberId);
  }

  pruneTypingState();
}

function pruneTypingState() {
  const cutoff = Date.now() - 5000;
  for (const [memberId, state] of runtime.typingState.entries()) {
    const updatedAt = Date.parse(state?.updatedAt || "");
    if (!Number.isFinite(updatedAt) || updatedAt < cutoff) {
      runtime.typingState.delete(memberId);
    }
  }
}

function upsertPending(pending) {
  if (!pending?.clientMsgId) {
    return;
  }

  const index = runtime.pending.findIndex(
    (item) => item.clientMsgId === pending.clientMsgId,
  );
  if (index === -1) {
    runtime.pending.push(pending);
  } else {
    runtime.pending[index] = pending;
  }
}

function removePendingByClientIds(clientMsgIds) {
  const ids = new Set(clientMsgIds.filter(Boolean));
  if (!ids.size) {
    return;
  }

  runtime.pending = runtime.pending.filter(
    (pending) => !ids.has(pending.clientMsgId),
  );
  if (ids.has(runtime.editingClientMsgId)) {
    runtime.editingClientMsgId = "";
  }
}

function upsertModelEditProposal(proposal) {
  if (!proposal?.proposalClientMsgId) {
    return;
  }

  const index = runtime.modelEditProposals.findIndex(
    (item) => item.proposalClientMsgId === proposal.proposalClientMsgId,
  );
  if (index === -1) {
    runtime.modelEditProposals.push(proposal);
  } else {
    runtime.modelEditProposals[index] = proposal;
  }
}

function removeModelEditProposalsByIds(proposalIds) {
  const ids = new Set((proposalIds || []).filter(Boolean));
  if (!ids.size) {
    return;
  }

  runtime.modelEditProposals = runtime.modelEditProposals.filter(
    (proposal) => !ids.has(proposal.id),
  );
  const editedProposal = runtime.modelEditProposals.find(
    (proposal) =>
      proposal.proposalClientMsgId === runtime.editingModelClientMsgId,
  );
  if (!editedProposal) {
    runtime.editingModelClientMsgId = "";
  }
}

async function applyPlayerMessage(event) {
  const payload = event.payload?.message;
  if (
    !payload?.clientMsgId ||
    runtime.seenClientMsgIds.has(payload.clientMsgId)
  ) {
    return;
  }

  runtime.seenClientMsgIds.add(payload.clientMsgId);
  const member = runtime.members.get(payload.memberId) || {};
  const speakerName = getDisplayName(
    payload.name || payload.personaName || member.personaName,
    "Persona",
  );
  const message = {
    name: speakerName,
    is_user: true,
    is_system: false,
    send_date: getMessageTimeStamp(
      event.createdAt ? Date.parse(event.createdAt) : Date.now(),
    ),
    mes: payload.text || "",
    force_avatar: payload.avatarUrl || default_user_avatar,
    extra: {
      sillyFriends: {
        partyId: runtime.partyId,
        memberId: payload.memberId,
        seq: event.seq,
        avatarVersion: payload.avatarVersion,
        clientMsgId: payload.clientMsgId,
        personaName: speakerName,
        personaDescription: String(
          payload.personaDescription || member.personaDescription || "",
        ),
      },
    },
  };

  await appendCanonicalMessage(message, "user");
}

async function applyModelMessage(event) {
  const payload = event.payload?.message;
  if (
    !payload?.clientMsgId ||
    runtime.seenModelClientMsgIds.has(payload.clientMsgId)
  ) {
    return;
  }

  runtime.seenModelClientMsgIds.add(payload.clientMsgId);
  const extra = Object.assign({}, payload.extra || {});
  extra.sillyFriendsModel = Object.assign({}, extra.sillyFriendsModel || {}, {
    partyId: runtime.partyId,
    seq: event.seq,
    clientMsgId: payload.clientMsgId,
  });

  const message = {
    name: payload.name || "Assistant",
    is_user: false,
    is_system: false,
    send_date:
      payload.sendDate ||
      getMessageTimeStamp(
        event.createdAt ? Date.parse(event.createdAt) : Date.now(),
      ),
    mes: payload.text || "",
    extra,
  };

  if (isShareableAvatarUrl(payload.forceAvatar)) {
    message.force_avatar = payload.forceAvatar;
  }

  await appendCanonicalMessage(message, "assistant");
}

async function applyModelSwipe(event) {
  const payload = event.payload?.message;
  const clientMsgId = sanitizeRelayId(payload?.clientMsgId);
  if (!clientMsgId) {
    return;
  }

  const messageIndex = findModelMessageIndexByClientMsgId(clientMsgId);
  if (messageIndex < 0) {
    runtime.seenModelClientMsgIds.add(clientMsgId);
    const message = buildModelMessageFromPayload(payload, event);
    applySwipePayloadToMessage(message, payload, event);
    await appendCanonicalMessage(message, "assistant");
    if (!runtime.isHost) {
      notifyInfo("Host swiped!");
    }
    return;
  }

  const message = chat[messageIndex];
  applySwipePayloadToMessage(message, payload, event);
  chat_metadata.tainted = true;
  await saveChatConditional();
  await refreshRenderedMessageText(messageIndex, message.mes || "");

  if (!runtime.isHost) {
    notifyInfo("Host swiped!");
  }
}

function buildModelMessageFromPayload(payload, event) {
  const extra = Object.assign({}, payload.extra || {});
  extra.sillyFriendsModel = Object.assign({}, extra.sillyFriendsModel || {}, {
    partyId: runtime.partyId,
    seq: event.seq,
    clientMsgId: payload.clientMsgId,
  });

  const message = {
    name: payload.name || "Assistant",
    is_user: false,
    is_system: false,
    send_date:
      payload.sendDate ||
      getMessageTimeStamp(
        event.createdAt ? Date.parse(event.createdAt) : Date.now(),
      ),
    mes: payload.text || "",
    extra,
  };

  if (isShareableAvatarUrl(payload.forceAvatar)) {
    message.force_avatar = payload.forceAvatar;
  }

  return message;
}

function applySwipePayloadToMessage(message, payload, event) {
  message.name = payload.name || message.name || "Assistant";
  message.mes = String(payload.text || "");
  message.send_date = payload.sendDate || message.send_date || getMessageTimeStamp();

  const extra = Object.assign({}, message.extra || {}, payload.extra || {});
  extra.sillyFriendsModel = Object.assign({}, extra.sillyFriendsModel || {}, {
    partyId: runtime.partyId,
    seq: event.seq,
    clientMsgId: payload.clientMsgId,
    lastSwipeSeq: event.seq,
  });
  message.extra = extra;

  if (isShareableAvatarUrl(payload.forceAvatar)) {
    message.force_avatar = payload.forceAvatar;
  }

  if (Array.isArray(payload.swipes) && payload.swipes.length) {
    message.swipes = payload.swipes.map((swipe) => String(swipe ?? ""));
  }

  if (Array.isArray(payload.swipeInfo)) {
    message.swipe_info = cloneJson(payload.swipeInfo);
  }

  const maxSwipeId = Math.max(0, (message.swipes?.length || 1) - 1);
  const requestedSwipeId = Number(payload.swipeId);
  message.swipe_id = Number.isInteger(requestedSwipeId)
    ? Math.min(Math.max(0, requestedSwipeId), maxSwipeId)
    : 0;
}

async function applyApprovedModelEdit(event) {
  const payload = event.payload || {};
  const modelClientMsgId = sanitizeRelayId(payload.modelClientMsgId);
  if (!modelClientMsgId) {
    return;
  }

  const messageIndex = chat.findIndex((message) => {
    const meta = message?.extra?.sillyFriendsModel;
    return (
      meta?.partyId === runtime.partyId &&
      sanitizeRelayId(meta?.clientMsgId) === modelClientMsgId
    );
  });

  if (messageIndex < 0) {
    return;
  }

  const nextText = String(payload.text || "")
    .replaceAll("\r\n", "\n")
    .trim();
  if (!nextText) {
    return;
  }

  const message = chat[messageIndex];
  message.mes = nextText;
  message.extra = message.extra || {};
  message.extra.sillyFriendsModel = Object.assign(
    {},
    message.extra.sillyFriendsModel || {},
    {
      editedByProposalId: sanitizeRelayId(payload.proposalId) || "",
      editedByMemberId: sanitizeRelayId(payload.approvedByMemberId) || "",
      editedAt: String(payload.approvedAt || "") || new Date().toISOString(),
      seq: Number(event.seq) || message.extra?.sillyFriendsModel?.seq || 0,
    },
  );

  chat_metadata.tainted = true;
  await saveChatConditional();
  await refreshRenderedMessageText(messageIndex, nextText);
}

function handleRejectedModelEdit(event) {
  const payload = event.payload || {};
  if (!payload?.proposalClientMsgId) {
    return;
  }

  const rejectedOwn = runtime.modelEditProposals.find(
    (proposal) =>
      proposal.proposalClientMsgId === payload.proposalClientMsgId &&
      proposal.memberId === runtime.memberId,
  );

  if (rejectedOwn) {
    const reason = String(payload.reason || "").trim();
    notifyInfo(
      reason
        ? `Your bot edit proposal was rejected: ${reason}`
        : "Your bot edit proposal was rejected.",
    );
  }
}

function getModelMessageSeqByClientMsgId(clientMsgId) {
  const id = sanitizeRelayId(clientMsgId);
  if (!id) {
    return 0;
  }

  for (const message of chat) {
    const meta = message?.extra?.sillyFriendsModel;
    if (
      meta?.partyId === runtime.partyId &&
      sanitizeRelayId(meta.clientMsgId) === id &&
      Number.isFinite(Number(meta.seq))
    ) {
      return Number(meta.seq);
    }
  }

  return 0;
}

function findModelMessageIndexByClientMsgId(clientMsgId) {
  const id = sanitizeRelayId(clientMsgId);
  if (!id) {
    return -1;
  }

  return chat.findIndex((message) => {
    const meta = message?.extra?.sillyFriendsModel;
    return (
      meta?.partyId === runtime.partyId &&
      sanitizeRelayId(meta.clientMsgId) === id
    );
  });
}

async function appendCanonicalMessage(message, role) {
  chat.push(message);
  chat_metadata.tainted = true;
  await saveChatConditional();

  const messageId = chat.length - 1;
  if (role === "user") {
    await eventSource.emit(event_types.MESSAGE_SENT, messageId);
    addOneMessage(message);
    await eventSource.emit(event_types.USER_MESSAGE_RENDERED, messageId);
  } else {
    await eventSource.emit(
      event_types.MESSAGE_RECEIVED,
      messageId,
      "silly-friends",
    );
    addOneMessage(message);
    await eventSource.emit(
      event_types.CHARACTER_MESSAGE_RENDERED,
      messageId,
      "silly-friends",
    );
  }

  decoratePartyMessages();
}

function renderPendingMessages() {
  $(`#${PENDING_CONTAINER_ID}`).remove();

  if (!runtime.connected || !runtime.pending.length) {
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.id = PENDING_CONTAINER_ID;

  for (const pending of runtime.pending) {
    const member = runtime.members.get(pending.memberId) || {};
    const name = getDisplayName(
      pending.personaName || member.personaName,
      "Persona",
    );
    const avatarUrl = pending.avatarUrl || member.avatarUrl || "";
    const isOwn = pending.memberId === runtime.memberId;
    const canDelete = isOwn || canModerateActions();
    const isEditing = pending.clientMsgId === runtime.editingClientMsgId;
    const item = document.createElement("div");
    item.className = `silly-friends-pending-message${isOwn ? " is-own" : ""}${isEditing ? " is-editing" : ""}`;
    item.dataset.clientMsgId = pending.clientMsgId || "";
    item.innerHTML = `
            ${renderAvatarHtml(avatarUrl, name)}
            <div class="silly-friends-pending-body">
                <div class="silly-friends-pending-head">
                    <span class="silly-friends-pending-name">${escapeHtml(name)}</span>
                    <span class="silly-friends-pending-state">${isEditing ? "editing" : "pending"}</span>
                    ${
                      isOwn || canDelete
                        ? renderPendingActionsHtml({
                            canCopyEdit: isOwn,
                            canDelete,
                          })
                        : ""
                    }
                </div>
                <div class="silly-friends-pending-text">${escapeHtml(pending.text || "")}</div>
            </div>`;
    bindPendingAction(item, ".silly-friends-pending-copy", () =>
      copyPendingMove(pending),
    );
    bindPendingAction(item, ".silly-friends-pending-edit", () =>
      editPendingMove(pending),
    );
    bindPendingAction(item, ".silly-friends-pending-delete", () =>
      deletePendingMove(pending),
    );
    wrapper.append(item);
  }

  document.getElementById("chat")?.append(wrapper);
}

function bindPendingAction(item, selector, action) {
  item.querySelector(selector)?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    action().catch(handleActionError);
  });
}

function renderModelEditProposals() {
  const panel = $("#silly_friends_model_edit_panel");
  const list = $("#silly_friends_model_edit_list");
  if (!panel.length || !list.length) {
    return;
  }

  const proposals = runtime.modelEditProposals.slice();
  panel.toggleClass(
    "displayNone",
    !runtime.connected || proposals.length === 0,
  );
  list.empty();

  for (const proposal of proposals) {
    const item = $('<div class="silly-friends-model-edit-item"></div>');
    const name = getDisplayName(proposal.personaName, "User");
    const isOwn = proposal.memberId === runtime.memberId;
    const isEditing =
      proposal.proposalClientMsgId === runtime.editingModelClientMsgId;

    item.toggleClass("is-own", isOwn);
    item.toggleClass("is-editing", isEditing);
    item.append(
      `<div class=\"silly-friends-model-edit-head\">${escapeHtml(name)} · target ${escapeHtml(proposal.modelClientMsgId || "")}</div>`,
    );
    item.append(
      `<div class=\"silly-friends-model-edit-text\">${escapeHtml(proposal.text || "")}</div>`,
    );

    const actions = $(
      '<div class="silly-friends-model-edit-actions-row"></div>',
    );
    if (isOwn) {
      const editButton = $(
        '<button type="button" class="menu_button">Edit proposal</button>',
      );
      editButton.on("click", () => {
        beginModelEditProposal(
          proposal.modelClientMsgId,
          proposal.text || "",
          proposal,
        ).catch(handleActionError);
      });
      actions.append(editButton);
    }

    if (runtime.isHost) {
      const approveButton = $(
        '<button type="button" class="menu_button">Approve</button>',
      );
      approveButton.on("click", () => {
        approveModelEdit(proposal.proposalClientMsgId).catch(handleActionError);
      });
      actions.append(approveButton);

      const rejectButton = $(
        '<button type="button" class="menu_button">Reject</button>',
      );
      rejectButton.on("click", () => {
        rejectModelEdit(proposal.proposalClientMsgId).catch(handleActionError);
      });
      actions.append(rejectButton);
    }

    item.append(actions);
    list.append(item);
  }
}

async function refreshRenderedMessageText(messageIndex, text) {
  const textElement = document.querySelector(
    `#chat .mes[mesid=\"${messageIndex}\"] .mes_text`,
  );
  if (textElement) {
    textElement.textContent = text;
  }

  await reloadCurrentChat();
  decoratePartyMessages();
}

function renderPendingActionsHtml({
  canCopyEdit = true,
  canDelete = true,
} = {}) {
  const copyButton =
    '<button type="button" class="silly-friends-pending-action silly-friends-pending-copy fa-solid fa-copy" title="Copy pending move" aria-label="Copy pending move"></button>';
  const editButton =
    '<button type="button" class="silly-friends-pending-action silly-friends-pending-edit fa-solid fa-pencil" title="Edit pending move" aria-label="Edit pending move"></button>';
  const deleteButton =
    '<button type="button" class="silly-friends-pending-action silly-friends-pending-delete fa-solid fa-trash" title="Delete pending move" aria-label="Delete pending move"></button>';

  return `
        <span class="silly-friends-pending-actions">
            ${canCopyEdit ? copyButton : ""}
            ${canCopyEdit ? editButton : ""}
            ${canDelete ? deleteButton : ""}
        </span>`;
}

async function copyPendingMove(pending) {
  if (!pending || pending.memberId !== runtime.memberId) {
    throw new Error("You can only copy your own pending messages.");
  }

  await copyText(String(pending.text || ""));
  notifyInfo("Pending move copied.");
}

async function editPendingMove(pending) {
  if (!pending || pending.memberId !== runtime.memberId) {
    throw new Error("You can only edit your own pending messages.");
  }

  runtime.editingClientMsgId = pending.clientMsgId;
  runtime.editingModelClientMsgId = "";
  const textarea = document.getElementById("send_textarea");
  if (textarea) {
    delete textarea.dataset.sillyFriendsModelClientMsgId;
  }
  if (textarea) {
    textarea.value = pending.text || "";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  renderPendingMessages();
  renderModelEditProposals();
  updateUi();
}

async function deletePendingMove(pending) {
  if (
    !pending ||
    (pending.memberId !== runtime.memberId && !canModerateActions())
  ) {
    throw new Error("You can only delete your own pending messages.");
  }

  const data = await relayPost("/message/delete", {
    token: runtime.token,
    clientMsgId: sanitizeRelayId(pending.clientMsgId),
  });

  if (data.event) {
    await handleRelayEvent(data.event);
  } else if (data.clientMsgId) {
    removePendingByClientIds([data.clientMsgId]);
    renderPendingMessages();
    updateUi();
  }

  if (runtime.editingClientMsgId === pending.clientMsgId) {
    runtime.editingClientMsgId = "";
    const textarea = document.getElementById("send_textarea");
    if (textarea) {
      textarea.value = "";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  notifyInfo("Pending move deleted.");
}

function renderAvatarHtml(url, name) {
  const initials = getInitials(name);
  const safeUrl = escapeAttribute(url || default_user_avatar);
  return `
        <div class="silly-friends-avatar">
            <img src="${safeUrl}" alt="${escapeAttribute(name)}" onerror="this.parentElement.dataset.imageFailed = 'true';">
            <span class="silly-friends-avatar-fallback">${escapeHtml(initials)}</span>
        </div>`;
}

function decoratePartyMessages() {
  for (let index = 0; index < chat.length; index += 1) {
    const message = chat[index];
    const playerMeta = message?.extra?.sillyFriends;
    const modelMeta = message?.extra?.sillyFriendsModel;
    if (!playerMeta && !modelMeta) {
      continue;
    }

    const element = document.querySelector(`#chat .mes[mesid="${index}"]`);
    if (!element) {
      continue;
    }

    element.classList.add("silly-friends-party-message");
    const avatar = element.querySelector(".avatar");
    const image = avatar?.querySelector("img");
    if (
      avatar &&
      !avatar.querySelector(".silly-friends-chat-avatar-fallback")
    ) {
      const fallback = document.createElement("span");
      fallback.className = "silly-friends-chat-avatar-fallback";
      fallback.textContent = getInitials(message.name);
      avatar.append(fallback);
    }

    if (avatar && image && !avatar.dataset.sillyFriendsAvatarBound) {
      avatar.dataset.sillyFriendsAvatarBound = "true";
      image.addEventListener("error", () => {
        avatar.dataset.imageFailed = "true";
      });
      image.addEventListener("load", () => {
        delete avatar.dataset.imageFailed;
      });
    }

    if (modelMeta) {
      installModelEditActions(element, message, modelMeta);
    }
  }
}

function installModelEditActions(element, message, modelMeta) {
  if (!element || !message || !modelMeta?.clientMsgId) {
    return;
  }

  const messageText =
    element.querySelector(".mes_text") ||
    element.querySelector(".mes_block") ||
    element;
  if (!messageText) {
    return;
  }

  const actionsClass = "silly-friends-model-edit-actions";
  let actions = messageText.querySelector(`.${actionsClass}`);
  if (!actions) {
    actions = document.createElement("div");
    actions.className = actionsClass;
    messageText.append(actions);
  }

  actions.innerHTML = "";
  if (!runtime.isHost) {
    actions.remove();
    return;
  }

  if (runtime.isHost) {
    const openForMessage = runtime.modelEditProposals.filter(
      (item) => item.modelClientMsgId === modelMeta.clientMsgId,
    );
    for (const item of openForMessage) {
      const approveButton = document.createElement("button");
      approveButton.type = "button";
      approveButton.className = "menu_button silly-friends-model-approve-btn";
      approveButton.textContent = `Approve edit from ${getDisplayName(item.personaName, "User")}`;
      approveButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        approveModelEdit(item.proposalClientMsgId).catch(handleActionError);
      });
      actions.append(approveButton);

      const rejectButton = document.createElement("button");
      rejectButton.type = "button";
      rejectButton.className = "menu_button silly-friends-model-reject-btn";
      rejectButton.textContent = `Reject ${getDisplayName(item.personaName, "User")}`;
      rejectButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        rejectModelEdit(item.proposalClientMsgId).catch(handleActionError);
      });
      actions.append(rejectButton);
    }
  }
}

async function beginModelEditProposal(
  modelClientMsgId,
  currentText,
  existingProposal = null,
) {
  const textarea = document.getElementById("send_textarea");
  if (!textarea) {
    throw new Error("Message input was not found.");
  }

  runtime.editingClientMsgId = "";
  runtime.editingModelClientMsgId =
    existingProposal?.proposalClientMsgId || uuidv4();
  textarea.value = existingProposal?.text || currentText || "";
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  textarea.dataset.sillyFriendsModelClientMsgId =
    sanitizeRelayId(modelClientMsgId);
  renderModelEditProposals();
  updateUi();
}

async function getCurrentPersonaProfile() {
  const personaName = getDisplayName(
    power_user.personas?.[user_avatar] || name1,
    "User",
  );
  const personaDescription = getPersonaDescription();
  const avatarUrl = user_avatar
    ? getThumbnailUrl("persona", user_avatar, true)
    : default_user_avatar;
  const avatarDataUrl = await imageUrlToDataUrl(avatarUrl);

  return {
    personaName,
    personaDescription,
    avatarDataUrl,
  };
}

function getPersonaDescription() {
  const fromObject = power_user.persona_descriptions?.[user_avatar];
  const directDescription =
    typeof fromObject === "string" ? fromObject : fromObject?.description;
  const fallbackDescription = power_user.persona_description;
  const value = directDescription ?? fallbackDescription ?? "";
  return String(value || "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim();
}

function getPersonaSnapshotKey(profile) {
  return `${getDisplayName(profile?.personaName, "User")}:${stableHash(`${profile?.personaDescription || ""}|${profile?.avatarDataUrl || ""}`)}`;
}

async function buildHostSnapshot() {
  if (this_chid === undefined || !characters[this_chid]) {
    throw new Error(
      "Select a character and chat before starting a silly-friends party.",
    );
  }

  const character = characters[this_chid];
  const avatarUrl =
    character.avatar && character.avatar !== "none"
      ? getThumbnailUrl("avatar", character.avatar, true)
      : default_user_avatar;
  const cardKey = makeHostCharacterKey(character);

  return {
    version: Date.now(),
    seq: runtime.lastSeq,
    character: {
      cardKey,
      name: character.name || "Host Character",
      avatar: character.avatar || "",
      avatarDataUrl: await imageUrlToDataUrl(avatarUrl),
      create_date: character.create_date || new Date().toISOString(),
      data: cloneJson(character.data || {}),
      description: character.description || character.data?.description || "",
      personality: character.personality || character.data?.personality || "",
      scenario: character.scenario || character.data?.scenario || "",
      first_mes: character.first_mes || character.data?.first_mes || "",
      mes_example: character.mes_example || character.data?.mes_example || "",
      creator_notes:
        character.data?.creator_notes || character.creatorcomment || "",
      system_prompt: character.data?.system_prompt || "",
      post_history_instructions:
        character.data?.post_history_instructions || "",
      tags: character.data?.tags || character.tags || [],
      creator: character.data?.creator || character.creator || "",
      character_version: character.data?.character_version || "",
      alternate_greetings: character.data?.alternate_greetings || [],
      extensions: character.data?.extensions || {},
    },
    chat: {
      name: getCurrentChatId() || `${character.name || "Chat"} - silly-friends`,
      metadata: cloneJson(chat_metadata || {}),
      messages: chat.map(serializeSnapshotMessage),
    },
  };
}

function serializeSnapshotMessage(message) {
  const snapshotMessage = {
    name: message?.name || "",
    is_user: !!message?.is_user,
    is_system: !!message?.is_system,
    send_date: message?.send_date || getMessageTimeStamp(),
    mes: String(message?.mes || ""),
    extra: cloneJson(message?.extra || {}),
  };

  for (const key of [
    "swipe_id",
    "swipes",
    "swipe_info",
    "gen_started",
    "gen_finished",
  ]) {
    if (message?.[key] !== undefined) {
      snapshotMessage[key] = cloneJson(message[key]);
    }
  }

  if (isShareableAvatarUrl(message?.force_avatar)) {
    snapshotMessage.force_avatar = message.force_avatar;
  }

  return snapshotMessage;
}

async function applyHostSnapshot(snapshot) {
  const snapshotKey = getHostSnapshotApplyKey(snapshot);
  if (
    !snapshot ||
    runtime.isHost ||
    runtime.appliedHostSnapshotKey === snapshotKey
  ) {
    return;
  }

  setStatusText("Reloading host character and chat...");
  await getCharacters();
  const avatarName =
    findReusableSnapshotCharacterAvatar(snapshot) ||
    (await createSnapshotCharacter(snapshot));
  const chatName = makeSnapshotChatName(snapshot);
  await saveSnapshotChat(snapshot, avatarName, chatName);
  await updateSnapshotCharacterChat(snapshot, avatarName, chatName);
  await getCharacters();

  const characterId = characters.findIndex(
    (character) => character.avatar === avatarName,
  );
  if (characterId >= 0) {
    await selectCharacterById(characterId, { switchMenu: false });
  } else {
    await reloadCurrentChat();
  }

  hydrateSeenFromSnapshot(snapshot);
  runtime.appliedHostSnapshotVersion = snapshot.version;
  runtime.appliedHostSnapshotKey = snapshotKey;
}

function getHostSnapshotApplyKey(snapshot) {
  if (!snapshot) {
    return "";
  }

  const messages = Array.isArray(snapshot.chat?.messages)
    ? snapshot.chat.messages
    : [];
  const lastMessage = messages[messages.length - 1] || {};
  return stableHash(
    JSON.stringify({
      version: snapshot.version || 0,
      seq: snapshot.seq || 0,
      chatName: snapshot.chat?.name || "",
      messageCount: messages.length,
      lastMessage: {
        name: lastMessage.name || "",
        isUser: !!lastMessage.is_user,
        text: lastMessage.mes || "",
        extra: lastMessage.extra || {},
      },
    }),
  );
}

function findReusableSnapshotCharacterAvatar(snapshot) {
  const sourceCardKey = getSnapshotCharacterKey(snapshot);
  const snapshotName = getDisplayName(
    snapshot.character?.name || snapshot.character?.data?.name,
    "",
  );
  if (!sourceCardKey && !snapshotName) {
    return "";
  }

  const importedMatch = characters.find((character) => {
    const imported =
      character?.data?.extensions?.sillyFriendsImported ||
      character?.extensions?.sillyFriendsImported;
    if (!imported) {
      return false;
    }

    if (sourceCardKey && imported.sourceCardKey === sourceCardKey) {
      return true;
    }

    return (
      snapshotName &&
      getDisplayName(character.name || character.data?.name, "") ===
        snapshotName
    );
  });
  if (importedMatch?.avatar) {
    return importedMatch.avatar;
  }

  if (!sourceCardKey) {
    return "";
  }

  const exactLocalMatch = characters.find(
    (character) => makeHostCharacterKey(character) === sourceCardKey,
  );
  return exactLocalMatch?.avatar || "";
}

async function createSnapshotCharacter(snapshot) {
  const formData = buildSnapshotCharacterFormData(snapshot, {
    includeChat: false,
  });
  const avatarFile = await dataUrlToFile(
    snapshot.character?.avatarDataUrl,
    "avatar.png",
  );
  if (avatarFile) {
    formData.append("avatar", avatarFile);
  }

  const response = await fetch("/api/characters/create", {
    method: "POST",
    headers: getRequestHeaders({ omitContentType: true }),
    body: formData,
    cache: "no-cache",
  });

  if (!response.ok) {
    throw new Error(
      `Failed to create host character locally: ${response.status} ${response.statusText}`,
    );
  }

  return await response.text();
}

async function updateSnapshotCharacterChat(snapshot, avatarName, chatName) {
  const formData = buildSnapshotCharacterFormData(snapshot, {
    includeChat: true,
    avatarName,
    chatName,
  });
  const response = await fetch("/api/characters/edit", {
    method: "POST",
    headers: getRequestHeaders({ omitContentType: true }),
    body: formData,
    cache: "no-cache",
  });

  if (!response.ok) {
    throw new Error(
      `Failed to bind host chat to imported character: ${response.status} ${response.statusText}`,
    );
  }
}

function buildSnapshotCharacterFormData(
  snapshot,
  { includeChat, avatarName = "", chatName = "" } = {},
) {
  const character = snapshot.character || {};
  const data = character.data || {};
  const extensions = Object.assign(
    {},
    character.extensions || data.extensions || {},
    {
      sillyFriendsImported: {
        partyId: runtime.partyId,
        snapshotVersion: snapshot.version,
        sourceCardKey: getSnapshotCharacterKey(snapshot),
        sourceCardName: character.name || data.name || "Host Character",
        updatedAt: new Date().toISOString(),
      },
    },
  );
  const formData = new FormData();
  formData.append("ch_name", character.name || data.name || "Host Character");
  formData.append(
    "description",
    character.description || data.description || "",
  );
  formData.append(
    "personality",
    character.personality || data.personality || "",
  );
  formData.append("scenario", character.scenario || data.scenario || "");
  formData.append("first_mes", character.first_mes || data.first_mes || "");
  formData.append(
    "mes_example",
    character.mes_example || data.mes_example || "",
  );
  formData.append(
    "creator_notes",
    character.creator_notes || data.creator_notes || "",
  );
  formData.append(
    "system_prompt",
    character.system_prompt || data.system_prompt || "",
  );
  formData.append(
    "post_history_instructions",
    character.post_history_instructions || data.post_history_instructions || "",
  );
  formData.append("tags", normalizeTags(character.tags || data.tags || []));
  formData.append("creator", character.creator || data.creator || "");
  formData.append(
    "character_version",
    character.character_version || data.character_version || "",
  );
  formData.append("talkativeness", String(extensions.talkativeness || 0.5));
  formData.append("fav", "false");
  formData.append("world", extensions.world || "");
  formData.append("depth_prompt_prompt", extensions.depth_prompt?.prompt || "");
  formData.append(
    "depth_prompt_depth",
    String(extensions.depth_prompt?.depth ?? 4),
  );
  formData.append(
    "depth_prompt_role",
    extensions.depth_prompt?.role || "system",
  );
  formData.append("extensions", JSON.stringify(extensions));
  formData.append("json_data", JSON.stringify(data));

  for (const greeting of character.alternate_greetings ||
    data.alternate_greetings ||
    []) {
    formData.append("alternate_greetings", String(greeting || ""));
  }

  if (includeChat) {
    formData.append("avatar_url", avatarName);
    formData.append("chat", chatName);
    formData.append(
      "create_date",
      character.create_date || new Date().toISOString(),
    );
  } else {
    formData.append("file_name", makeSnapshotCharacterFileName(snapshot));
  }

  return formData;
}

async function saveSnapshotChat(snapshot, avatarName, chatName) {
  const response = await fetch("/api/chats/save", {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify({
      avatar_url: avatarName,
      file_name: chatName,
      force: true,
      chat: [
        {
          user_name: name1,
          character_name: snapshot.character?.name || "Host Character",
          chat_metadata: cloneJson(snapshot.chat?.metadata || {}),
        },
        ...(snapshot.chat?.messages || []),
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to save host chat locally: ${response.status} ${response.statusText}`,
    );
  }
}

function hydrateSeenFromSnapshot(snapshot) {
  for (const message of snapshot.chat?.messages || []) {
    const playerMeta = message?.extra?.sillyFriends;
    const modelMeta = message?.extra?.sillyFriendsModel;

    if (typeof playerMeta?.seq === "number") {
      runtime.seenSeq.add(playerMeta.seq);
      runtime.lastSeq = Math.max(runtime.lastSeq, playerMeta.seq);
    }
    if (playerMeta?.clientMsgId) {
      runtime.seenClientMsgIds.add(playerMeta.clientMsgId);
    }
    if (typeof modelMeta?.seq === "number") {
      runtime.seenSeq.add(modelMeta.seq);
      runtime.lastSeq = Math.max(runtime.lastSeq, modelMeta.seq);
    }
    if (modelMeta?.clientMsgId) {
      runtime.seenModelClientMsgIds.add(modelMeta.clientMsgId);
    }
  }
}

function makeSnapshotCharacterFileName(snapshot) {
  const cardKey = getSnapshotCharacterKey(snapshot);
  return `silly-friends-${sanitizeFilePart(cardKey || snapshot.character?.name || "host")}`;
}

function makeSnapshotChatName(snapshot) {
  const cardKey = getSnapshotCharacterKey(snapshot);
  return `silly-friends-${runtime.partyId || "party"}-${sanitizeFilePart(cardKey || snapshot.character?.name || "host")}`;
}

function getSnapshotCharacterKey(snapshot) {
  return (
    String(snapshot?.character?.cardKey || "").trim() ||
    makeHostCharacterKey(snapshot?.character || {})
  );
}

function makeHostCharacterKey(character) {
  const data = character?.data || {};
  const identity = {
    name: getDisplayName(character?.name || data.name, ""),
    create_date: String(character?.create_date || data.create_date || ""),
    creator: String(data.creator || character?.creator || ""),
    character_version: String(
      data.character_version || character?.character_version || "",
    ),
    avatar: String(
      character?.create_date || data.create_date ? "" : character?.avatar || "",
    ),
  };
  return stableHash(JSON.stringify(identity));
}

function stableHash(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeTags(tags) {
  return Array.isArray(tags) ? tags.join(",") : String(tags || "");
}

function sanitizeFilePart(value) {
  return (
    String(value || "item")
      .replace(/[^a-z0-9_-]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "item"
  );
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

async function dataUrlToFile(dataUrl, fileName) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    return null;
  }

  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return new File([blob], fileName, { type: blob.type || "image/png" });
}

async function imageUrlToDataUrl(url) {
  try {
    const response = await fetch(url, { cache: "reload" });
    if (!response.ok) {
      return "";
    }

    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) {
      return "";
    }

    return await resizeImageBlobToDataUrl(blob, 160);
  } catch (error) {
    logDebug("Failed to read persona avatar", error);
    return "";
  }
}

function resizeImageBlobToDataUrl(blob, maxSize) {
  return new Promise((resolve) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(blob);

    image.onload = () => {
      const scale = Math.min(
        1,
        maxSize /
          Math.max(
            image.naturalWidth || maxSize,
            image.naturalHeight || maxSize,
          ),
      );
      const width = Math.max(
        1,
        Math.round((image.naturalWidth || maxSize) * scale),
      );
      const height = Math.max(
        1,
        Math.round((image.naturalHeight || maxSize) * scale),
      );
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, width, height);
      URL.revokeObjectURL(objectUrl);
      resolve(canvas.toDataURL("image/png"));
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve("");
    };

    image.src = objectUrl;
  });
}

async function relayPost(path, body, relayUrl = runtime.relayUrl) {
  try {
    const response = await fetchWithTimeout(
      `${relayUrl}${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      RELAY_REQUEST_TIMEOUT_MS,
    );
    return await readJsonResponse(response);
  } catch (error) {
    const fallback = getHostRelayFallback(relayUrl);
    if (fallback) {
      return relayPost(path, body, fallback);
    }
    throw normalizeRelayError(error, relayUrl);
  }
}

async function relayGet(path, query, relayUrl = runtime.relayUrl) {
  const url = new URL(`${relayUrl}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    url.searchParams.set(key, value);
  }

  try {
    const response = await fetchWithTimeout(
      url.toString(),
      {},
      RELAY_REQUEST_TIMEOUT_MS,
    );
    return await readJsonResponse(response);
  } catch (error) {
    const fallback = getHostRelayFallback(relayUrl);
    if (fallback) {
      return relayGet(path, query, fallback);
    }
    throw normalizeRelayError(error, relayUrl);
  }
}

function getHostRelayFallback(relayUrl) {
  if (
    !runtime.isHost ||
    !runtime.tunnelUrl ||
    normalizeRelayUrl(relayUrl) === runtime.tunnelUrl
  ) {
    return "";
  }

  if (isLoopbackRelayUrl(relayUrl)) {
    runtime.relayUrl = runtime.tunnelUrl;
    return runtime.tunnelUrl;
  }

  return "";
}

async function readJsonResponse(response) {
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `${response.status} ${response.statusText}`);
  }

  return data;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(
      url,
      Object.assign({}, options, { signal: controller.signal }),
    );
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeRelayError(error, relayUrl) {
  const message = error instanceof Error ? error.message : String(error);
  const localRelay = isLoopbackRelayUrl(relayUrl);
  if (error?.name === "AbortError") {
    return new Error(
      localRelay
        ? `Timed out while connecting to local host relay ${relayUrl}. The host browser cannot reach the plugin relay; restart the party so it uses the public tunnel URL.`
        : `Timed out while connecting to ${relayUrl}. Check that the host still has the party tunnel running.`,
    );
  }
  if (/404/.test(message)) {
    return new Error(
      `Relay endpoint was not found at ${relayUrl}. Check that the tunnel URL belongs to a running silly-friends host.`,
    );
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return new Error(
      localRelay
        ? `Could not reach local host relay ${relayUrl}. The party is still hosted, but this browser cannot talk to that loopback port; restart the party so silly-friends uses the public tunnel URL.`
        : `Could not reach ${relayUrl}. Check that the party tunnel is still open and that the full https:// URL is pasted.`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

function disconnectRuntime({ keepHostRelay = false } = {}) {
  closeEventStream();
  clearTimeout(runtime.reconnectTimer);
  runtime.reconnectTimer = null;
  restoreOnlineStatus();

  runtime.connected = false;
  runtime.isHost = false;
  runtime.committing = false;
  runtime.tunnelProvider = defaultSettings.tunnelProvider;
  runtime.tunnelCommand = defaultSettings.tunnelCommand;
  runtime.relayUrl = keepHostRelay ? runtime.relayUrl : "";
  runtime.localRelayUrl = "";
  runtime.tunnelUrl = "";
  runtime.accessCode = "";
  runtime.partyId = "";
  runtime.token = "";
  runtime.memberId = "";
  runtime.hostMemberId = "";
  runtime.appliedHostSnapshotVersion = 0;
  runtime.appliedHostSnapshotKey = "";
  runtime.lastPersonaSnapshotKey = "";
  clearTimeout(runtime.personaSnapshotTimer);
  runtime.personaSnapshotTimer = null;
  runtime.personaSnapshotBusy = false;
  runtime.personaSnapshotQueued = false;
  clearTimeout(runtime.hostSnapshotSyncTimer);
  runtime.hostSnapshotSyncTimer = null;
  runtime.hostSnapshotSyncBusy = false;
  runtime.hostSnapshotSyncQueued = false;
  clearTimeout(runtime.typingSendTimer);
  clearTimeout(runtime.typingStopTimer);
  runtime.typingSendTimer = null;
  runtime.typingStopTimer = null;
  runtime.typingLastSentAt = 0;
  runtime.typingLastText = "";
  runtime.typingState.clear();
  clearTimeout(runtime.modelPublishTimer);
  runtime.modelPublishTimer = null;
  runtime.modelPublishBusy = false;
  runtime.modelPublishQueued = false;
  runtime.modelPublishMinIndex = 0;
  runtime.modelGenerationStartIndex = null;
  clearTimeout(runtime.modelSwipePublishTimer);
  runtime.modelSwipePublishTimer = null;
  runtime.modelSwipePublishBusy = false;
  runtime.modelSwipePublishQueued = false;
  runtime.modelSwipePublishIndex = null;
  runtime.lastPublishedModelSwipeKeys.clear();
  restorePromptMacroOverride();
  runtime.lastSeq = 0;
  runtime.members.clear();
  runtime.pending = [];
  runtime.modelEditProposals = [];
  runtime.turn = {
    mode: "freeform",
    currentMemberId: "",
    durationSec: 0,
    endsAt: "",
  };
  runtime.turnControlsDirty = false;
  runtime.turnControlsFocused = false;
  runtime.editingClientMsgId = "";
  runtime.editingModelClientMsgId = "";
  const textarea = document.getElementById("send_textarea");
  if (textarea) {
    delete textarea.dataset.sillyFriendsModelClientMsgId;
  }
  runtime.seenSeq.clear();
  runtime.seenClientMsgIds.clear();
  runtime.seenModelClientMsgIds.clear();
  runtime.reconnectAttempts = 0;

  renderPendingMessages();
  renderModelEditProposals();
  updateUi();
}

function setGuestOnlineStatus() {
  if (runtime.isHost || runtime.setStatusOverride) {
    return;
  }

  runtime.previousOnlineStatus = online_status;
  runtime.setStatusOverride = true;
  setOnlineStatus("silly-friends host");
}

function restoreOnlineStatus() {
  if (!runtime.setStatusOverride) {
    return;
  }

  setOnlineStatus(runtime.previousOnlineStatus || "no_connection");
  runtime.previousOnlineStatus = null;
  runtime.setStatusOverride = false;
}

function hydrateSeenFromChat(partyId) {
  for (const message of chat) {
    const playerMeta = message?.extra?.sillyFriends;
    const modelMeta = message?.extra?.sillyFriendsModel;

    if (playerMeta?.partyId === partyId) {
      if (typeof playerMeta.seq === "number") {
        runtime.seenSeq.add(playerMeta.seq);
        runtime.lastSeq = Math.max(runtime.lastSeq, playerMeta.seq);
      }
      if (playerMeta.clientMsgId) {
        runtime.seenClientMsgIds.add(playerMeta.clientMsgId);
      }
    }

    if (modelMeta?.partyId === partyId) {
      if (typeof modelMeta.seq === "number") {
        runtime.seenSeq.add(modelMeta.seq);
        runtime.lastSeq = Math.max(runtime.lastSeq, modelMeta.seq);
      }
      if (modelMeta.clientMsgId) {
        runtime.seenModelClientMsgIds.add(modelMeta.clientMsgId);
      }
    }
  }
}

function updateUi() {
  const turnInfo =
    runtime.turn.mode === "freeform"
      ? "freeform"
      : `turn: ${getDisplayName(runtime.members.get(runtime.turn.currentMemberId)?.personaName, "any")}`;
  const connectedText = runtime.connected
    ? `${runtime.isHost ? "Hosting" : "Connected"}: ${runtime.members.size} member(s), ${runtime.pending.length} pending, ${runtime.modelEditProposals.length} bot edits, ${turnInfo}`
    : "Disconnected";
  setStatusText(connectedText);

  $("#silly_friends_invite_url").val(runtime.tunnelUrl || "");
  $("#silly_friends_invite_code").val(runtime.accessCode || "");

  const commitButton = $(`#${COMMIT_BUTTON_ID}`);
  const textareaHasText = !!String(
    document.getElementById("send_textarea")?.value || "",
  ).trim();
  const commitVisible = runtime.connected && runtime.isHost;
  const commitDisabled =
    !commitVisible ||
    runtime.committing ||
    isGenerating() ||
    (runtime.pending.length === 0 && !textareaHasText);
  commitButton.toggleClass("displayNone", !commitVisible);
  commitButton.toggleClass("disabled", commitDisabled);
  commitButton.attr("aria-disabled", String(commitDisabled));

  const canCommit = canCommitActions();
  const canModerate = canModerateActions();
  const me = runtime.members.get(runtime.memberId);

  $("#silly_friends_host_start").prop(
    "disabled",
    runtime.connected || runtime.committing,
  );
  $("#silly_friends_host_reload").prop(
    "disabled",
    !runtime.connected || !runtime.isHost || runtime.committing,
  );
  $("#silly_friends_host_stop").prop(
    "disabled",
    !runtime.connected || !runtime.isHost || runtime.committing,
  );
  $("#silly_friends_join").prop(
    "disabled",
    runtime.connected || runtime.committing,
  );
  $("#silly_friends_leave").prop(
    "disabled",
    !runtime.connected || runtime.committing,
  );

  const showHostSessionSubmenu = runtime.connected && runtime.isHost;
  $("#silly_friends_host_session_submenu").toggleClass(
    "displayNone",
    !showHostSessionSubmenu,
  );

  $("#silly_friends_ready_toggle")
    .prop("disabled", !runtime.connected)
    .text(me?.ready ? "Unready" : "Ready");
  $("#silly_friends_delete_all_pending").prop(
    "disabled",
    !showHostSessionSubmenu || !canModerate,
  );
  syncTurnControls();
  $("#silly_friends_turn_apply").prop(
    "disabled",
    !showHostSessionSubmenu || !canCommit,
  );
  $("#silly_friends_turn_next").prop(
    "disabled",
    !showHostSessionSubmenu || !canCommit || runtime.turn.mode === "freeform",
  );
  $("#silly_friends_party_start").prop(
    "disabled",
    !showHostSessionSubmenu || !canCommit,
  );

  renderRoster();
  renderModelEditProposals();
}

function setStatusText(text) {
  $("#silly_friends_status")
    .text(text)
    .toggleClass("silly-friends-status-connected", runtime.connected)
    .toggleClass("silly-friends-status-disconnected", !runtime.connected);
}

function syncTurnControls({ force = false } = {}) {
  if (
    !force &&
    (runtime.turnControlsDirty || runtime.turnControlsFocused)
  ) {
    return;
  }

  $("#silly_friends_turn_mode").val(runtime.turn.mode || "freeform");
  $("#silly_friends_turn_duration").val(String(runtime.turn.durationSec || 0));
}

function renderRoster() {
  const roster = $("#silly_friends_roster");
  roster.empty();
  pruneTypingState();

  for (const member of runtime.members.values()) {
    const role = String(member.role || (member.isHost ? "host" : "player"));
    const flags = [
      role,
      member.ready ? "ready" : "not-ready",
      member.muted ? "muted" : "",
    ]
      .filter(Boolean)
      .join(", ");

    const chip = $(`
            <span class="silly-friends-member-chip">
                <img src="${escapeAttribute(member.avatarUrl || default_user_avatar)}" alt="">
                <span></span>
            </span>`);
    chip
      .find("span")
      .text(
        `${getDisplayName(member.personaName, "Persona")}${flags ? ` (${flags})` : ""}`,
      );
    chip.find("img").on("error", function () {
      this.src = default_user_avatar;
    });

    if (canModerateActions() && member.id !== runtime.memberId) {
      const controls = $('<span class="silly-friends-roster-controls"></span>');

      if (!member.isHost) {
        const promote = $(
          '<button type="button" class="menu_button">cohost</button>',
        );
        promote.on("click", () => {
          const targetRole =
            String(member.role || "") === "cohost" ? "player" : "cohost";
          setMemberRole(member.id, targetRole).catch(handleActionError);
        });
        controls.append(promote);

        const observer = $(
          '<button type="button" class="menu_button">observer</button>',
        );
        observer.on("click", () => {
          const targetRole =
            String(member.role || "") === "observer" ? "player" : "observer";
          setMemberRole(member.id, targetRole).catch(handleActionError);
        });
        controls.append(observer);
      }

      const mute = $('<button type="button" class="menu_button"></button>');
      mute.text(member.muted ? "unmute" : "mute");
      mute.on("click", () => {
        setMemberMuted(member.id, !member.muted).catch(handleActionError);
      });
      controls.append(mute);

      if (!member.isHost) {
        const kick = $('<button type="button" class="menu_button">kick</button>');
        kick.on("click", () => {
          kickMember(member.id).catch(handleActionError);
        });
        controls.append(kick);
      }

      chip.append(controls);
    }

    roster.append(chip);
  }

  const typingNames = Array.from(runtime.typingState.keys())
    .map((memberId) =>
      getDisplayName(runtime.members.get(memberId)?.personaName, ""),
    )
    .filter(Boolean);
  if (typingNames.length) {
    roster.append(
      $(`<div class="silly-friends-typing-indicator"></div>`).text(
        `${typingNames.join(", ")} typing...`,
      ),
    );
  }
}

function setBusy(isBusy) {
  $(
    "#silly_friends_host_start, #silly_friends_host_reload, #silly_friends_host_stop, #silly_friends_join, #silly_friends_leave",
  ).prop("disabled", isBusy);
}

function handleActionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  notifyError(message);
  updateUi();
}

function normalizeRelayUrl(url) {
  const trimmed = String(url || "").trim();
  return trimmed.replace(/\/+$/, "");
}

function sanitizeRelayId(value) {
  const text = String(value || "").trim();
  return /^[a-zA-Z0-9._:-]{1,128}$/.test(text) ? text : "";
}

function normalizeTurnMode(value) {
  const mode = String(value || "")
    .trim()
    .toLowerCase();
  return ["freeform", "turn", "initiative"].includes(mode) ? mode : "";
}

function normalizeTurnDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) {
    return 0;
  }

  return Math.min(3600, Math.floor(duration));
}

function normalizeTurnState(turn) {
  const state = turn && typeof turn === "object" ? turn : {};
  return {
    mode: normalizeTurnMode(state.mode) || "freeform",
    currentMemberId: sanitizeRelayId(state.currentMemberId),
    durationSec: normalizeTurnDuration(state.durationSec),
    endsAt: String(state.endsAt || ""),
  };
}

function getMyRole() {
  const me = runtime.members.get(runtime.memberId);
  const role = String(me?.role || "")
    .trim()
    .toLowerCase();
  if (role) {
    return role;
  }

  return runtime.isHost ? "host" : "player";
}

function canCommitActions() {
  const role = getMyRole();
  return role === "host" || role === "cohost";
}

function canModerateActions() {
  return canCommitActions();
}

function normalizeMemberRole(value) {
  const role = String(value || "")
    .trim()
    .toLowerCase();
  return ["host", "cohost", "player", "observer"].includes(role) ? role : "";
}

function getCurrentModelClientMsgIdFromTextarea() {
  const textarea = document.getElementById("send_textarea");
  return sanitizeRelayId(textarea?.dataset?.sillyFriendsModelClientMsgId);
}

function getDisplayName(value, fallback = "Persona") {
  const name = String(value || "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name || fallback;
}

function isLoopbackRelayUrl(url) {
  try {
    const hostname = new URL(String(url || "")).hostname.toLowerCase();
    return (
      hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
    );
  } catch {
    return false;
  }
}

function isShareableAvatarUrl(url) {
  return (
    typeof url === "string" &&
    (url.startsWith("data:image/") ||
      url.startsWith("http://") ||
      url.startsWith("https://"))
  );
}

function getInitials(name) {
  return (
    String(name || "?")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("") || "?"
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function installGenerateInterceptor() {
  globalThis.sillyFriendsGenerateInterceptor = async (coreChat) => {
    if (!ensureSettings().promptGrouping || !Array.isArray(coreChat)) {
      return;
    }

    const grouped = [];
    let buffer = [];
    let latestPromptMacros = null;

    const flush = () => {
      if (!buffer.length) {
        return;
      }

      const groupedMessage = createGroupedPromptMessage(buffer);
      latestPromptMacros = groupedMessage.extra?.sillyFriendsPromptMacros || null;
      grouped.push(groupedMessage);
      buffer = [];
    };

    for (const message of coreChat) {
      if (isPartyPlayerPromptMessage(message)) {
        buffer.push(message);
      } else {
        flush();
        grouped.push(message);
      }
    }

    flush();
    coreChat.splice(0, coreChat.length, ...grouped);

    if (latestPromptMacros) {
      applyPromptMacroOverride(latestPromptMacros);
    } else {
      restorePromptMacroOverride();
    }
  };
}

function isPartyPlayerPromptMessage(message) {
  return !!message?.is_user && !!message?.extra?.sillyFriends;
}

function createGroupedPromptMessage(messages) {
  const first = messages[0];
  const speakerProfiles = getGroupedSpeakerProfiles(messages);
  const userReplacement = speakerProfiles
    .map((profile) => profile.name)
    .join(" & ");
  const personaReplacement = speakerProfiles
    .map(
      (profile) =>
        `${profile.name}: ${formatPersonaDescription(profile.description)}`,
    )
    .join("\n");

  const groupedText = messages
    .map((message) => {
      const speaker = sanitizeSpeakerName(message.name || "Persona");
      const text = String(message.mes || "")
        .replaceAll("\r\n", "\n")
        .replaceAll("\r", "\n")
        .replaceAll("\n", "\n  ");
      return `${speaker}: ${text}`;
    })
    .join("\n");

  return Object.assign({}, first, {
    mes: groupedText,
    name: "",
    force_avatar: undefined,
    extra: Object.assign({}, first.extra || {}, {
      sillyFriendsGroupedPrompt: true,
      sillyFriendsUserReplacement: userReplacement,
      sillyFriendsPersonaReplacement: personaReplacement,
      sillyFriendsPromptMacros: {
        user: userReplacement,
        persona: personaReplacement,
      },
    }),
  });
}

function getGroupedSpeakerProfiles(messages) {
  const profiles = [];
  const seen = new Set();

  for (const message of messages) {
    const sillyFriends = message?.extra?.sillyFriends || {};
    const member = runtime.members.get(sillyFriends.memberId) || {};
    const name = sanitizeSpeakerName(
      sillyFriends.personaName || message?.name || member.personaName || "User",
    );

    if (seen.has(name)) {
      continue;
    }

    seen.add(name);
    profiles.push({
      name,
      description: String(
        sillyFriends.personaDescription || member.personaDescription || "",
      ).trim(),
    });
  }

  return profiles;
}

function formatPersonaDescription(description) {
  const normalized = String(description || "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim();

  if (!normalized) {
    return "(no description)";
  }

  return normalized.replaceAll("\n", "\n  ");
}

function applyPromptMacroOverride(macros) {
  const user = String(macros?.user || "").trim();
  const persona = String(macros?.persona || "").trim();
  if (!user && !persona) {
    restorePromptMacroOverride();
    return;
  }

  if (!runtime.promptMacroPreviousHelpers) {
    runtime.promptMacroPreviousHelpers = {
      user: Object.prototype.hasOwnProperty.call(Handlebars.helpers, "user")
        ? Handlebars.helpers.user
        : null,
      persona: Object.prototype.hasOwnProperty.call(
        Handlebars.helpers,
        "persona",
      )
        ? Handlebars.helpers.persona
        : null,
    };
  }

  runtime.promptMacroOverride = { user, persona };
  globalThis.sillyFriendsPromptMacroOverride = runtime.promptMacroOverride;
  Handlebars.registerHelper(
    "user",
    () => runtime.promptMacroOverride?.user || name1,
  );
  Handlebars.registerHelper(
    "persona",
    () =>
      runtime.promptMacroOverride?.persona ||
      power_user.persona_description ||
      "",
  );
}

function restorePromptMacroOverride() {
  if (!runtime.promptMacroPreviousHelpers) {
    runtime.promptMacroOverride = null;
    globalThis.sillyFriendsPromptMacroOverride = null;
    return;
  }

  for (const key of ["user", "persona"]) {
    const previous = runtime.promptMacroPreviousHelpers[key];
    if (previous) {
      Handlebars.registerHelper(key, previous);
    } else if (typeof Handlebars.unregisterHelper === "function") {
      Handlebars.unregisterHelper(key);
    } else {
      delete Handlebars.helpers[key];
    }
  }

  runtime.promptMacroOverride = null;
  globalThis.sillyFriendsPromptMacroOverride = null;
  runtime.promptMacroPreviousHelpers = null;
}

function sanitizeSpeakerName(name) {
  return (
    String(name || "Persona")
      .replace(/[\r\n:]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Persona"
  );
}

function handleLocalPersonaChanged(avatarId = user_avatar) {
  const changedAvatarId =
    typeof avatarId === "object" && avatarId !== null
      ? avatarId.avatarId
      : avatarId;
  if (changedAvatarId && user_avatar && changedAvatarId !== user_avatar) {
    return;
  }

  updateUi();
  schedulePersonaSnapshot();
}

function handleModelMessageReceived(messageId, type = "") {
  if (!runtime.connected || !runtime.isHost || !runtime.token) {
    return;
  }

  const index = normalizeChatIndex(messageId, chat.length - 1);
  const message = chat[index];
  if (!message || message.is_user || message.is_system) {
    return;
  }

  if (type === "swipe") {
    scheduleModelSwipePublish({
      messageIndex: index,
      reason: "swipeGenerated",
    });
    return;
  }

  scheduleModelMessagePublish({
    minIndex: index,
    reason: "messageReceived",
  });
}

function handleMessageSwiped(messageId) {
  if (!runtime.connected || !runtime.isHost || !runtime.token) {
    return;
  }

  const index = normalizeChatIndex(messageId, chat.length - 1);
  const message = chat[index];
  if (!message || message.is_user || message.is_system) {
    return;
  }

  if (isPendingGeneratedSwipe(message)) {
    logDebug("Skipping pre-generation swipe publish.", { index });
    return;
  }

  scheduleModelSwipePublish({
    messageIndex: index,
    reason: "messageSwiped",
  });
}

function handleMessageDeleted() {
  if (!runtime.connected || !runtime.isHost || !runtime.token) {
    return;
  }

  scheduleHostSnapshotSync("messageDeleted");
}

function handleGenerationEnded() {
  updateUi();
  if (
    runtime.connected &&
    runtime.isHost &&
    runtime.token &&
    runtime.modelGenerationStartIndex !== null
  ) {
    scheduleModelMessagePublish({
      minIndex: runtime.modelGenerationStartIndex,
      reason: "generationEnded",
    });
  }

  restorePromptMacroOverride();
}

function handleGenerationStopped() {
  runtime.modelGenerationStartIndex = null;
  restorePromptMacroOverride();
  updateUi();
}

function bindEvents() {
  eventSource.on(event_types.CHAT_CHANGED, () => {
    renderPendingMessages();
    renderModelEditProposals();
    decoratePartyMessages();
  });
  eventSource.on(event_types.GENERATION_STARTED, updateUi);
  eventSource.on(event_types.MESSAGE_RECEIVED, handleModelMessageReceived);
  eventSource.on(event_types.MESSAGE_SWIPED, handleMessageSwiped);
  eventSource.on(event_types.MESSAGE_DELETED, handleMessageDeleted);
  eventSource.on(event_types.GENERATION_ENDED, handleGenerationEnded);
  eventSource.on(event_types.GENERATION_STOPPED, handleGenerationStopped);
  eventSource.on(event_types.PERSONA_CHANGED, handleLocalPersonaChanged);
  eventSource.on(event_types.PERSONA_UPDATED, handleLocalPersonaChanged);
  eventSource.on(event_types.PERSONA_RENAMED, handleLocalPersonaChanged);
}

jQuery(() => {
  ensureSettings();
  renderSettings();
  installCommitButton();
  installInputCapture();
  installGenerateInterceptor();
  bindEvents();
  updateUi();
});
