// ---------- theme (applied immediately, before anything else renders) ----------
(function () {
  if (localStorage.getItem("betachat-theme") === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();

// ---------- helpers ----------
function genCode() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}
function colorFromName(name) {
  const palette = ["#2FA98C", "#3E8FD1", "#4FBFA0", "#5AA6D6", "#3F7F6B", "#6C93C4"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return palette[Math.abs(h) % palette.length];
}
function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0] ? w[0].toUpperCase() : "").join("");
}
function timeLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
// For embedding text inside an HTML attribute (e.g. download="..."), where
// unescaped quotes could break out of the attribute.
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function formatBytes(n) {
  if (!n) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

// ---------- profiles (display name + photo, layered on top of the fixed login username) ----------
let profilesCache = {}; // key -> { name, avatar }
let profilesListenerRef = null;

function profileFor(key, fallbackName) {
  const p = profilesCache[key];
  return {
    name: (p && p.name) || fallbackName || key,
    avatar: (p && p.avatar) || null,
    status: (p && p.status) || "",
    bio: (p && p.bio) || "",
    hideLastSeen: !!(p && p.hideLastSeen),
    color: colorFromName(key) // colored by the stable key, so it never shifts when a display name changes
  };
}
function avatarInnerHtml(key, fallbackName) {
  const p = profileFor(key, fallbackName);
  return p.avatar
    ? `<img src="${p.avatar}" class="avatar-img" alt="" />`
    : escapeHtml(initials(p.name));
}
function paintAvatar(elm, key, fallbackName) {
  const p = profileFor(key, fallbackName);
  if (p.avatar) {
    elm.style.background = "transparent";
    elm.innerHTML = `<img src="${p.avatar}" class="avatar-img" alt="" />`;
  } else {
    elm.style.background = p.color;
    elm.innerHTML = "";
    elm.textContent = initials(p.name);
  }
}

// ---------- state ----------
let username = null;
let hadAuthenticatedSession = false;
// Firebase signs the user in the instant createUserWithEmailAndPassword (or
// the Google popup) succeeds — before doSignUp/claimGoogleUsername has
// finished writing usernames/uids/profiles. onAuthStateChanged fires on that
// same instant too, and if it's left to run its normal fallback logic before
// those writes land, it grabs a wrong name and permanently saves it as the
// account's real username. This flag tells onAuthStateChanged to stand down
// while a signup/claim flow it is already in progress; the flow itself sets
// `username` and calls showApp() once its writes actually finish.
let authFlowInProgress = false;
let activeChatCode = null;
let activeChatData = null;
let chatListListener = null; // ref for usergroups
let groupListeners = {}; // code -> unsubscribe fn
let messagesListener = null;
let disappearingSweepTimer = null; // proactively fires messages off the screen right on schedule, instead of waiting for unrelated chat activity to trigger a re-check
let currentGroupsCache = {};
let lastPresenceForChat = null;


// ---------- elements ----------
const el = (id) => document.getElementById(id);

// Lightweight in-app feedback replaces disruptive browser alert dialogs.
const toastStack = el("toast-stack");
function showToast(message, tone) {
  if (!toastStack || !message) return;
  const toast = document.createElement("div");
  toast.className = "app-toast " + (tone || "info");
  toast.innerHTML = `<span class="toast-mark">${tone === "error" ? "!" : tone === "success" ? "✓" : "i"}</span><span></span>`;
  toast.querySelector("span:last-child").textContent = String(message);
  toastStack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("shown"));
  setTimeout(() => { toast.classList.remove("shown"); setTimeout(() => toast.remove(), 180); }, 3600);
}
// Existing feedback calls now receive the same message as a polished toast.
window.alert = (message) => showToast(message, /couldn.t|failed|error|blocked/i.test(String(message)) ? "error" : "success");

const screenLogin = el("screen-login");
const screenApp = el("screen-app");
const screenSplash = el("screen-splash");
const authTabSignin = el("auth-tab-signin");
const authTabSignup = el("auth-tab-signup");
const authPaneSignin = el("auth-pane-signin");
const authPaneSignup = el("auth-pane-signup");
const signinUsername = el("signin-username");
const signinPassword = el("signin-password");
const signinError = el("signin-error");
const signinBtn = el("signin-btn");
const signupUsername = el("signup-username");
const signupEmail = el("signup-email");
const signupPassword = el("signup-password");
const signupError = el("signup-error");
const signupBtn = el("signup-btn");
const forgotPasswordLink = el("forgot-password-link");
const backToSigninLink = el("back-to-signin-link");
const authPaneForgot = el("auth-pane-forgot");
const forgotUsername = el("forgot-username");
const forgotError = el("forgot-error");
const forgotSuccess = el("forgot-success");
const forgotBtn = el("forgot-btn");
const googleSigninBtn = el("google-signin-btn");
const authPaneGoogleUsername = el("auth-pane-google-username");
const googleUsername = el("google-username");
const googleUsernameError = el("google-username-error");
const googleUsernameBtn = el("google-username-btn");
const googleUsernameCancelLink = el("google-username-cancel-link");
const authGoogleRow = el("auth-google-row");
const authCardTitle = el("auth-card-title");
const authCardSubtitle = el("auth-card-subtitle");
const avatarMe = el("avatar-me");
const sidebarUserName = el("sidebar-user-name");
const editProfileBtn = el("edit-profile-btn");
const friendsBtn = el("friends-btn");
const friendsBadge = el("friends-badge");
const friendsModalBackdrop = el("modal-friends-backdrop");
const friendAddInput = el("friend-add-input");
const friendAddBtn = el("friend-add-btn");
const friendAddError = el("friend-add-error");
const friendsTabRequests = el("friends-tab-requests");
const friendsTabList = el("friends-tab-list");
const friendsPaneRequests = el("friends-pane-requests");
const friendsPaneList = el("friends-pane-list");
const friendRequestsListEl = el("friend-requests-list");
const friendSentListEl = el("friend-sent-list");
const friendsListEl = el("friends-list");
const friendsCloseBtn = el("friends-close-btn");
const themeToggleBtn = el("theme-toggle-btn");
const notifyToggleBtn = el("notify-toggle-btn");
const logoutBtn = el("logout-btn");
const profileModalBackdrop = el("modal-profile-backdrop");
const profileAvatarPreview = el("profile-avatar-preview");
const profilePhotoInput = el("profile-photo-input");
const profileRemovePhotoBtn = el("profile-remove-photo-btn");
const profileNameInput = el("profile-name-input");
const profileUsernameLocked = el("profile-username-locked");
const profileStatusInput = el("profile-status-input");
const profileError = el("profile-error");
const profileSaveBtn = el("profile-save-btn");
const profileCancelBtn = el("profile-cancel-btn");
const profileCloseTopBtn = el("profile-close-top-btn");
const appLockRow = el("app-lock-row");
const lastSeenPrivacyToggle = el("last-seen-privacy-toggle");
const appLockToggle = el("app-lock-toggle");
const screenApplock = el("screen-applock");
const applockStatus = el("applock-status");
const applockRetryBtn = el("applock-retry-btn");
const wallpaperBtn = el("wallpaper-btn");
const wallpaperModalBackdrop = el("modal-wallpaper-backdrop");
const wallpaperGrid = el("wallpaper-grid");
const wallpaperPreview = el("wallpaper-preview");
const wallpaperUploadInput = el("wallpaper-upload-input");
const wallpaperResetBtn = el("wallpaper-reset-btn");
const wallpaperCloseBtn = el("wallpaper-close-btn");
const pinnedBanner = el("pinned-banner");
const pinnedBannerText = el("pinned-banner-text");
const pinnedBannerUnpin = el("pinned-banner-unpin");
const replyPreviewBar = el("reply-preview-bar");
const replyPreviewSender = el("reply-preview-sender");
const replyPreviewText = el("reply-preview-text");
const replyPreviewCancel = el("reply-preview-cancel");
const disappearingBtn = el("disappearing-btn");
const muteChatBtn = el("mute-chat-btn");
const muteChatStatus = el("mute-chat-status");
const disappearingModalBackdrop = el("modal-disappearing-backdrop");
const disappearingOptions = document.querySelectorAll(".disappearing-option");
const disappearingCloseBtn = el("disappearing-close-btn");
const newChatBtn = el("new-chat-btn");
const chatListEl = el("chat-list");
const chatListCount = el("chat-list-count");
const emptyNewChatBtn = el("empty-new-chat-btn");
const emptyState = el("empty-state");
const chatView = el("chat-view");
const backBtn = el("back-btn");
const avatarChat = el("avatar-chat");
const chatNameEl = el("chat-name");
const chatMetaEl = el("chat-meta");
const membersBtn = el("members-btn");
const addMemberBtn = el("add-member-btn");
const groupEditBtn = el("group-edit-btn");
const groupEditBackdrop = el("modal-groupedit-backdrop");
const groupEditCloseBtn = el("groupedit-close-btn");
const groupEditNameInput = el("groupedit-name-input");
const groupEditDescriptionInput = el("groupedit-description-input");
const groupEditError = el("groupedit-error");
const groupEditSaveBtn = el("groupedit-save-btn");
const copyInviteLinkBtn = el("copy-invite-link-btn");
const leaveChatBtn = el("leave-chat-btn");
const groupPhotoInput = el("group-photo-input");
const membersModalBackdrop = el("modal-members-backdrop");
const membersListEl = el("members-list");
const membersCloseBtn = el("members-close-btn");
const searchBtn = el("search-btn");
const searchBar = el("search-bar");
const searchInput = el("search-input");
const searchCloseBtn = el("search-close-btn");
const chatSettingsBtn = el("chat-settings-btn");
const chatSettingsBackdrop = el("modal-chat-settings-backdrop");
const chatSettingsCloseBtn = el("chat-settings-close-btn");
const chatSettingsAvatar = el("chat-settings-avatar");
const chatSettingsName = el("chat-settings-name");
const chatSettingsMeta = el("chat-settings-meta");
const chatSettingsMembersLabel = el("chat-settings-members-label");
const disappearingStatusEl = el("disappearing-status");
const messagesEl = el("messages");
const jumpLatestBtn = el("jump-latest-btn");
const imageInput = el("image-input");
const fileInput = el("file-input");
const draftInput = el("draft-input");
const draftCount = el("draft-count");
const sendBtn = el("send-btn");
const mentionPicker = el("mention-picker");
const sendStatus = el("send-status");
const connectionBanner = el("connection-banner");
const connectionBannerText = el("connection-banner-text");
const connectionBannerIcon = el("connection-banner-icon");
const connectionRetryBtn = el("connection-retry-btn");
const chatListSearch = el("chat-list-search");
const chatListSearchClear = el("chat-list-search-clear");

const modalBackdrop = el("modal-backdrop");
const confirmBackdrop = el("modal-confirm-backdrop");
const confirmTitle = el("confirm-title");
const confirmText = el("confirm-text");
const confirmCancelBtn = el("confirm-cancel-btn");
const confirmOkBtn = el("confirm-ok-btn");

let confirmResolve = null;
function appConfirm(title, text, confirmLabel) { return new Promise((resolve) => { confirmResolve=resolve;confirmTitle.textContent=title;confirmText.textContent=text;confirmOkBtn.textContent=confirmLabel||"Confirm";confirmBackdrop.classList.remove("hidden");confirmCancelBtn.focus(); }); }
function finishConfirm(result){confirmBackdrop.classList.add("hidden");if(confirmResolve){confirmResolve(result);confirmResolve=null;}}
confirmCancelBtn.addEventListener("click",()=>finishConfirm(false));confirmOkBtn.addEventListener("click",()=>finishConfirm(true));confirmBackdrop.addEventListener("click",e=>{if(e.target===confirmBackdrop)finishConfirm(false);});

const forwardModalBackdrop = el("modal-forward-backdrop");
const forwardCloseBtn = el("forward-close-btn");
const forwardChatList = el("forward-chat-list");
const forwardSendBtn = el("forward-send-btn");
const tabCreate = el("tab-create");
const tabJoin = el("tab-join");
const tabDm = el("tab-dm");
const tabFriends = el("tab-friends");
const paneCreate = el("pane-create");
const paneJoin = el("pane-join");
const paneDm = el("pane-dm");
const createNameInput = el("create-name-input");
const createDescriptionInput = el("create-description-input");
const createError = el("create-error");
const createBtn = el("create-btn");
const joinCodeInput = el("join-code-input");
const joinError = el("join-error");
const joinBtn = el("join-btn");
const dmUsernameInput = el("dm-username-input");
const dmError = el("dm-error");
const dmBtn = el("dm-btn");
const modalCancel = el("modal-cancel");

// ---------- new elements: stories, profile view ----------
const storiesBar = el("stories-bar");
const storyPhotoInput = el("story-photo-input");
const profileBioInput = el("profile-bio-input");
const modalAddStoryBackdrop = el("modal-addstory-backdrop");
const storyAddPhotoBtn = el("story-add-photo-btn");
const storyAddTextBtn = el("story-add-text-btn");
const storyAddCancelBtn = el("story-add-cancel-btn");
const modalTextStoryBackdrop = el("modal-textstory-backdrop");
const textStoryPreview = el("textstory-preview");
const textStoryInput = el("textstory-input");
const textStoryColors = el("textstory-colors");
const textStoryError = el("textstory-error");
const textStoryPostBtn = el("textstory-post-btn");
const textStoryCancelBtn = el("textstory-cancel-btn");
const storyViewer = el("story-viewer");
const storyProgressBars = el("story-progress-bars");
const storyViewerAvatar = el("story-viewer-avatar");
const storyViewerName = el("story-viewer-name");
const storyViewerTime = el("story-viewer-time");
const storyViewerClose = el("story-viewer-close");
const storyViewerContent = el("story-viewer-content");
const storyNavPrev = el("story-nav-prev");
const storyNavNext = el("story-nav-next");
const storyViewerFooter = el("story-viewer-footer");
const storyDeleteBtn = el("story-delete-btn");
const storyReplyBtn = el("story-reply-btn");
const storyReactionBar = el("story-reaction-bar");
const storyViewersCount = el("story-viewers-count");
const modalProfileViewBackdrop = el("modal-profileview-backdrop");
const profileviewAvatar = el("profileview-avatar");
const profileviewName = el("profileview-name");
const profileviewUsername = el("profileview-username");
const profileviewStatus = el("profileview-status");
const profileviewBio = el("profileview-bio");
const profileviewFriendsCount = el("profileview-friends-count");
const profileviewActions = el("profileview-actions");
const profileviewGridTitle = el("profileview-grid-title");
const profileviewGrid = el("profileview-grid");
const profileviewCloseBtn = el("profileview-close-btn");
const reportBackdrop = el("modal-report-backdrop");
const reportCloseBtn = el("report-close-btn");
const reportUserLabel = el("report-user-label");
const reportReasonInput = el("report-reason-input");
const reportError = el("report-error");
const reportSendBtn = el("report-send-btn");

// ---------- auth helpers ----------
// Older accounts (created before real emails were collected) sign in with a
// synthetic email derived from the username, since Firebase's Email/Password
// provider needs *some* email. New accounts use the real email the person
// enters at signup instead, so a genuine password-reset flow works.
function emailForUsername(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "") + "@betachat.local";
}

// Looks up the real email on file for a username (stored at signup under
// userEmails/{key}). Falls back to the synthetic email for accounts created
// before this existed. Used at sign-in time (before we're authenticated),
// so userEmails/ must stay publicly readable — see README Firebase rules.
function resolveSigninEmail(name) {
  const key = encodeUsernameKey(name.trim().toLowerCase());
  return db.ref("userEmails/" + key).once("value").then((snap) => {
    return snap.exists() ? snap.val() : emailForUsername(name);
  });
}

// Writes a one-time, rule-enforced mapping from this Firebase Auth uid to the
// app's username-based key (myKey()). The security rules use this — instead
// of trusting anything the client claims about "who I am" — to know that the
// person currently signed in really does own a given key before letting them
// write to admin-only / owner-only / "my own" data. It's write-once: the
// rules forbid overwriting an existing uids/{uid} entry, so nobody can later
// remap their uid onto someone else's key to impersonate them.
// Repairs an account whose signup got interrupted before any of its
// database records were written — this happened to anyone who signed up
// while the security rules had a circular dependency bug (usernames/{key}
// required the uids mapping to exist, which itself required
// usernames/{key} to exist first, so neither could ever be written). Their
// Firebase Auth account exists and they can "sign in", but the app has
// nothing to work with for them. Safe to run on every login: it's a no-op
// once usernames/{key} exists.
function ensureAccountSetup() {
  const user = firebase.auth().currentUser;
  if (!user) return Promise.resolve();
  const key = myKey();
  return db.ref("usernames/" + key).once("value").then((snap) => {
    if (snap.exists()) return;
    return db.ref("usernames/" + key).set(username)
      .then(() => db.ref("uids/" + user.uid).set(key))
      .then(() => db.ref("userEmails/" + key).set(user.email))
      .then(() => db.ref("profiles/" + key).set({ name: username, avatar: null }));
  }).catch(() => {});
}

function ensureUidMapping() {
  const user = firebase.auth().currentUser;
  if (!user) return Promise.resolve();
  const ref = db.ref("uids/" + user.uid);
  return ref.once("value").then((snap) => {
    if (snap.exists()) return;
    return ref.set(myKey()).catch(() => {});
  }).catch(() => {});
}

// ---------- init ----------
function init() {
  firebase.auth().onAuthStateChanged((user) => {
    screenSplash.classList.add("hidden");
    if (authFlowInProgress) return; // doSignUp / claimGoogleUsername already owns this sign-in
    if (user) {
      hadAuthenticatedSession = true;
      db.ref("uids/" + user.uid).once("value").then((snap) => {
        if (snap.exists()) {
          // Returning user (any provider) — uids/{uid} is the one source of
          // truth for "which account is this" (not displayName or email,
          // since those can drift or, for Google, were never chosen by the
          // user at all), but it stores the lowercase KEY, not the real
          // cased display name. Resolve the real name from usernames/{key}
          // before using it anywhere — using the raw key directly here
          // previously leaked lowercase names into sent messages (and made
          // sending fail entirely, since the write rule requires the
          // sender field to match the real cased name).
          const key = snap.val();
          return db.ref("usernames/" + key).once("value").then((nameSnap) => {
            username = nameSnap.exists() ? nameSnap.val() : key;
            authPaneGoogleUsername.classList.add("hidden");
            showApp();
          });
        } else if (isGoogleUser(user)) {
          // Brand-new Google sign-in with no username claimed yet.
          showGoogleUsernamePane();
        } else {
          // Legacy email/password account from before uids/{uid} was
          // guaranteed to exist — ensureAccountSetup() repairs this below.
          username = user.displayName || user.email.split("@")[0];
          showApp();
        }
      });
    } else {
      const sessionEnded = hadAuthenticatedSession;
      hadAuthenticatedSession = false;
      username = null;
      switchAuthTab("signin");
      if (sessionEnded) signinError.textContent = "Your session ended. Please sign in again.";
      stopRolesListener();
      if (chatListListener) { chatListListener.off(); chatListListener = null; }
      Object.values(groupListeners).forEach((off) => off());
      Object.values(readListeners).forEach((off) => off());
      Object.values(joinRequestListeners).forEach((off) => off());
      groupListeners = {};
      readListeners = {};
      joinRequestListeners = {};
      joinRequestCounts = {};
      currentGroupsCache = {};
      myReadsCache = {};
      if (profilesListenerRef) { profilesListenerRef.off(); profilesListenerRef = null; }
      profilesCache = {};
      if (presenceConnectedOff) { presenceConnectedOff(); presenceConnectedOff = null; }
      presenceRef = null;
      if (friendsListenersOff) { friendsListenersOff(); friendsListenersOff = null; }
      friendRequestsCache = {};
      sentRequestsCache = {};
      friendsCache = {};
      teardownStoriesListeners();
      closeStoryViewer();
      screenApp.classList.add("hidden");
      screenLogin.classList.remove("hidden");
    }
  });
}

function showApp() {
  screenLogin.classList.add("hidden");
  screenApp.classList.remove("hidden");
  paintAvatar(avatarMe, myKey(), username);
  sidebarUserName.innerHTML = escapeHtml(profileFor(myKey(), username).name) + verifiedBadgeHtml(myKey());
  startRolesListener();
  // Everything below reads/writes paths keyed on "am I really this user",
  // which the security rules check via uids/{uid}. Wait for that mapping
  // to exist first so none of these race a permission-denied on first
  // login (new signups already have it set inline during signup; this
  // mainly covers existing accounts logging in for the first time after
  // the rules went live).
  ensureAccountSetup().then(() => ensureUidMapping()).then(() => {
    registerForPushNotifications();
    db.ref("usergroups/" + myKey()).once("value").then((snap) => {
      if (!snap.exists()) db.ref("usergroups/" + myKey()).set({});
    });
    // accounts created before profiles existed won't have one yet
    db.ref("profiles/" + myKey()).once("value").then((snap) => {
      if (!snap.exists()) db.ref("profiles/" + myKey()).set({ name: username, avatar: null });
    });
    if (!profilesListenerRef) {
      profilesListenerRef = db.ref("profiles");
      profilesListenerRef.on("value", (snap) => {
        profilesCache = snap.val() || {};
        paintAvatar(avatarMe, myKey(), username);
        sidebarUserName.innerHTML = escapeHtml(profileFor(myKey(), username).name) + verifiedBadgeHtml(myKey());
        renderChatList();
        renderMessages(lastRenderedMsgs);
        if (activeChatCode) refreshChatHeader();
        if (isOwner()) syncStoriesListeners();
      });
    }
    setupPresence();
    setupFriendsListeners();
    setupStoriesListener();
    listenToMyChats();
    ensureBotDm();
  });
}

// ---------- presence ----------
let presenceRef = null;
let presenceConnectedOff = null;

function setupPresence() {
  if (presenceConnectedOff) return; // already set up for this session
  presenceRef = db.ref("presence/" + myKey());
  const cref = db.ref(".info/connected");
  const cb = cref.on("value", (snap) => {
    if (snap.val() === true) {
      presenceRef.onDisconnect().set({ state: "offline", last_changed: firebase.database.ServerValue.TIMESTAMP });
      presenceRef.set({ state: "online", last_changed: firebase.database.ServerValue.TIMESTAMP });
    }
  });
  presenceConnectedOff = () => cref.off("value", cb);
}
// Marks us offline right away — used on sign-out, where the tab (and its
// realtime connection) often stays open, so Firebase's own onDisconnect
// detection wouldn't fire until much later, if at all.
function goOffline() {
  if (presenceConnectedOff) { presenceConnectedOff(); presenceConnectedOff = null; }
  if (presenceRef) {
    presenceRef.onDisconnect().cancel();
    presenceRef.set({ state: "offline", last_changed: firebase.database.ServerValue.TIMESTAMP });
    presenceRef = null;
  }
}
function presenceLabel(p) {
  if (!p) return "";
  if (p.state === "online") return "online";
  if (p.last_changed) return "last seen " + timeLabel(p.last_changed);
  return "offline";
}

// ---------- auth tabs ----------
authTabSignin.addEventListener("click", () => switchAuthTab("signin"));
authTabSignup.addEventListener("click", () => switchAuthTab("signup"));
document.querySelectorAll(".password-toggle").forEach((btn) => btn.addEventListener("click", () => {
  const input = el(btn.dataset.passwordTarget);
  if (!input) return;
  const reveal = input.type === "password";
  input.type = reveal ? "text" : "password";
  btn.textContent = reveal ? "Hide" : "Show";
  btn.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
}));

function setAuthHeading(title, subtitle) {
  if (authCardTitle) authCardTitle.textContent = title;
  if (authCardSubtitle) authCardSubtitle.textContent = subtitle;
}
function switchAuthTab(mode) {
  signinError.textContent = "";
  signupError.textContent = "";
  authPaneForgot.classList.add("hidden");
  authPaneGoogleUsername.classList.add("hidden");
  authGoogleRow.classList.remove("hidden");
  if (mode === "signin") {
    setAuthHeading("Welcome back", "Sign in to pick up where you left off.");
    authTabSignin.classList.add("active");
    authTabSignup.classList.remove("active");
    authPaneSignin.classList.remove("hidden");
    authPaneSignup.classList.add("hidden");
  } else {
    setAuthHeading("Make it yours", "Create an account and start your first conversation.");
    authTabSignup.classList.add("active");
    authTabSignin.classList.remove("active");
    authPaneSignup.classList.remove("hidden");
    authPaneSignin.classList.add("hidden");
  }
}

// ---------- forgot password ----------
forgotPasswordLink.addEventListener("click", (e) => {
  e.preventDefault();
  forgotError.textContent = "";
  forgotSuccess.classList.add("hidden");
  forgotUsername.value = signinUsername.value.trim();
  setAuthHeading("Reset your password", "We’ll email you a secure reset link.");
  authPaneSignin.classList.add("hidden");
  authPaneForgot.classList.remove("hidden");
});
backToSigninLink.addEventListener("click", (e) => {
  e.preventDefault();
  authPaneForgot.classList.add("hidden");
  setAuthHeading("Welcome back", "Sign in to pick up where you left off.");
  authPaneSignin.classList.remove("hidden");
});
forgotBtn.addEventListener("click", doForgotPassword);
forgotUsername.addEventListener("keydown", (e) => { if (e.key === "Enter") doForgotPassword(); });

function doForgotPassword() {
  const name = forgotUsername.value.trim();
  forgotError.textContent = "";
  forgotSuccess.classList.add("hidden");
  if (!name) { forgotError.textContent = "Enter your username."; return; }

  forgotBtn.disabled = true;
  const key = encodeUsernameKey(name.toLowerCase());
  db.ref("userEmails/" + key).once("value")
    .then((snap) => {
      if (!snap.exists()) {
        // Either an old account (synthetic email, can't receive real mail)
        // or the username doesn't exist. Either way we can't reset it
        // ourselves — say so without confirming which username exists.
        forgotError.textContent = "Couldn't find a resettable email for that username. Ask an Admin for help via the BetaChat Bot.";
        return null;
      }
      return firebase.auth().sendPasswordResetEmail(snap.val());
    })
    .then((result) => {
      if (result !== null) {
        forgotSuccess.classList.remove("hidden");
      }
    })
    .catch((err) => {
      forgotError.textContent = "Couldn't send reset email: " + (err.message || "try again.");
    })
    .finally(() => { forgotBtn.disabled = false; });
}

// ---------- sign in ----------
signinBtn.addEventListener("click", doSignIn);
signinPassword.addEventListener("keydown", (e) => { if (e.key === "Enter") doSignIn(); });

function doSignIn() {
  const name = signinUsername.value.trim();
  const password = signinPassword.value;
  signinError.textContent = "";
  if (!name || !password) { signinError.textContent = "Enter your username and password."; return; }
  signinBtn.disabled = true;
  resolveSigninEmail(name)
    .then((email) => firebase.auth().signInWithEmailAndPassword(email, password))
    .catch((err) => {
      if (err.code === "auth/user-not-found" || err.code === "auth/invalid-credential") {
        signinError.textContent = "No account with that username and password.";
      } else if (err.code === "auth/wrong-password") {
        signinError.textContent = "Wrong password.";
      } else {
        signinError.textContent = "Couldn't sign in: " + (err.message || "try again.");
      }
    })
    .finally(() => { signinBtn.disabled = false; });
}

// ---------- sign up ----------
signupBtn.addEventListener("click", doSignUp);
signupPassword.addEventListener("keydown", (e) => { if (e.key === "Enter") doSignUp(); });

function doSignUp() {
  const name = signupUsername.value.trim();
  const emailInput = signupEmail.value.trim();
  const password = signupPassword.value;
  signupError.textContent = "";
  if (!name) { signupError.textContent = "Choose a username."; return; }
  if (!/^[a-zA-Z0-9_. ]{2,24}$/.test(name)) { signupError.textContent = "Use letters, numbers, spaces, _ or . only."; return; }
  if (!emailInput || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput)) { signupError.textContent = "Enter a valid email — it's needed to reset your password later."; return; }
  if (!password || password.length < 6) { signupError.textContent = "Password must be at least 6 characters."; return; }

  const usernameKey = encodeUsernameKey(name.toLowerCase());
  if (RESERVED_USERNAMES.includes(usernameKey)) {
    signupError.textContent = "That username is reserved.";
    return;
  }

  signupBtn.disabled = true;
  authFlowInProgress = true;
  const email = emailInput;
  // The 3 owner slots (ahsanul arifin / founder / owner) already have a
  // placeholder row under usernames/ reserving the name, with no real
  // account behind it yet. So "taken" for them is decided by ownerClaimed/,
  // not by usernames/ existing — otherwise nobody could ever claim them.
  const isOwnerSlot = OWNER_USERNAMES.includes(usernameKey);
  if (isOwnerSlot) { signupError.textContent = "That username is reserved."; return; }

  firebase.auth().createUserWithEmailAndPassword(email, password)
    .then((cred) => {
      // Now that we're signed in, we're allowed to read/write the db.
      const takenRef = isOwnerSlot ? db.ref("ownerClaimed/" + usernameKey) : db.ref("usernames/" + usernameKey);
      return takenRef.once("value").then((snap) => {
        if (snap.exists()) {
          // Someone beat us to this username — undo the account we just made.
          return cred.user.delete().then(() => {
            signupError.textContent = isOwnerSlot ? "That owner name is already claimed." : "That username is already taken.";
            authFlowInProgress = false;
          });
        }
        return cred.user.updateProfile({ displayName: name })
          .then(() => db.ref("usernames/" + usernameKey).set(name))
          // uids must be set right here — userEmails and profiles below
          // both require this mapping to already exist.
          .then(() => db.ref("uids/" + cred.user.uid).set(usernameKey))
          .then(() => db.ref("userEmails/" + usernameKey).set(email))
          .then(() => db.ref("profiles/" + usernameKey).set({ name, avatar: null }))
          .then(() => { if (isOwnerSlot) return db.ref("ownerClaimed/" + usernameKey).set(true); })
          .then(() => {
            // Only now — after every write has actually landed — do we let
            // the app know who's signed in and show it.
            username = name;
            authFlowInProgress = false;
            showApp();
          });
      });
    })
    .catch((err) => {
      authFlowInProgress = false;
      const msg = (err.message || "").toLowerCase();
      if (err.code === "auth/email-already-in-use") {
        signupError.textContent = "That email is already registered — try signing in, or use a different email.";
      } else if (err.code === "auth/weak-password") {
        signupError.textContent = "Password is too weak — use at least 6 characters.";
      } else if (msg.includes("permission")) {
        signupError.textContent = "Server rules blocked this — double check the Realtime Database rules are published.";
      } else {
        signupError.textContent = "Couldn't create account: " + (err.message || "try again.");
      }
    })
    .finally(() => { signupBtn.disabled = false; });
}

// ---------- Google sign-in ----------
function isGoogleUser(user) {
  return user.providerData.some((p) => p.providerId === "google.com");
}

googleSigninBtn.addEventListener("click", doGoogleSignIn);

function doGoogleSignIn() {
  signinError.textContent = "";
  signupError.textContent = "";
  googleSigninBtn.disabled = true;
  const provider = new firebase.auth.GoogleAuthProvider();
  firebase.auth().signInWithPopup(provider)
    .catch((err) => {
      if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") return;
      const msg = "Couldn't sign in with Google: " + (err.message || "try again.");
      signinError.textContent = msg;
      signupError.textContent = msg;
    })
    .finally(() => { googleSigninBtn.disabled = false; });
}

function showGoogleUsernamePane() {
  signinError.textContent = "";
  signupError.textContent = "";
  googleUsernameError.textContent = "";
  const user = firebase.auth().currentUser;
  const suggestion = (user && user.displayName) ? user.displayName : "";
  if (suggestion) googleUsername.value = suggestion;
  setAuthHeading("Choose your username", "This is how friends will find you on BetaChat.");
  authTabSignin.classList.remove("active");
  authTabSignup.classList.remove("active");
  authPaneSignin.classList.add("hidden");
  authPaneSignup.classList.add("hidden");
  authPaneForgot.classList.add("hidden");
  authGoogleRow.classList.add("hidden");
  authPaneGoogleUsername.classList.remove("hidden");
}

googleUsernameCancelLink.addEventListener("click", (e) => {
  e.preventDefault();
  firebase.auth().signOut().then(() => {
    authGoogleRow.classList.remove("hidden");
    switchAuthTab("signin");
  });
});

googleUsernameBtn.addEventListener("click", claimGoogleUsername);
googleUsername.addEventListener("keydown", (e) => { if (e.key === "Enter") claimGoogleUsername(); });

function claimGoogleUsername() {
  const user = firebase.auth().currentUser;
  if (!user) { showGoogleUsernamePane(); return; }
  const name = googleUsername.value.trim();
  googleUsernameError.textContent = "";
  if (!name) { googleUsernameError.textContent = "Choose a username."; return; }
  if (!/^[a-zA-Z0-9_. ]{2,24}$/.test(name)) { googleUsernameError.textContent = "Use letters, numbers, spaces, _ or . only."; return; }

  const usernameKey = encodeUsernameKey(name.toLowerCase());
  if (RESERVED_USERNAMES.includes(usernameKey)) {
    googleUsernameError.textContent = "That username is reserved.";
    return;
  }

  googleUsernameBtn.disabled = true;
  authFlowInProgress = true;
  // Same owner-slot handling as the email/password path in doSignUp: the 3
  // owner names already have a placeholder row under usernames/, so
  // "taken" is decided by ownerClaimed/ for those, not by usernames/.
  const isOwnerSlot = OWNER_USERNAMES.includes(usernameKey);
  if (isOwnerSlot) { googleUsernameError.textContent = "That username is reserved."; return; }
  const takenRef = db.ref("usernames/" + usernameKey);

  takenRef.once("value")
    .then((snap) => {
      if (snap.exists()) {
        googleUsernameError.textContent = isOwnerSlot ? "That owner name is already claimed." : "That username is already taken.";
        authFlowInProgress = false;
        return;
      }
      return user.updateProfile({ displayName: name })
        .then(() => db.ref("usernames/" + usernameKey).set(name))
        .then(() => db.ref("uids/" + user.uid).set(usernameKey))
        .then(() => db.ref("userEmails/" + usernameKey).set(user.email))
        .then(() => db.ref("profiles/" + usernameKey).set({ name, avatar: null }))
        .then(() => { if (isOwnerSlot) return db.ref("ownerClaimed/" + usernameKey).set(true); })
        .then(() => {
          username = name;
          authFlowInProgress = false;
          authPaneGoogleUsername.classList.add("hidden");
          authGoogleRow.classList.remove("hidden");
          showApp();
        });
    })
    .catch((err) => {
      authFlowInProgress = false;
      const msg = (err.message || "").toLowerCase();
      if (msg.includes("permission")) {
        googleUsernameError.textContent = "Server rules blocked this — double check the Realtime Database rules are published.";
      } else {
        googleUsernameError.textContent = "Couldn't finish setup: " + (err.message || "try again.");
      }
    })
    .finally(() => { googleUsernameBtn.disabled = false; });
}

// Firebase keys can't contain ".", "#", "$", "[", "]", "/" — sanitize for use as a db key
function encodeUsernameKey(key) {
  return key.replace(/[.#$\[\]\/]/g, "_");
}
function keyFor(name) { return encodeUsernameKey(name.toLowerCase()); }
function myKey() { return keyFor(username); }

// ---------- reserved usernames / owners / admins / verified / blocked ----------
// OWNER_USERNAMES is the only hardcoded list left. These two accounts are
// permanent owners: always admin, always verified, can never be blocked or
// demoted, and are the only ones who can promote/demote other admins, grant
// the verified badge, or block a user. Use the same lowercase/underscore key
// format as usernames (spaces become "_").
const OWNER_USERNAMES = ["ahsanul arifin", "founder", "owner"];
const RESERVED_USERNAMES = ["admin", "bot", "betachat bot"];

// Live from the database — kept in sync by a listener started in showApp().
// { key: true } maps.
let adminsCache = {};
let verifiedCache = {};
let blockedCache = {};
let hiddenFromAdminsCache = {};
let rolesListenerOff = null;

function startRolesListener() {
  if (rolesListenerOff) return;
  const adminsRef = db.ref("admins");
  const verifiedRef = db.ref("verified");
  const blockedRef = isOwner() ? db.ref("blocked") : db.ref("blocked/" + myKey());
  const hiddenRef = isOwner() ? db.ref("hiddenFromAdmins") : null;
  const onAdmins = (snap) => { adminsCache = snap.val() || {}; refreshRoleDependentUi(); };
  const onVerified = (snap) => { verifiedCache = snap.val() || {}; refreshRoleDependentUi(); };
  const onBlocked = (snap) => { blockedCache = isOwner() ? (snap.val() || {}) : (snap.exists() ? { [myKey()]: snap.val() } : {}); refreshRoleDependentUi(); };
  const onHidden = (snap) => { hiddenFromAdminsCache = snap.val() || {}; refreshRoleDependentUi(); };
  adminsRef.on("value", onAdmins);
  verifiedRef.on("value", onVerified);
  blockedRef.on("value", onBlocked);
  if (hiddenRef) hiddenRef.on("value", onHidden);
  rolesListenerOff = () => {
    adminsRef.off("value", onAdmins);
    verifiedRef.off("value", onVerified);
    blockedRef.off("value", onBlocked);
    if (hiddenRef) hiddenRef.off("value", onHidden);
  };
}
function stopRolesListener() {
  if (rolesListenerOff) { rolesListenerOff(); rolesListenerOff = null; }
  adminsCache = {}; verifiedCache = {}; blockedCache = {}; hiddenFromAdminsCache = {};
}
function refreshRoleDependentUi() {
  // User management is owner-only. Site admins moderate within their assigned
  // scope; they never receive owner-level user directory controls.
  manageUsersBtn.classList.toggle("hidden", !isOwner());
  ownerDashboardBtn.classList.toggle("hidden", !isOwner());
  botRequestsBtn.classList.toggle("hidden", !isSiteAdmin());
  reportsBtn.classList.toggle("hidden", !isSiteAdmin());
  sidebarUserName.innerHTML = escapeHtml(profileFor(myKey(), username).name) + verifiedBadgeHtml(myKey());
  renderChatList();
  renderMessages(lastRenderedMsgs);
  if (activeChatCode) refreshChatHeader();
  if (!modalManageUsersBackdrop.classList.contains("hidden")) renderManageUsersList();
}

// isOwner/isSiteAdmin default to "me" when no key is given.
function isOwner(key) { return OWNER_USERNAMES.includes(key || myKey()); }
function isSiteAdmin(key) { const k = key || myKey(); return isOwner(k) || !!adminsCache[k]; }
function isVerified(key) { return isOwner(key) || !!adminsCache[key] || !!verifiedCache[key]; }
function isBlocked(key) { return !isOwner(key) && !!blockedCache[key]; }
function isHiddenFromAdmins(key) { return !isOwner(key) && !!hiddenFromAdminsCache[key]; }
function blockReasonFor(key) {
  const v = blockedCache[key];
  return (v && typeof v === "object" && v.reason) ? v.reason : "";
}
// Owner can block/unblock anyone (except other owners). Admins can only
// block/unblock ordinary (non-admin, non-owner) users — this stops admins
// from blocking each other or the owner.
function canBlock(actingKey, targetKey) {
  if (isOwner(targetKey)) return false;
  if (isOwner(actingKey)) return true;
  return isSiteAdmin(actingKey) && !isSiteAdmin(targetKey);
}
function setBlocked(key, blocked, reason) {
  if (isOwner()) {
    // Owner's direct writes are already covered by the database rules.
    if (blocked) {
      db.ref("blocked/" + key).set({ blocked: true, reason: (reason || "").trim(), by: myKey(), at: Date.now() })
        .then(() => logAudit("blocked user", key + ((reason || "").trim() ? ": " + (reason || "").trim() : "")).then(loadAuditLog))
        .catch((err) => window.alert("Couldn't block user: " + err.message));
    } else {
      db.ref("blocked/" + key).remove()
        .then(() => logAudit("unblocked user", key).then(loadAuditLog))
        .catch((err) => window.alert("Couldn't unblock user: " + err.message));
    }
    return;
  }
  // Ordinary admins go through a server function that verifies their
  // identity server-side, since the database rules only trust the owner
  // directly (see admin-block.js for why).
  firebase.auth().currentUser.getIdToken().then((idToken) => {
    return fetch(ADMIN_BLOCK_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken, targetKey: key, blocked, reason }),
    });
  }).then((res) => {
    if (!res.ok) return res.json().then((j) => { throw new Error(j.error || "Request failed"); });
  }).catch((err) => {
    window.alert("Couldn't update block status: " + err.message);
  });
}
function verifiedBadgeHtml(key) {
  if (!isVerified(key)) return "";
  return ` <svg class="verified-badge" viewBox="0 0 22 22" width="14" height="14" style="vertical-align:-2px" title="Verified">
    <path fill="#3E8FD1" d="M11 0l2.2 2 3-.6 1 2.9 2.9 1-.6 3L21.5 11l-2 2.2.6 3-2.9 1-1 2.9-3-.6L11 22l-2.2-2-3 .6-1-2.9-2.9-1 .6-3L0 11l2-2.2-.6-3 2.9-1 1-2.9 3 .6z"/>
    <path fill="#fff" d="M9.6 14.8L5.9 11l1.2-1.2 2.5 2.5 5.3-5.3 1.2 1.2z"/>
  </svg>`;
}

// ---------- manage users panel (owner only) ----------
const manageUsersBtn = el("manage-users-btn");
const ownerDashboardBtn = el("owner-dashboard-btn");
const ownerDashboardBackdrop = el("modal-owner-dashboard-backdrop");
const ownerDashboardCloseBtn = el("owner-dashboard-close-btn");
const ownerDashboardCloseBottomBtn = el("owner-dashboard-close-bottom-btn");
const modalManageUsersBackdrop = el("modal-manageusers-backdrop");
const manageUsersList = el("manageusers-list");
const manageUsersSearch = el("manageusers-search");
const manageUsersCloseBtn = el("manageusers-close-btn");
const manageUsersCloseTopBtn = el("manageusers-close-top-btn");
const manageUsersCloseFloatBtn = el("manageusers-close-float-btn");
const ownerDashboard = el("owner-dashboard");
const ownerMetricsRefresh = el("owner-metrics-refresh");
const ownerStatUsers = el("owner-stat-users");
const ownerStatMessages = el("owner-stat-messages");
const ownerStatActive = el("owner-stat-active");
const broadcastInput = el("broadcast-input");
const broadcastBtn = el("broadcast-btn");
const ownerDashboardStatus = el("owner-dashboard-status");
const ownerAuditList = el("owner-audit-list");
const ownerAuditRefresh = el("owner-audit-refresh");
const OWNER_TOOLS_ENDPOINT = "/.netlify/functions/owner-tools";
let allUsernamesCache = {}; // key -> display name, loaded from db.ref("usernames")
// Only the owner can read every user's presence (see database.rules.json) —
// this cache is only ever populated for the owner. The presence rule only
// grants access per exact key, not a broad "read everything" query, so we
// open one small listener per known user rather than one listener on
// presence/ as a whole (that would just get denied outright).
let manageUsersPresenceCache = {};
let manageUsersPresenceListeners = {}; // key -> off()

function syncManageUsersPresenceListeners() {
  if (!isOwner()) return;
  const wanted = new Set(Object.keys(allUsernamesCache));
  Object.keys(manageUsersPresenceListeners).forEach((key) => {
    if (!wanted.has(key)) {
      manageUsersPresenceListeners[key]();
      delete manageUsersPresenceListeners[key];
      delete manageUsersPresenceCache[key];
    }
  });
  wanted.forEach((key) => {
    if (manageUsersPresenceListeners[key]) return;
    const ref = db.ref("presence/" + key);
    const cb = ref.on("value", (snap) => {
      manageUsersPresenceCache[key] = snap.val();
      renderManageUsersList();
    });
    manageUsersPresenceListeners[key] = () => ref.off("value", cb);
  });
}
function stopManageUsersPresence() {
  Object.values(manageUsersPresenceListeners).forEach((off) => off());
  manageUsersPresenceListeners = {};
  manageUsersPresenceCache = {};
}

manageUsersBtn.addEventListener("click", () => {
  if (!isOwner()) return;
  modalManageUsersBackdrop.classList.remove("hidden");
  db.ref("usernames").once("value").then((snap) => {
    allUsernamesCache = snap.val() || {};
    renderManageUsersList();
    syncManageUsersPresenceListeners();
  });
});
function closeManageUsers() {
  modalManageUsersBackdrop.classList.add("hidden");
  stopManageUsersPresence();
}
manageUsersCloseBtn.addEventListener("click", closeManageUsers);
manageUsersCloseTopBtn.addEventListener("click", closeManageUsers);
manageUsersCloseFloatBtn.addEventListener("click", closeManageUsers);
function closeOwnerDashboard() { ownerDashboardBackdrop.classList.add("hidden"); }
ownerDashboardBtn.addEventListener("click", () => { if (!isOwner()) return; loadOwnerMetrics(); loadAuditLog(); ownerDashboardBackdrop.classList.remove("hidden"); });
ownerDashboardCloseBtn.addEventListener("click", closeOwnerDashboard);
ownerDashboardCloseBottomBtn.addEventListener("click", closeOwnerDashboard);
ownerDashboardBackdrop.addEventListener("click", (e) => { if (e.target === ownerDashboardBackdrop) closeOwnerDashboard(); });
modalManageUsersBackdrop.addEventListener("click", (e) => { if (e.target === modalManageUsersBackdrop) closeManageUsers(); });
manageUsersSearch.addEventListener("input", renderManageUsersList);

function renderManageUsersList() {
  if (!isOwner()) return;
  const q = manageUsersSearch.value.trim().toLowerCase();
  manageUsersList.innerHTML = "";
  const keys = Object.keys(allUsernamesCache)
    .filter((k) => !q || k.includes(q) || String(allUsernamesCache[k]).toLowerCase().includes(q))
    // Non-owner admins never see users the owner has hidden from the panel.
    .filter((k) => isOwner() || !isHiddenFromAdmins(k))
    .sort();
  if (keys.length === 0) {
    manageUsersList.innerHTML = `<div class="member-row-status">No users found.</div>`;
    return;
  }
  keys.forEach((key) => {
    const rawName = allUsernamesCache[key];
    const name = (typeof rawName === "string" && rawName.trim()) ? rawName : key;
    const owner = isOwner(key);
    const admin = isSiteAdmin(key);
    const verified = isVerified(key);
    const blocked = isBlocked(key);
    const reason = blockReasonFor(key);
    const hiddenFromAdmins = isHiddenFromAdmins(key);
    // Live status is only meaningful (and only readable at the db level —
    // see the presence rule) for the owner. Non-owner admins are limited to
    // seeing their friends' status, same as everyone else, via the normal
    // friends list / open DMs — not from this all-users panel.
    const presenceHtml = isOwner()
      ? (() => {
          const p = manageUsersPresenceCache[key];
          const online = p && p.state === "online";
          return `<span class="manageusers-status"><span class="presence-dot ${online ? "online" : ""}"></span>${escapeHtml(presenceLabel(p) || "offline")}</span>`;
        })()
      : "";
    const row = document.createElement("div");
    row.className = "manageusers-row";
    row.innerHTML = `
      <div class="manageusers-row-name"><span class="manageusers-row-namestring">${escapeHtml(name)}</span>${presenceHtml}
        <div class="manageusers-row-tags">
          ${owner ? '<span class="manageusers-tag owner">Owner</span>' : ""}
          ${!owner && admin ? '<span class="manageusers-tag admin">Admin</span>' : ""}
          ${verified ? '<span class="manageusers-tag verified">Verified</span>' : ""}
          ${blocked ? `<span class="manageusers-tag blocked" title="${escapeHtml(reason)}">Blocked${reason ? ": " + escapeHtml(reason) : ""}</span>` : ""}
          ${hiddenFromAdmins ? '<span class="manageusers-tag hidden">Hidden from admins</span>' : ""}
        </div>
      </div>
      <div class="manageusers-row-actions"></div>
    `;
    const actions = row.querySelector(".manageusers-row-actions");
    // Owner and admin can both message any user directly from here —
    // ordinary DM already isn't friend-gated, this just saves the trip
    // through the New chat modal.
    if (!owner && key !== myKey()) {
      const messageBtn = document.createElement("button");
      messageBtn.textContent = "Message";
      messageBtn.addEventListener("click", () => {
        modalManageUsersBackdrop.classList.add("hidden");
        stopManageUsersPresence();
        openOrCreateDm(key, name);
      });
      actions.appendChild(messageBtn);
    }
    if (owner) {
      const tag = document.createElement("div");
      tag.className = "member-row-status";
      tag.textContent = "Permanent owner";
      actions.appendChild(tag);
    } else {
      // Only the owner can promote/demote admins or grant/revoke verified badges.
      if (isOwner()) {
        const adminBtn = document.createElement("button");
        adminBtn.textContent = admin ? "Remove admin" : "Make admin";
        adminBtn.addEventListener("click", () => {
          db.ref("admins/" + key).set(admin ? null : true);
          logAudit(admin ? "removed admin" : "made admin", key).then(loadAuditLog);
          sendAutoMessageTo(key, name, admin ? adminRemovedMessage(name) : adminCongratsMessage(name));
        });
        actions.appendChild(adminBtn);

        const verifiedBtn = document.createElement("button");
        verifiedBtn.textContent = verified ? "Unverify" : "Verify";
        verifiedBtn.addEventListener("click", () => {
          db.ref("verified/" + key).set(verified ? null : true);
          logAudit(verified ? "removed verification" : "verified user", key).then(loadAuditLog);
          sendAutoMessageTo(key, name, verified ? verifiedRemovedMessage(name) : verifiedCongratsMessage(name));
        });
        actions.appendChild(verifiedBtn);

        const hideBtn = document.createElement("button");
        hideBtn.textContent = hiddenFromAdmins ? "Unhide from admins" : "Hide from admins";
        hideBtn.addEventListener("click", () => {
          db.ref("hiddenFromAdmins/" + key).set(hiddenFromAdmins ? null : true);
        });
        actions.appendChild(hideBtn);
      }

      // Owner can block anyone; admins can only block ordinary (non-admin) users.
      if (canBlock(myKey(), key)) {
        const blockBtn = document.createElement("button");
        blockBtn.textContent = blocked ? "Unblock" : "Block";
        blockBtn.className = blocked ? "" : "danger";
        blockBtn.addEventListener("click", () => {
          if (blocked) {
            setBlocked(key, false);
            return;
          }
          const reasonInput = window.prompt(`Reason for blocking ${name}? (optional, shown to them)`, "");
          if (reasonInput === null) return; // cancelled
          setBlocked(key, true, reasonInput);
        });
        actions.appendChild(blockBtn);
      }
    }
    manageUsersList.appendChild(row);
  });
}


function logAudit(action, detail) {
  if (!isOwner()) return Promise.resolve();
  return db.ref("auditLog").push({actor:myKey(),actorName:username,action,detail,ts:Date.now()}).catch(() => {});
}
function loadAuditLog() {
  if (!isOwner()) return; ownerAuditList.textContent = "Loading activity…";
  db.ref("auditLog").orderByChild("ts").limitToLast(12).once("value").then((snap) => {
    const rows=[]; snap.forEach((c)=>rows.push(c.val())); rows.reverse();
    ownerAuditList.innerHTML = rows.length ? rows.map((row) => `<div><strong>${escapeHtml(row.actorName || row.actor || "Owner")}</strong> ${escapeHtml(row.action || "updated settings")}<span>${escapeHtml(row.detail || "")} · ${timeLabel(row.ts || Date.now())}</span></div>`).join("") : "No activity recorded yet.";
  }).catch(()=>{ownerAuditList.textContent="Activity log unavailable. Publish the new Firebase rules.";});
}

function ownerTools(action, payload) {
  return firebase.auth().currentUser.getIdToken().then((idToken) => fetch(OWNER_TOOLS_ENDPOINT, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.assign({idToken,action},payload||{}))})).then(async res => { const data=await res.json(); if(!res.ok) throw new Error(data.error||"Request failed"); return data; });
}
function loadOwnerMetricsFallback() {
  // Netlify Drop deployments may not provision serverless Functions. The
  // owner can still safely read these exact paths under the existing rules.
  return db.ref("usernames").once("value").then((usersSnap) => {
    const users = usersSnap.val() || {}; const keys = Object.keys(users); const week = Date.now() - 7 * 864e5;
    return Promise.all(keys.map((key) => db.ref("presence/" + key).once("value").catch(() => null))).then((snaps) => ({
      users: keys.length, messagesToday: null,
      activeWeek: snaps.filter((snap) => snap && snap.val() && Number(snap.val().last_changed || 0) >= week).length
    }));
  });
}
function paintOwnerMetrics(data, note) {
  ownerDashboard.classList.remove("metrics-loading");
  ownerStatUsers.textContent = data.users == null ? "—" : data.users;
  ownerStatMessages.textContent = data.messagesToday == null ? "—" : data.messagesToday;
  ownerStatActive.textContent = data.activeWeek == null ? "—" : data.activeWeek;
  ownerDashboardStatus.textContent = note || "Updated just now";
}
function loadOwnerMetrics() {
  if (!isOwner()) return;
  ownerDashboardStatus.textContent = "Loading dashboard…";
  ownerDashboard.classList.add("metrics-loading");
  let functionError = null;
  ownerTools("metrics").then(data => paintOwnerMetrics(data)).catch((err) => {
    functionError = err;
    return loadOwnerMetricsFallback().then(data => paintOwnerMetrics(data, "Live overview loaded. Message totals need Netlify Functions.")).catch(() => { ownerDashboard.classList.remove("metrics-loading"); ownerDashboardStatus.textContent = "Couldn't load dashboard data: " + functionError.message; });
  });
}
ownerMetricsRefresh.addEventListener("click", loadOwnerMetrics);
ownerAuditRefresh.addEventListener("click", loadAuditLog);
function broadcastClientFallback(text) {
  return db.ref("usernames").once("value").then((snap) => {
    const users = snap.val() || {}; const code = "announcement_" + Date.now(); const now = Date.now(); const members = {}; const updates = {};
    Object.entries(users).forEach(([userKey, name]) => { members[userKey] = typeof name === "string" ? name : userKey; updates["usergroups/" + userKey + "/" + code] = true; });
    updates["groups/" + code] = {name:"BetaChat announcement",isBroadcast:true,members,admins:{[myKey()]:true},createdAt:now,lastActivity:now,lastSender:"BetaChat"};
    updates["messages/" + code + "/announcement"] = {sender:"BetaChat",ts:now,text,system:true,broadcast:true};
    return db.ref().update(updates).then(() => ({recipients:Object.keys(members).length}));
  });
}
broadcastBtn.addEventListener("click", () => {
  const text=broadcastInput.value.trim(); if(!text) return; if(!window.confirm("Send this announcement to every BetaChat user?")) return;
  broadcastBtn.disabled=true; ownerDashboardStatus.textContent="Sending announcement…";
  let functionError = null;
  ownerTools("broadcast",{text}).catch((err) => { functionError = err; return broadcastClientFallback(text); }).then(data=>{broadcastInput.value="";ownerDashboardStatus.textContent=`Sent to ${data.recipients} users.`; logAudit("broadcast", text.slice(0, 180)).then(loadAuditLog);}).catch(err=>{ownerDashboardStatus.textContent="Broadcast failed: " + (err.message || "unknown error") + (functionError ? ` (function call also failed: ${functionError.message})` : "");}).finally(()=>{broadcastBtn.disabled=false;});
});

// ---------- push notifications (native app only — no-op on website/Chrome) ----------
// Netlify function endpoint that actually sends the push. Empty until the
// serverless function is deployed; sends are silently skipped until then.
const PUSH_SEND_ENDPOINT = "/.netlify/functions/send-notification";
const ADMIN_BLOCK_ENDPOINT = "/.netlify/functions/admin-block";
const BOT_AI_ENDPOINT = "/.netlify/functions/bot-ai-reply";

function isNativeApp() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

// ---------- chat wallpaper (works on web + native — purely local/device-side) ----------
const WALLPAPER_THEME_IDS = ["theme-1", "theme-2", "theme-3", "theme-4", "theme-5", "theme-6"];

function wallpaperStorageKey(code) { return "wallpaper_" + code; }

function getWallpaperFor(code) {
  try {
    const raw = localStorage.getItem(wallpaperStorageKey(code));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

const WALLPAPER_THEME_BACKGROUNDS = {
  "theme-1": "linear-gradient(135deg, #2FA98C, #3E8FD1)",
  "theme-2": "linear-gradient(135deg, #1B2528, #10181B)",
  "theme-3": "linear-gradient(135deg, #7A5CFA, #3E8FD1)",
  "theme-4": "linear-gradient(135deg, #E2897D, #7A5CFA)",
  "theme-5": "linear-gradient(135deg, #2FA98C, #ECF3F1)",
  "theme-6": "repeating-linear-gradient(45deg, #10181B, #10181B 10px, #1B2528 10px, #1B2528 20px)",
};

function applyWallpaper(code) {
  const w = getWallpaperFor(code);
  messagesEl.style.backgroundImage = "";
  if (!w) return;
  if (w.type === "theme" && WALLPAPER_THEME_BACKGROUNDS[w.value]) {
    messagesEl.style.backgroundImage = WALLPAPER_THEME_BACKGROUNDS[w.value];
  } else if (w.type === "custom") {
    messagesEl.style.backgroundImage = `url(${w.value})`;
  }
}

function renderWallpaperGrid(code) {
  const current = getWallpaperFor(code);
  wallpaperPreview.style.backgroundImage = "";
  if (current && current.type === "theme" && WALLPAPER_THEME_BACKGROUNDS[current.value]) wallpaperPreview.style.backgroundImage = WALLPAPER_THEME_BACKGROUNDS[current.value];
  else if (current && current.type === "custom") wallpaperPreview.style.backgroundImage = `url(${current.value})`;
  wallpaperGrid.innerHTML = "";
  const defaultSwatch = document.createElement("div");
  defaultSwatch.className = "wallpaper-swatch theme-default" + (!current ? " selected" : "");
  defaultSwatch.title = "Default";
  defaultSwatch.addEventListener("click", () => {
    localStorage.removeItem(wallpaperStorageKey(code));
    applyWallpaper(code);
    renderWallpaperGrid(code);
  });
  wallpaperGrid.appendChild(defaultSwatch);

  WALLPAPER_THEME_IDS.forEach((themeId) => {
    const isSelected = current && current.type === "theme" && current.value === themeId;
    const swatch = document.createElement("div");
    swatch.className = "wallpaper-swatch " + themeId + (isSelected ? " selected" : "");
    swatch.addEventListener("click", () => {
      localStorage.setItem(wallpaperStorageKey(code), JSON.stringify({ type: "theme", value: themeId }));
      applyWallpaper(code);
      renderWallpaperGrid(code);
    });
    wallpaperGrid.appendChild(swatch);
  });
}

wallpaperBtn.addEventListener("click", () => {
  if (!activeChatCode) return;
  renderWallpaperGrid(activeChatCode);
  wallpaperModalBackdrop.classList.remove("hidden");
});
wallpaperCloseBtn.addEventListener("click", () => wallpaperModalBackdrop.classList.add("hidden"));
wallpaperResetBtn.addEventListener("click", () => {
  if (!activeChatCode) return;
  localStorage.removeItem(wallpaperStorageKey(activeChatCode));
  applyWallpaper(activeChatCode);
  renderWallpaperGrid(activeChatCode);
});
wallpaperUploadInput.addEventListener("change", () => {
  const file = wallpaperUploadInput.files[0];
  if (!file || !activeChatCode) return;
  resizeFitDataUrl(file, 1000, 0.6).then((dataUrl) => {
    if (dataUrl.length > 900000) { window.alert("That image is too large — try a smaller photo."); return; }
    localStorage.setItem(wallpaperStorageKey(activeChatCode), JSON.stringify({ type: "custom", value: dataUrl }));
    applyWallpaper(activeChatCode);
    renderWallpaperGrid(activeChatCode);
  });
  wallpaperUploadInput.value = "";
});

// ---------- app lock (native only — fingerprint/face unlock) ----------
const APP_LOCK_STORAGE_KEY = "appLockEnabled";

function isAppLockEnabled() { return isNativeApp() && localStorage.getItem(APP_LOCK_STORAGE_KEY) === "true"; }

function attemptAppUnlock(onSuccess) {
  if (!isAppLockEnabled()) { screenApplock.classList.add("hidden"); if (onSuccess) onSuccess(); return; }
  const NativeBiometric = window.Capacitor.Plugins.NativeBiometric;
  screenApplock.classList.remove("hidden");
  applockStatus.textContent = "Unlock with your fingerprint or face to continue.";
  if (!NativeBiometric) { screenApplock.classList.add("hidden"); if (onSuccess) onSuccess(); return; } // plugin missing — don't lock the person out
  NativeBiometric.verifyIdentity({
    reason: "Unlock BetaChat",
    title: "BetaChat is locked",
  }).then(() => {
    screenApplock.classList.add("hidden");
    if (onSuccess) onSuccess();
  }).catch(() => {
    applockStatus.textContent = "Unlock failed or cancelled. Tap below to try again.";
  });
}
applockRetryBtn.addEventListener("click", () => attemptAppUnlock(window.__appLockBootCallback));

function setupAppLockToggleUi() {
  if (!isNativeApp()) { appLockRow.classList.add("hidden"); return; }
  appLockRow.classList.remove("hidden");
  appLockToggle.checked = isAppLockEnabled();
}
appLockToggle.addEventListener("change", () => {
  const NativeBiometric = window.Capacitor.Plugins.NativeBiometric;
  if (!appLockToggle.checked) {
    localStorage.removeItem(APP_LOCK_STORAGE_KEY);
    return;
  }
  if (!NativeBiometric) {
    window.alert("Biometric unlock isn't available on this build.");
    appLockToggle.checked = false;
    return;
  }
  NativeBiometric.isAvailable().then((result) => {
    if (!result.isAvailable) {
      window.alert("No fingerprint/face unlock is set up on this device.");
      appLockToggle.checked = false;
      return;
    }
    return NativeBiometric.verifyIdentity({ reason: "Confirm to enable app lock", title: "Enable app lock" })
      .then(() => { localStorage.setItem(APP_LOCK_STORAGE_KEY, "true"); })
      .catch(() => { appLockToggle.checked = false; });
  });
});

// Android back closes the current layer first, then returns to the chat list.
if (isNativeApp() && window.Capacitor.Plugins.App) {
  window.Capacitor.Plugins.App.addListener("backButton", () => {
    const openModal = document.querySelector(".modal-backdrop:not(.hidden)");
    if (openModal) { openModal.classList.add("hidden"); return; }
    if (activeChatCode) { backBtn.click(); return; }
    window.Capacitor.Plugins.App.exitApp();
  });
}
// Re-lock whenever the app comes back from the background.
if (isNativeApp() && window.Capacitor.Plugins.App) {
  window.Capacitor.Plugins.App.addListener("appStateChange", (state) => {
    if (state.isActive) attemptAppUnlock();
  });
}

// ---------- app icon unread badge (native only) ----------
function updateAppBadge(count) {
  if (!isNativeApp()) return;
  const Badge = window.Capacitor.Plugins.Badge;
  if (!Badge) return;
  if (count > 0) Badge.set({ count }).catch(() => {});
  else Badge.clear().catch(() => {});
}

function registerForPushNotifications() {
  if (!isNativeApp()) return; // website / "Add to Home screen" version has no push token
  const PushNotifications = window.Capacitor.Plugins.PushNotifications;
  if (!PushNotifications) return;

  PushNotifications.requestPermissions().then((result) => {
    if (result.receive !== "granted") return;
    PushNotifications.register();
  });

  PushNotifications.addListener("registration", (token) => {
    if (token && token.value) {
      db.ref("profiles/" + myKey() + "/fcmToken").set(token.value);
    }
  });

  PushNotifications.addListener("registrationError", () => {
    // Non-fatal — app keeps working without push, just silently skip.
  });

  // Tapping a notification (app already open/backgrounded) jumps straight
  // to that chat.
  PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
    const code = action && action.notification && action.notification.data && action.notification.data.code;
    if (code) openChatWhenReady(code);
  });

  // Cold start: the app was fully closed and the notification tap is what
  // launched it. Ask the plugin for the notification that triggered launch.
  PushNotifications.getDeliveredNotifications().catch(() => {});
  if (PushNotifications.getLaunchNotification) {
    PushNotifications.getLaunchNotification().then((result) => {
      const code = result && result.notification && result.notification.data && result.notification.data.code;
      if (code) openChatWhenReady(code);
    }).catch(() => {});
  }
}

// Opens a chat by code once the app/chat-list is actually ready — handles
// the case where a notification launches the app before login/data has
// finished loading.
function openChatWhenReady(code, attemptsLeft) {
  if (attemptsLeft === undefined) attemptsLeft = 40; // ~10s at 250ms intervals
  if (username && currentGroupsCache && currentGroupsCache[code]) {
    openChat(code);
    return;
  }
  if (attemptsLeft <= 0) return;
  setTimeout(() => openChatWhenReady(code, attemptsLeft - 1), 250);
}

// Called after a message is saved, to ask the server to push a notification
// to the other participant(s). Fails silently if the endpoint isn't set up
// yet, or if this is the website/Chrome version (no server round-trip needed
// there since Firebase's live listener already updates the UI instantly).
function triggerPushNotification(code, senderName, text) {
  if (!PUSH_SEND_ENDPOINT) return;
  firebase.auth().currentUser.getIdToken().then((idToken) => fetch(PUSH_SEND_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken, code, senderName, text: (text || "").slice(0, 120) }),
  })).catch(() => {
    // Notification delivery is best-effort — never block or break the chat UI.
  });
}

logoutBtn.addEventListener("click", () => {
  hadAuthenticatedSession = false;
  goOffline();
  firebase.auth().signOut();
});
// best-effort: catch plain tab/browser closes too (not fully reliable, but
// Firebase's onDisconnect already covers that case server-side; this just
// makes the local state flip a little faster when it does work)
window.addEventListener("beforeunload", () => {
  if (presenceRef) presenceRef.set({ state: "offline", last_changed: firebase.database.ServerValue.TIMESTAMP });
});

// ---------- connectivity, session & graceful recovery ----------
let outgoingMessage = false;
let failedOutgoing = null;
function setSendStatus(kind, text) {
  if (!sendStatus) return;
  sendStatus.className = "send-status" + (kind ? " " + kind : "") + (!text ? " hidden" : "");
  sendStatus.textContent = text || "";
}
function updateConnectionUi() {
  const online = navigator.onLine;
  connectionBanner.classList.toggle("hidden", online);
  if (!online) {
    connectionBannerText.textContent = "You’re offline. Messages will send when you reconnect.";
    connectionBannerIcon.textContent = "◌";
  }
}
window.addEventListener("online", () => { updateConnectionUi(); setSendStatus("success", "Back online"); setTimeout(() => setSendStatus("", ""), 1800); });
window.addEventListener("offline", updateConnectionUi);
connectionRetryBtn.addEventListener("click", () => {
  if (navigator.onLine && failedOutgoing) { const retry = failedOutgoing; failedOutgoing = null; pushMessage(retry); }
  else updateConnectionUi();
});
updateConnectionUi();

// ---------- theme toggle ----------
const themeToggleIcon = el("theme-toggle-icon");
function updateNativeBars() {
  if (!isNativeApp()) return;
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const plugins = window.Capacitor.Plugins || {};
  if (plugins.StatusBar) {
    plugins.StatusBar.setBackgroundColor({ color: dark ? "#0d1618" : "#f5fbf8" }).catch(() => {});
    plugins.StatusBar.setStyle({ style: dark ? "DARK" : "LIGHT" }).catch(() => {});
  }
  if (plugins.NavigationBar) plugins.NavigationBar.setColor({ color: dark ? "#0d1618" : "#ffffff" }).catch(() => {});
}
function updateThemeBtn() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  themeToggleIcon.textContent = isDark ? "☀️" : "🌙";
  updateNativeBars();
}
updateThemeBtn();
themeToggleBtn.addEventListener("click", () => {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  if (isDark) {
    document.documentElement.removeAttribute("data-theme");
    localStorage.setItem("betachat-theme", "light");
  } else {
    document.documentElement.setAttribute("data-theme", "dark");
    localStorage.setItem("betachat-theme", "dark");
  }
  updateThemeBtn();
});

// ---------- desktop notifications ----------
// In the native (Capacitor) app, push notifications are handled automatically
// via registerForPushNotifications() / the PushNotifications plugin — the
// browser Notification API this button controls doesn't exist there, so hide
// the button entirely instead of letting it show a confusing error.
if (isNativeApp()) {
  notifyToggleBtn.classList.add("hidden");
}
function updateNotifyBtn() {
  if (isNativeApp()) return;
  const supported = "Notification" in window;
  const notifyToggleIcon = el("notify-toggle-icon");
  const notifyToggleStatus = el("notify-toggle-status");
  notifyToggleIcon.textContent = supported && Notification.permission === "granted" ? "🔔" : "🔕";
  notifyToggleBtn.title = !supported ? "Notifications aren't supported in this browser"
    : Notification.permission === "granted" ? "Notifications are on"
    : "Enable notifications";
  notifyToggleStatus.textContent = !supported ? "Not supported"
    : Notification.permission === "granted" ? "On"
    : Notification.permission === "denied" ? "Blocked"
    : "Off";
}
updateNotifyBtn();
notifyToggleBtn.addEventListener("click", () => {
  if (isNativeApp()) return; // button is hidden here, but guard anyway
  if (!("Notification" in window)) { window.alert("Notifications aren't supported in this browser."); return; }
  if (Notification.permission === "granted") { window.alert("Notifications are already on for this browser."); return; }
  if (Notification.permission === "denied") { window.alert("Notifications are blocked — enable them in your browser's site settings."); return; }
  Notification.requestPermission().then(updateNotifyBtn);
});
function muteStorageKey(code) { return "betachat-muted-" + code; }
function isChatMuted(code) { return localStorage.getItem(muteStorageKey(code)) === "true"; }
function refreshMuteChatUi() { if (!activeChatCode) return; muteChatStatus.textContent = isChatMuted(activeChatCode) ? "On" : "Off"; }
muteChatBtn.addEventListener("click", () => { if (!activeChatCode) return; const next = !isChatMuted(activeChatCode); localStorage.setItem(muteStorageKey(activeChatCode), String(next)); refreshMuteChatUi(); });

function notifyNewMessage(g) {
  if (g && isChatMuted(g.code)) return;
  if (isNativeApp()) return; // native push handles this instead
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  let title = g.name;
  if (g.isDirect) {
    const otherKey = otherMemberKeys(g)[0];
    if (otherKey) title = profileFor(otherKey, g.members[otherKey]).name;
  }
  try {
    const n = new Notification(title, { body: (g.lastSender || "Someone") + " sent a new message" });
    n.onclick = () => { window.focus(); openChat(g.code); n.close(); };
  } catch (e) { /* some browsers restrict Notification outside a user gesture in odd ways — fail quietly */ }
}

// ---------- edit profile ----------
let pendingAvatarChange = null; // null = no change, "" = remove photo, dataURL string = new photo

function openProfileModal() {
  profileError.textContent = "";
  pendingAvatarChange = null;
  const p = profileFor(myKey(), username);
  profileNameInput.value = p.name;
  profileUsernameLocked.textContent = "@" + myKey();
  profileStatusInput.value = p.status || "";
  profileBioInput.value = p.bio || "";
  lastSeenPrivacyToggle.checked = !!p.hideLastSeen;
  profilePhotoInput.value = "";
  paintAvatar(profileAvatarPreview, myKey(), username);
  setupAppLockToggleUi();
  profileModalBackdrop.classList.remove("hidden");
}
function closeProfileModal() {
  profileModalBackdrop.classList.add("hidden");
}
avatarMe.addEventListener("click", openProfileModal);
editProfileBtn.addEventListener("click", openProfileModal);
profileCancelBtn.addEventListener("click", closeProfileModal);
profileCloseTopBtn.addEventListener("click", closeProfileModal);

profilePhotoInput.addEventListener("change", () => {
  const file = profilePhotoInput.files && profilePhotoInput.files[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    profileError.textContent = "Please choose an image file.";
    return;
  }
  profileError.textContent = "Preparing photo…";
  resizeImageToDataUrl(file, 160)
    .then((dataUrl) => {
      if (dataUrl.length > 220000) {
        profileError.textContent = "That photo is too large even after resizing — try a different image.";
        return;
      }
      profileError.textContent = "";
      pendingAvatarChange = dataUrl;
      profileAvatarPreview.style.background = "transparent";
      profileAvatarPreview.innerHTML = `<img src="${dataUrl}" class="avatar-img" alt="" />`;
    })
    .catch(() => { profileError.textContent = "Couldn't read that image — try another one."; });
});

profileRemovePhotoBtn.addEventListener("click", () => {
  pendingAvatarChange = "";
  profileAvatarPreview.style.background = colorFromName(myKey());
  profileAvatarPreview.innerHTML = "";
  profileAvatarPreview.textContent = initials(profileNameInput.value.trim() || username);
});

// Resize/crop an image file down to a small square JPEG data URL, so avatars
// stay cheap to store and fast to load (no Firebase Storage bucket needed).
function resizeImageToDataUrl(file, size, quality) {
  return loadImage(file).then((img) => {
    const side = Math.min(img.width, img.height);
    const sx = (img.width - side) / 2;
    const sy = (img.height - side) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", quality || 0.75);
  });
}
// Scale an image down to fit within maxDim (keeping aspect ratio) for photo messages.
function resizeFitDataUrl(file, maxDim, quality) {
  return loadImage(file).then((img) => {
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", quality || 0.7);
  });
}
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode failed"));
      img.onload = () => resolve(img);
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

profileSaveBtn.addEventListener("click", () => {
  const newName = profileNameInput.value.trim();
  const newStatus = profileStatusInput.value.trim();
  const newBio = profileBioInput.value.trim();
  profileError.textContent = "";
  if (!newName) { profileError.textContent = "Enter a display name."; return; }
  if (newName.length > 40) { profileError.textContent = "Keep it under 40 characters."; return; }
  if (newStatus.length > 60) { profileError.textContent = "Keep your status under 60 characters."; return; }
  if (newBio.length > 150) { profileError.textContent = "Keep your bio under 150 characters."; return; }

  const updates = { name: newName, status: newStatus, bio: newBio, hideLastSeen: !!lastSeenPrivacyToggle.checked };
  if (pendingAvatarChange === "") updates.avatar = null;
  else if (pendingAvatarChange) updates.avatar = pendingAvatarChange;

  profileSaveBtn.disabled = true;
  db.ref("profiles/" + myKey()).update(updates)
    .then(() => { closeProfileModal(); })
    .catch(() => { profileError.textContent = "Couldn't save — try again."; })
    .finally(() => { profileSaveBtn.disabled = false; });
});

// ---------- chat list (live) ----------
let readListeners = {}; // code -> unsubscribe fn
let myReadsCache = {}; // code -> timestamp
let joinRequestListeners = {}; // code -> unsubscribe fn (only set up for groups I admin)
let joinRequestCounts = {}; // code -> pending count

let handledInviteLink = false;
function handleInviteLink() {
  if (handledInviteLink || !username) return;
  const code = new URLSearchParams(location.search).get("join");
  if (!code) return; handledInviteLink = true;
  const cleanCode = code.trim().toUpperCase();
  db.ref("groups/" + cleanCode).once("value").then((snap) => {
    if (!snap.exists()) return;
    const g = snap.val();
    if (g.members && g.members[myKey()]) { openChat(cleanCode); return; }
    db.ref("joinRequests/" + cleanCode + "/" + myKey()).set({name:username,ts:Date.now(),via:"invite_link"}).then(() => {
      history.replaceState({}, "", location.pathname); window.alert("Join request sent. A group admin will approve it soon.");
    });
  });
}

function listenToMyChats() {
  const ref = db.ref("usergroups/" + myKey());
  chatListListener = ref;
  ref.on("value", (snap) => {
    const codes = snap.exists() ? Object.keys(snap.val()) : [];
    handleInviteLink();
    // clean up listeners for groups no longer in list
    Object.keys(groupListeners).forEach((code) => {
      if (!codes.includes(code)) {
        groupListeners[code]();
        delete groupListeners[code];
        delete currentGroupsCache[code];
      }
    });
    Object.keys(readListeners).forEach((code) => {
      if (!codes.includes(code)) {
        readListeners[code]();
        delete readListeners[code];
        delete myReadsCache[code];
      }
    });
    Object.keys(joinRequestListeners).forEach((code) => {
      if (!codes.includes(code)) {
        joinRequestListeners[code]();
        delete joinRequestListeners[code];
        delete joinRequestCounts[code];
      }
    });
    if (codes.length === 0) {
      currentGroupsCache = {};
      renderChatList();
    }
    codes.forEach((code) => {
      if (!groupListeners[code]) {
        const gref = db.ref("groups/" + code);
        const cb = gref.on("value", (gsnap) => {
          if (gsnap.exists()) {
            const newData = gsnap.val();
            const prev = currentGroupsCache[code];
            currentGroupsCache[code] = Object.assign({ code }, newData);
            const isNewActivity = prev && (newData.lastActivity || 0) > (prev.lastActivity || 0);
            const fromSomeoneElse = newData.lastSender && newData.lastSender !== username;
            const notCurrentlyViewing = document.hidden || activeChatCode !== code;
            if (isNewActivity && fromSomeoneElse && notCurrentlyViewing) {
              notifyNewMessage(currentGroupsCache[code]);
            }
            updateJoinRequestListenerFor(code, currentGroupsCache[code]);
          } else {
            delete currentGroupsCache[code];
          }
          renderChatList();
        });
        groupListeners[code] = () => gref.off("value", cb);
      }
      if (!readListeners[code]) {
        const rref = db.ref("reads/" + code + "/" + myKey());
        const rcb = rref.on("value", (rsnap) => {
          myReadsCache[code] = rsnap.val() || 0;
          renderChatList();
        });
        readListeners[code] = () => rref.off("value", rcb);
      }
    });
  });
}

// Watches joinRequests/{code} live, but only for groups I actually admin —
// no point (and no permission, per the security rules) watching it
// otherwise. Called every time a group's data changes, since admin status
// can change at any moment (promoted/demoted).
function updateJoinRequestListenerFor(code, g) {
  const shouldWatch = !g.isDirect && isGroupAdmin(g, myKey());
  if (shouldWatch && !joinRequestListeners[code]) {
    const jref = db.ref("joinRequests/" + code);
    const jcb = jref.on("value", (jsnap) => {
      const prevCount = joinRequestCounts[code] || 0;
      const n = jsnap.exists() ? Object.keys(jsnap.val()).length : 0;
      joinRequestCounts[code] = n;
      if (n > prevCount) notifyNewJoinRequest(currentGroupsCache[code]);
      renderChatList();
      if (activeChatCode === code) refreshChatSettingsPanel();
    });
    joinRequestListeners[code] = () => jref.off("value", jcb);
  } else if (!shouldWatch && joinRequestListeners[code]) {
    joinRequestListeners[code]();
    delete joinRequestListeners[code];
    delete joinRequestCounts[code];
    renderChatList();
  }
}

function notifyNewJoinRequest(g) {
  if (!g) return;
  if (isNativeApp()) return; // native push isn't wired up for this yet
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(g.name, { body: "একজন নতুন যোগ দিতে চান — অনুমোদনের অপেক্ষায়" });
    n.onclick = () => { window.focus(); openChat(g.code); membersBtn.click(); n.close(); };
  } catch (e) { /* fail quietly */ }
}

function renderChatList() {
  const chatQuery = (chatListSearch && chatListSearch.value || "").trim().toLowerCase();
  const groups = Object.values(currentGroupsCache).filter((g) => {
    if (!chatQuery) return true;
    const other = g.isDirect ? otherMemberKeys(g).map((k) => profileFor(k, (g.members || {})[k]).name).join(" ") : "";
    return (g.name || "").toLowerCase().includes(chatQuery) || other.toLowerCase().includes(chatQuery);
  }).sort(
    (a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)
  );
  chatListEl.innerHTML = "";
  if (chatListCount) chatListCount.textContent = groups.length ? groups.length : "";
  if (groups.length === 0) {
    const div = document.createElement("div");
    div.className = "empty-list-msg" + (chatQuery ? " search-empty-list" : "");
    div.innerHTML = chatQuery ? "<strong>🔍 No conversations found</strong><span>Try another search.</span>" : "No chats yet. Create one or join with an invite code.";
    chatListEl.appendChild(div);
    updateAppBadge(0);
    return;
  }
  let unreadCount = 0;
  groups.forEach((g) => {
    const memberCount = g.members ? Object.keys(g.members).length : 0;
    const lastRead = myReadsCache[g.code] || 0;
    const unread = (g.lastActivity || 0) > lastRead && g.lastSender && g.lastSender !== username;
    if (unread) unreadCount++;
    const pendingRequests = joinRequestCounts[g.code] || 0;

    // For DMs, show the other person's live display name + photo instead of
    // the raw "you & them" group name / a name-colored initials circle.
    let rowName = g.name;
    let avatarHtml = `<div class="avatar large" style="background:${colorFromName(g.name)}">${escapeHtml(initials(g.name))}</div>`;
    if (g.isDirect) {
      const otherKey = otherMemberKeys(g)[0];
      if (otherKey) {
        const fallback = (g.members && g.members[otherKey]) || g.name;
        const p = profileFor(otherKey, fallback);
        rowName = p.name;
        avatarHtml = `<div class="avatar large" style="background:${p.avatar ? "transparent" : p.color}">${avatarInnerHtml(otherKey, fallback)}</div>`;
      }
    }

    const row = document.createElement("div");
    row.className = "chat-row" + (activeChatCode === g.code ? " active" : "");
    row.innerHTML = `
      ${avatarHtml}
      <div class="chat-row-info">
        <div class="chat-row-name">${escapeHtml(rowName)}</div>
        <div class="chat-row-meta">${escapeHtml(g.lastMessage || (g.isDirect ? "Start a conversation" : memberCount + " member" + (memberCount !== 1 ? "s" : "")))}</div>
      </div>
      ${pendingRequests > 0 ? `<div class="chat-row-request-badge" title="Pending join requests">${pendingRequests}</div>` : ""}
      <div class="chat-row-trailing"><span class="chat-row-time">${g.lastActivity ? escapeHtml(timeLabel(g.lastActivity)) : ""}</span>${unread ? '<span class="chat-row-unread-dot"></span>' : ""}</div>
    `;
    row.addEventListener("click", () => {
      openChat(g.code);
      if (pendingRequests > 0) membersBtn.click();
    });
    chatListEl.appendChild(row);
  });
  const totalPendingRequests = Object.values(joinRequestCounts).reduce((sum, n) => sum + n, 0);
  updateAppBadge(unreadCount + totalPendingRequests);
}

// ---------- create / join ----------
if (chatListSearch) chatListSearch.addEventListener("input", () => { chatListSearchClear.classList.toggle("hidden", !chatListSearch.value); renderChatList(); });
chatListSearchClear.addEventListener("click", () => { chatListSearch.value = ""; chatListSearchClear.classList.add("hidden"); renderChatList(); chatListSearch.focus(); });
function openNewChatModal() { modalBackdrop.classList.remove("hidden"); switchTab("create"); }
newChatBtn.addEventListener("click", openNewChatModal);
emptyNewChatBtn.addEventListener("click", openNewChatModal);
document.querySelectorAll("[data-empty-action]").forEach((btn) => btn.addEventListener("click", () => { openNewChatModal(); createNameInput.value = btn.dataset.emptyAction; createNameInput.focus(); }));
modalCancel.addEventListener("click", () => modalBackdrop.classList.add("hidden"));
tabCreate.addEventListener("click", () => switchTab("create"));
tabJoin.addEventListener("click", () => switchTab("join"));
tabDm.addEventListener("click", () => switchTab("dm"));
tabFriends.addEventListener("click", () => { modalBackdrop.classList.add("hidden"); friendsBtn.click(); });

function switchTab(mode) {
  createError.textContent = "";
  joinError.textContent = "";
  dmError.textContent = "";
  tabCreate.classList.toggle("active", mode === "create");
  tabJoin.classList.toggle("active", mode === "join");
  tabDm.classList.toggle("active", mode === "dm");
  paneCreate.classList.toggle("hidden", mode !== "create");
  paneJoin.classList.toggle("hidden", mode !== "join");
  paneDm.classList.toggle("hidden", mode !== "dm");
}

createBtn.addEventListener("click", () => {
  const name = createNameInput.value.trim();
  if (!name) { createError.textContent = "Name your chat."; return; }
  const code = genCode();
  const group = {
    name,
    description: createDescriptionInput.value.trim(),
    members: { [myKey()]: username },
    admins: { [myKey()]: true },
    createdAt: Date.now(),
    lastActivity: Date.now(),
    lastSender: username
  };
  db.ref("groups/" + code).set(group)
    .then(() => db.ref("messages/" + code).set({ placeholder: true }))
    .then(() => db.ref("usergroups/" + myKey() + "/" + code).set(true))
    .then(() => {
      createNameInput.value = "";
      createDescriptionInput.value = "";
      modalBackdrop.classList.add("hidden");
      openChat(code);
    })
    .catch(() => { createError.textContent = "Couldn't create the chat. Try again."; });
});

joinBtn.addEventListener("click", () => {
  const code = joinCodeInput.value.trim().toUpperCase();
  if (!code) { joinError.textContent = "Enter an invite code."; return; }
  joinBtn.disabled = true;
  db.ref("groups/" + code).once("value").then((snap) => {
    if (!snap.exists()) { joinError.textContent = "No chat found with that code."; joinBtn.disabled = false; return; }
    const g = snap.val() || {};
    // Already a member (e.g. re-entering an old code) — just open it, no
    // need to go through approval again.
    if (g.members && g.members[myKey()]) {
      joinCodeInput.value = "";
      modalBackdrop.classList.add("hidden");
      openChat(code);
      joinBtn.disabled = false;
      return;
    }
    // Knowing the code no longer joins you in instantly — it files a
    // request that a group admin has to approve first (see the "Join
    // requests" section of the Members panel).
    db.ref("joinRequests/" + code + "/" + myKey()).set({ name: username, ts: Date.now() })
      .then(() => {
        joinCodeInput.value = "";
        modalBackdrop.classList.add("hidden");
        window.alert("অনুরোধ পাঠানো হয়েছে। ঐ চ্যাটের একজন Admin অনুমোদন করলে আপনি যোগ দিতে পারবেন।");
      })
      .catch(() => { joinError.textContent = "Couldn't send join request. Check the code and try again."; })
      .finally(() => { joinBtn.disabled = false; });
  }).catch(() => { joinError.textContent = "Couldn't join. Check the code and try again."; joinBtn.disabled = false; });
});

dmBtn.addEventListener("click", () => {
  const target = dmUsernameInput.value.trim();
  dmError.textContent = "";
  if (!target) { dmError.textContent = "Enter a username."; return; }
  if (target.toLowerCase() === username.toLowerCase()) { dmError.textContent = "That's you."; return; }

  const targetKey = keyFor(target);
  db.ref("usernames/" + targetKey).once("value").then((snap) => {
    if (!snap.exists()) { dmError.textContent = "No user found with that username."; return; }
    // Older accounts stored just `true`; newer ones store the real display name.
    const targetName = typeof snap.val() === "string" ? snap.val() : target;
    openOrCreateDm(targetKey, targetName).then(() => {
      dmUsernameInput.value = "";
      modalBackdrop.classList.add("hidden");
    });
  }).catch(() => { dmError.textContent = "Couldn't start the chat. Try again."; });
});

// Shared by "Message someone", and the Friends list's "Message" button.
function openOrCreateDm(targetKey, targetName) {
  const dmCode = "dm_" + [myKey(), targetKey].sort().join("_");
  return db.ref("groups/" + dmCode).once("value").then((gsnap) => {
    const alreadyExists = gsnap.exists();
    const finish = () => {
      db.ref("usergroups/" + myKey() + "/" + dmCode).set(true);
      db.ref("usergroups/" + targetKey + "/" + dmCode).set(true);
      openChat(dmCode);
    };
    if (alreadyExists) {
      finish();
      return;
    }
    return db.ref("groups/" + dmCode).set({
      name: [username, targetName].sort().join(" & "),
      isDirect: true,
      members: { [myKey()]: username, [targetKey]: targetName },
      createdAt: Date.now(),
      lastActivity: Date.now(),
      lastSender: username
    }).then(() => db.ref("messages/" + dmCode).set({ placeholder: true }))
      .then(finish);
  });
}

// Sends a message into the (auto-created if needed) DM between the current
// user and targetKey, WITHOUT switching the current user's open chat — used
// for automated system messages (e.g. admin/verified congratulations) sent
// while the owner is still working inside the Manage Users panel.
function sendAutoMessageTo(targetKey, targetName, text) {
  const dmCode = "dm_" + [myKey(), targetKey].sort().join("_");
  return db.ref("groups/" + dmCode).once("value").then((gsnap) => {
    const finish = () => {
      db.ref("usergroups/" + myKey() + "/" + dmCode).set(true);
      db.ref("usergroups/" + targetKey + "/" + dmCode).set(true);
      const msg = { sender: username, ts: Date.now(), text };
      db.ref("messages/" + dmCode).push(msg);
      db.ref("groups/" + dmCode + "/lastActivity").set(Date.now());
      db.ref("groups/" + dmCode + "/lastSender").set(username);
      triggerPushNotification(dmCode, username, text);
    };
    if (gsnap.exists()) { finish(); return; }
    return db.ref("groups/" + dmCode).set({
      name: [username, targetName].sort().join(" & "),
      isDirect: true,
      members: { [myKey()]: username, [targetKey]: targetName },
      createdAt: Date.now(),
      lastActivity: Date.now(),
      lastSender: username
    }).then(() => db.ref("messages/" + dmCode).set({ placeholder: true }))
      .then(finish);
  });
}

function adminCongratsMessage(targetName) {
  return `🎉 Congratulations ${targetName}! আপনাকে এখন Admin বানানো হয়েছে।

✅ Admin হিসেবে আপনি যা করতে পারবেন:
• যেকোনো message বা story delete করতে পারবেন (নিজের হোক বা অন্য কারো)
• স্বয়ংক্রিয়ভাবে Verified badge (নীল টিক) পাবেন
• সাধারণ (admin/owner নন এমন) user-দের block/unblock করতে পারবেন

❌ Admin হিসেবে আপনি যা করতে পারবেন না:
• অন্য কাউকে admin বানাতে বা admin থেকে সরাতে পারবেন না
• কাউকে verify/unverify করতে পারবেন না
• অন্য কোনো admin বা owner-কে block করতে পারবেন না

⚠️ মেনে চলতে হবে এমন নিয়ম:
• ক্ষমতার অপব্যবহার করা যাবে না — শুধু প্রকৃত প্রয়োজনে message/story delete বা user block করবেন
• ব্যক্তিগত রাগ বা পক্ষপাতিত্ব করে কাউকে block/delete করা যাবে না
• অন্যদের সাথে খারাপ ব্যবহার বা হয়রানি করা যাবে না

এই নিয়ম ভঙ্গ করলে owner যেকোনো সময় আপনাকে admin থেকে সরিয়ে দিতে পারবেন। দায়িত্বের সাথে ব্যবহার করার জন্য ধন্যবাদ! 🙏`;
}

function verifiedCongratsMessage(targetName) {
  return `🎉 Congratulations ${targetName}! আপনাকে এখন Verified badge (নীল টিক ✅) দেওয়া হয়েছে।

এর মানে হলো owner আপনার account-টি নিশ্চিত/বিশ্বস্ত হিসেবে চিহ্নিত করেছেন।

owner চাইলে যেকোনো সময় এই badge সরিয়ে নিতে পারবেন, তাই সবার সাথে ভালো আচরণ বজায় রাখুন। ধন্যবাদ! 🙏`;
}

function adminRemovedMessage(targetName) {
  return `আপনার Admin ক্ষমতা প্রত্যাহার করা হয়েছে, ${targetName}।

এখন থেকে আপনি আর অন্যদের message/story delete বা কাউকে block/unblock করতে পারবেন না, এবং automatic verified badge-ও আর থাকবে না (owner আলাদাভাবে verify না করে থাকলে)।

কোনো প্রশ্ন থাকলে owner-এর সাথে যোগাযোগ করুন।`;
}

function verifiedRemovedMessage(targetName) {
  return `আপনার Verified badge (নীল টিক) সরিয়ে নেওয়া হয়েছে, ${targetName}।

কোনো প্রশ্ন থাকলে owner-এর সাথে যোগাযোগ করুন।`;
}

// ---------- help bot ----------
// A virtual account ("bot") that DMs with every user. It answers common
// how-to questions with simple keyword matching, and — if someone asks to
// talk to the admin/owner — files an "appointment request" that owners can
// see and review (along with the full chat transcript) from the 🤖 panel.
const BOT_KEY = "bot";
const BOT_NAME = "BetaChat Bot";
function botDmCodeFor(userKey) { return "dm_" + [BOT_KEY, userKey].sort().join("_"); }

function ensureBotDm() {
  const code = botDmCodeFor(myKey());
  db.ref("usernames/" + BOT_KEY).once("value").then((snap) => {
    if (!snap.exists()) db.ref("usernames/" + BOT_KEY).set(BOT_NAME);
  });
  db.ref("verified/" + BOT_KEY).once("value").then((snap) => {
    if (!snap.exists()) db.ref("verified/" + BOT_KEY).set(true);
  });
  db.ref("groups/" + code).once("value").then((gsnap) => {
    db.ref("usergroups/" + myKey() + "/" + code).set(true);
    db.ref("botConversations/" + myKey()).set({ name: username, lastTs: Date.now() });
    if (gsnap.exists()) return;
    db.ref("groups/" + code).set({
      name: BOT_NAME,
      isDirect: true,
      isBotChat: true,
      members: { [BOT_KEY]: BOT_NAME, [myKey()]: username },
      createdAt: Date.now(),
      lastActivity: Date.now(),
      lastSender: BOT_NAME
    }).then(() => {
      const welcome = `👋 Hi ${username}! আমি BetaChat Bot — যেকোনো সময় app ব্যবহার নিয়ে প্রশ্ন করতে পারেন (friend, group, story, verified badge, block ইত্যাদি নিয়ে)।

Owner/admin-এর সাথে সরাসরি কথা বলতে চাইলে লিখুন "talk to admin" বা "contact owner" — আমি owner-কে জানিয়ে দেব।`;
      db.ref("messages/" + code).push({ sender: BOT_NAME, ts: Date.now(), text: welcome });
    });
  });
}

function botReplyFor(text) {
  const t = (text || "").toLowerCase();
  const has = (...words) => words.some((w) => t.includes(w));

  const explicitAdminAsk = has(
    "talk to admin", "talk to owner", "contact admin", "contact owner", "appointment",
    "meet owner", "meet admin", "need an admin", "need admin", "want admin", "want an admin",
    "speak to admin", "speak with admin", "admin help", "help from admin", "real person",
    "human please", "talk to a human",
    "স্বত্বাধিকারী", "owner এর সাথে", "admin এর সাথে", "এডমিন দরকার", "এডমিনের সাথে",
    "অ্যাডমিনের সাথে", "মানুষের সাথে কথা"
  );
  // Also catch looser phrasing that mentions admin/owner *and* clearly wants
  // to reach/talk to one, even if it doesn't match an exact phrase above
  // (e.g. "i need an admin to talk").
  const mentionsAdminOrOwner = has("admin", "owner", "অ্যাডমিন", "এডমিন");
  const wantsToReachSomeone = has(
    "talk", "speak", "contact", "reach", "চাই", "দরকার", "লাগবে", "কথা বল", "যোগাযোগ"
  );
  if (explicitAdminAsk || (mentionsAdminOrOwner && wantsToReachSomeone)) {
    // If the person asking is themselves the only Owner/Admin, filing a
    // request and promising "an Admin will contact you" would be a lie —
    // there's no one else to notify. Say so plainly instead of looping.
    if (isSiteAdmin() && !hasOtherAdminToNotify()) {
      return "আপনি নিজেই এই মুহূর্তে একমাত্র Admin/Owner — জানানোর মতো অন্য কোনো Admin নেই। অন্য কাউকে Admin বানালে তারা ভবিষ্যতে এই ধরনের request পাবেন এবং সাহায্য করতে পারবেন।";
    }
    return { isAppointment: true };
  }
  if (has("friend", "বন্ধু")) {
    return "বন্ধু যোগ করতে: তাদের profile-এ গিয়ে বা username দিয়ে খুঁজে 'Add friend' চাপুন। তারা accept করলে friend list-এ চলে আসবে।";
  }
  if (has("group", "গ্রুপ")) {
    return "নতুন group বানাতে '+ New chat' → Create group চাপুন। Existing group-এ join করতে ওই group-এর code দিয়ে join করুন।";
  }
  if (has("story", "স্টোরি")) {
    return "Story দিতে sidebar-এর উপরে 'Add story' আইকনে চাপুন — ছবি/টেক্সট দিতে পারবেন, ২৪ ঘণ্টা পর নিজে থেকে মুছে যাবে।";
  }
  if (has("verified", "verify", "badge", "ভেরিফাই")) {
    return "Verified badge (নীল টিক) শুধু owner দিতে পারেন। এটার জন্য owner/admin-এর সাথে যোগাযোগ করতে চাইলে লিখুন 'talk to admin'।";
  }
  if (has("admin", "অ্যাডমিন")) {
    return "Admin message/story delete করতে পারে এবং সাধারণ user block করতে পারে। শুধু owner নতুন admin বানাতে/সরাতে পারেন। সরাসরি কথা বলতে 'talk to admin' লিখুন।";
  }
  if (has("block", "ব্লক")) {
    return "Block হলে login করা যায় কিন্তু message পাঠানো যায় না। কোনো ভুল বোঝাবুঝি মনে হলে 'talk to admin' লিখে owner-কে জানান।";
  }
  if (has("password", "পাসওয়ার্ড")) {
    return "এখনো password reset ফিচার নেই — ভুলে গেলে নতুন username দিয়ে account বানাতে হবে, অথবা 'talk to admin' লিখে owner-এর সাহায্য নিন।";
  }
  if (has("hi", "hello", "হাই", "হ্যালো")) {
    return "হ্যালো! 👋 friend, group, story, verified, block, বা admin নিয়ে প্রশ্ন করতে পারেন — অথবা 'talk to admin' লিখে সরাসরি owner-কে জানাতে পারেন।";
  }
  // The bot genuinely doesn't know how to answer this one. If there's a real
  // Admin/Owner other than the person asking, offer to hand it off to them;
  // otherwise don't dangle an offer that leads nowhere.
  if (!isSiteAdmin() || hasOtherAdminToNotify()) {
    return {
      isFallback: true,
      text: "দুঃখিত, আমি নিজে থেকে এটার উত্তর দিতে পারছি না। 😕\n\nচাইলে কি প্রশ্নটি সব Admin-কে জানিয়ে দেব, যাতে তারা সরাসরি আপনাকে সাহায্য করতে পারেন? উত্তর দিন 'হ্যাঁ' অথবা 'না'।"
    };
  }
  return "দুঃখিত, আমি নিজে থেকে এটার উত্তর দিতে পারছি না, এবং আপনি ছাড়া এই মুহূর্তে জানানোর মতো অন্য কোনো Admin নেই। 😕";
}

// True if there is at least one Owner/Admin *other* than whoever is
// currently chatting with the bot — i.e. someone who could actually receive
// and act on an escalated help request. Without this check, the only
// Admin/Owner filing a request against themselves would get a confirmation
// promising contact that will never come.
function hasOtherAdminToNotify() {
  const all = new Set(OWNER_USERNAMES.map(keyFor).concat(Object.keys(adminsCache)));
  all.delete(myKey());
  return all.size > 0;
}

// Loose yes/no matching for the bot's "should I tell the Admins?" offer —
// covers common English and Bengali spellings/typos people actually type.
function isAffirmativeReply(text) {
  const s = (text || "").trim().toLowerCase();
  return ["yes", "yeah", "yep", "ok", "okay", "sure", "হ্যাঁ", "হ্যা", "হয়", "জি", "জ্বি", "হুম", "হুঁ"].includes(s);
}
function isNegativeReply(text) {
  const s = (text || "").trim().toLowerCase();
  return ["no", "nah", "nope", "না", "নাহ", "নো"].includes(s);
}

// Holds the question the bot most recently offered to escalate, while it
// waits for the user's yes/no reply. Cleared as soon as it's used (or a
// non-yes/no message moves the conversation on).
let pendingAdminHelpQuestion = null;

function handleBotMessage(userText) {
  const code = botDmCodeFor(myKey());
  db.ref("botConversations/" + myKey()).set({ name: username, lastTs: Date.now() });

  // Resolve a pending "should I tell the Admins?" offer first.
  if (pendingAdminHelpQuestion !== null) {
    const question = pendingAdminHelpQuestion;
    pendingAdminHelpQuestion = null;
    if (isAffirmativeReply(userText)) {
      fileAdminHelpRequest(question, "auto");
      return;
    }
    if (isNegativeReply(userText)) {
      setTimeout(() => {
        db.ref("messages/" + code).push({ sender: BOT_NAME, ts: Date.now(), text: "ঠিক আছে, কোনো সমস্যা নেই। অন্য কিছু জানতে চাইলে বলুন। 🙂" });
        db.ref("groups/" + code + "/lastActivity").set(Date.now());
        db.ref("groups/" + code + "/lastSender").set(BOT_NAME);
      }, 400);
      return;
    }
    // Neither yes nor no — let the offer lapse and handle this as a normal
    // new message below.
  }

  const reply = botReplyFor(userText);

  if (reply && reply.isAppointment) {
    fileAdminHelpRequest(userText, "manual");
    return;
  }

  if (reply && reply.isFallback) {
    askAiBotFallback(userText, code);
    return;
  }

  setTimeout(() => {
    db.ref("messages/" + code).push({ sender: BOT_NAME, ts: Date.now(), text: reply });
    db.ref("groups/" + code + "/lastActivity").set(Date.now());
    db.ref("groups/" + code + "/lastSender").set(BOT_NAME);
  }, 500);
}

// Called when the built-in keyword bot has no direct answer. Tries the
// AI-powered Netlify function first; only falls back to the "should I tell
// an Admin?" offer if the AI also can't help (or isn't configured yet).
function askAiBotFallback(userText, code) {
  firebase.auth().currentUser.getIdToken().then((idToken) => fetch(BOT_AI_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken, question: userText, userName: username }),
  }))
    .then((res) => res.json())
    .then((data) => {
      if (data && data.answer && !data.needsAdmin) {
        db.ref("messages/" + code).push({ sender: BOT_NAME, ts: Date.now(), text: data.answer });
        db.ref("groups/" + code + "/lastActivity").set(Date.now());
        db.ref("groups/" + code + "/lastSender").set(BOT_NAME);
        return;
      }
      offerAdminEscalation(userText, code, data && data.answer);
    })
    .catch(() => offerAdminEscalation(userText, code, null));
}

function offerAdminEscalation(userText, code, aiAnswer) {
  pendingAdminHelpQuestion = userText;
  const text = aiAnswer
    ? `${aiAnswer}\n\nএর বাইরে আরও সাহায্য দরকার হলে কি সব Admin-কে জানিয়ে দেব? উত্তর দিন 'হ্যাঁ' অথবা 'না'।`
    : "দুঃখিত, আমি নিজে থেকে এটার উত্তর দিতে পারছি না। 😕\n\nচাইলে কি প্রশ্নটি সব Admin-কে জানিয়ে দেব, যাতে তারা সরাসরি আপনাকে সাহায্য করতে পারেন? উত্তর দিন 'হ্যাঁ' অথবা 'না'।";
  setTimeout(() => {
    db.ref("messages/" + code).push({ sender: BOT_NAME, ts: Date.now(), text });
    db.ref("groups/" + code + "/lastActivity").set(Date.now());
    db.ref("groups/" + code + "/lastSender").set(BOT_NAME);
  }, 500);
}

// Files a help request under appointments/ and confirms it to the user.
// kind: "manual" (user explicitly asked for an Admin) or "auto" (the bot
// couldn't answer and the user agreed to escalate it).
function fileAdminHelpRequest(userText, kind) {
  const code = botDmCodeFor(myKey());
  db.ref("appointments").push({
    userKey: myKey(), userName: username, message: userText,
    kind: kind || "manual", ts: Date.now(), status: "pending"
  });
  const confirmText = kind === "auto"
    ? `✅ ঠিক আছে ${username}, আপনার প্রশ্নটি সব Admin-কে জানিয়ে দেওয়া হয়েছে। তারা শীঘ্রই সাহায্য করবেন।`
    : `✅ ঠিক আছে ${username}, Admin-দের জানিয়ে দেওয়া হয়েছে। তারা শীঘ্রই আপনার সাথে যোগাযোগ করবেন।`;
  setTimeout(() => {
    db.ref("messages/" + code).push({ sender: BOT_NAME, ts: Date.now(), text: confirmText });
    db.ref("groups/" + code + "/lastActivity").set(Date.now());
    db.ref("groups/" + code + "/lastSender").set(BOT_NAME);
  }, 500);
  notifyAllAdminsOfHelpRequest(userText, kind);
}

// Proactively notify every current Admin *and* Owner (not just the two
// hardcoded owner accounts) in their own bot DM, so nobody has to keep the
// Bot requests panel open just to find out someone needs help.
function notifyAllAdminsOfHelpRequest(userText, kind) {
  db.ref("usernames").once("value").then((snap) => {
    const allNames = snap.val() || {};
    const notifyKeys = new Set(OWNER_USERNAMES.map(keyFor).concat(Object.keys(adminsCache)));
    notifyKeys.forEach((adminKey) => {
      if (adminKey === myKey()) return;
      const adminRawName = allNames[adminKey] || adminKey;
      const adminCode = botDmCodeFor(adminKey);
      const label = kind === "auto" ? "🤖 বট নিজে উত্তর দিতে পারেনি" : "🙋 সরাসরি Admin চেয়েছেন";
      const notice = `${label} — ${username}:\n"${userText}"\n\nOpen the 🤖 Bot requests panel to see the full chat and reply.`;
      db.ref("groups/" + adminCode).once("value").then((adminGSnap) => {
        const finishNotify = () => {
          db.ref("usergroups/" + adminKey + "/" + adminCode).set(true);
          db.ref("messages/" + adminCode).push({ sender: BOT_NAME, ts: Date.now(), text: notice });
          db.ref("groups/" + adminCode + "/lastActivity").set(Date.now());
          db.ref("groups/" + adminCode + "/lastSender").set(BOT_NAME);
          triggerPushNotification(adminCode, BOT_NAME, notice);
        };
        if (adminGSnap.exists()) { finishNotify(); return; }
        db.ref("groups/" + adminCode).set({
          name: BOT_NAME, isDirect: true, isBotChat: true,
          members: { [BOT_KEY]: BOT_NAME, [adminKey]: adminRawName },
          createdAt: Date.now(), lastActivity: Date.now(), lastSender: BOT_NAME
        }).then(finishNotify);
      });
    });
  });
}

// ---------- bot / admin help requests panel (owner & admins) ----------
const botRequestsBtn = el("bot-requests-btn");
const reportsBtn = el("reports-btn");
const reportsBadge = el("reports-badge");
const reportsBackdrop = el("modal-reports-backdrop");
const reportsCloseBtn = el("reports-close-btn");
const reportsList = el("reports-list");
const modalBotRequestsBackdrop = el("modal-botrequests-backdrop");
const botRequestsList = el("botrequests-list");
const botRequestsCloseBtn = el("botrequests-close-btn");

function renderReports() {
  if (!isSiteAdmin()) return; reportsList.innerHTML='<div class="member-row-status">Loading reports…</div>';
  db.ref("reports").orderByChild("ts").once("value").then((snap)=>{const rows=[];snap.forEach(c=>rows.push({id:c.key,...c.val()}));rows.reverse();reportsList.innerHTML="";reportsBadge.classList.toggle("hidden",!rows.some(r=>r.status==="open"));if(!rows.length){reportsList.innerHTML='<div class="member-row-status">No reports yet.</div>';return;}rows.forEach(r=>{const row=document.createElement("div");row.className="report-row";row.innerHTML=`<strong>${escapeHtml(r.targetName||r.targetKey||"User")}</strong><span>Reported by ${escapeHtml(r.reporterName||"user")}</span><p>${escapeHtml(r.reason||"")}</p><small>${timeLabel(r.ts||Date.now())} · ${escapeHtml(r.status||"open")}</small>`;if(r.status==="open"){const btn=document.createElement("button");btn.className="button ghost small";btn.textContent="Mark resolved";btn.addEventListener("click",()=>db.ref("reports/"+r.id).update({status:"resolved",resolvedBy:myKey(),resolvedAt:Date.now()}).then(renderReports));row.appendChild(btn);}reportsList.appendChild(row);});}).catch(()=>reportsList.innerHTML='<div class="member-row-status">Couldn’t load reports.</div>');
}
reportsBtn.addEventListener("click",()=>{renderReports();reportsBackdrop.classList.remove("hidden");});reportsCloseBtn.addEventListener("click",()=>reportsBackdrop.classList.add("hidden"));reportsBackdrop.addEventListener("click",e=>{if(e.target===reportsBackdrop)reportsBackdrop.classList.add("hidden");});

botRequestsBtn.addEventListener("click", () => {
  if (!isSiteAdmin()) return;
  modalBotRequestsBackdrop.classList.remove("hidden");
  renderBotRequestsList();
});
botRequestsCloseBtn.addEventListener("click", () => modalBotRequestsBackdrop.classList.add("hidden"));

// Renders a short "who said what" preview (last few messages) for a bot DM
// straight into the panel, so the Owner/Admins can see what's happened —
// the user's messages, and any Admin's replies — without opening each chat.
function renderConversationPreview(container, dmCode) {
  container.textContent = "Loading conversation…";
  db.ref("messages/" + dmCode).orderByKey().limitToLast(8).once("value").then((snap) => {
    const msgs = [];
    snap.forEach((c) => { const v = c.val(); if (v && v.text) msgs.push(v); });
    if (msgs.length === 0) { container.textContent = "No messages yet."; return; }
    container.innerHTML = "";
    msgs.forEach((m) => {
      const line = document.createElement("div");
      line.className = "botrequest-preview-line";
      line.innerHTML = `<strong>${escapeHtml(m.sender || "?")}:</strong> ${escapeHtml(m.text)}`;
      container.appendChild(line);
    });
  }).catch(() => { container.textContent = "Couldn't load conversation."; });
}

function renderBotRequestsList() {
  if (!isSiteAdmin()) return;
  botRequestsList.innerHTML = `<div class="member-row-status">Loading…</div>`;
  Promise.all([
    db.ref("appointments").orderByChild("ts").once("value"),
    db.ref("botConversations").once("value")
  ]).then(([apptSnap, convSnap]) => {
    const appts = [];
    apptSnap.forEach((c) => { appts.push({ id: c.key, ...c.val() }); });
    appts.reverse(); // newest first
    const convs = convSnap.val() || {};

    botRequestsList.innerHTML = "";
    if (appts.length > 0) {
      const heading = document.createElement("div");
      heading.className = "member-row-status";
      heading.textContent = "Admin help requests";
      botRequestsList.appendChild(heading);
      appts.forEach((a) => {
        const dmCode = botDmCodeFor(a.userKey);
        const kindLabel = a.kind === "auto" ? "🤖 Bot couldn't answer" : "🙋 Asked for Admin";
        const row = document.createElement("div");
        row.className = "manageusers-row";
        row.innerHTML = `
          <div class="manageusers-row-name">${escapeHtml(a.userName || a.userKey)}
            <div class="manageusers-row-tags">
              <span class="manageusers-tag blocked">${a.status === "pending" ? "Pending" : escapeHtml(a.status)}</span>
              <span class="manageusers-tag admin">${escapeHtml(kindLabel)}</span>
            </div>
            <div class="member-row-status">"${escapeHtml(a.message || "")}"</div>
            ${a.status !== "pending" && a.resolvedByName ? `<div class="member-row-status">Handled by ${escapeHtml(a.resolvedByName)}</div>` : ""}
            <div class="botrequest-preview"></div>
          </div>
          <div class="manageusers-row-actions"></div>
        `;
        const preview = row.querySelector(".botrequest-preview");
        const actions = row.querySelector(".manageusers-row-actions");
        const previewBtn = document.createElement("button");
        previewBtn.textContent = "Show conversation";
        previewBtn.addEventListener("click", () => {
          const showing = preview.classList.toggle("shown");
          previewBtn.textContent = showing ? "Hide conversation" : "Show conversation";
          if (showing) renderConversationPreview(preview, dmCode);
        });
        actions.appendChild(previewBtn);
        const openBtn = document.createElement("button");
        openBtn.textContent = "Open chat";
        openBtn.addEventListener("click", () => {
          modalBotRequestsBackdrop.classList.add("hidden");
          openChat(dmCode);
        });
        actions.appendChild(openBtn);
        if (a.status === "pending") {
          const resolveBtn = document.createElement("button");
          resolveBtn.textContent = "Mark resolved";
          resolveBtn.addEventListener("click", () => {
            db.ref("appointments/" + a.id).update({
              status: "resolved", resolvedBy: myKey(), resolvedByName: username, resolvedAt: Date.now()
            });
            renderBotRequestsList();
          });
          actions.appendChild(resolveBtn);
        }
        botRequestsList.appendChild(row);
      });
    }

    const convKeys = Object.keys(convs).sort((x, y) => (convs[y].lastTs || 0) - (convs[x].lastTs || 0));
    const heading2 = document.createElement("div");
    heading2.className = "member-row-status";
    heading2.textContent = "All bot conversations";
    botRequestsList.appendChild(heading2);
    if (convKeys.length === 0) {
      botRequestsList.appendChild(Object.assign(document.createElement("div"), { className: "member-row-status", textContent: "No one has messaged the bot yet." }));
    }
    convKeys.forEach((k) => {
      const row = document.createElement("div");
      row.className = "manageusers-row";
      row.innerHTML = `<div class="manageusers-row-name">${escapeHtml(convs[k].name || k)}</div><div class="manageusers-row-actions"></div>`;
      const actions = row.querySelector(".manageusers-row-actions");
      const openBtn = document.createElement("button");
      openBtn.textContent = "Open chat";
      openBtn.addEventListener("click", () => {
        modalBotRequestsBackdrop.classList.add("hidden");
        openChat(botDmCodeFor(k));
      });
      actions.appendChild(openBtn);
      botRequestsList.appendChild(row);
    });
  });
}


// Data model:
//   friend_requests/{toKey}/{fromKey}   = { fromName, ts }   incoming requests, keyed by recipient
//   sent_requests/{fromKey}/{toKey}     = { toName, ts }     mirror so the sender can see their own pending list
//   friends/{key}/{otherKey}            = { name, since }    written to both sides on accept — a friendship is symmetric
let friendRequestsCache = {}; // key -> { fromName, ts }
let sentRequestsCache = {};   // key -> { toName, ts }
let friendsCache = {};        // key -> { name, since }
let friendsListenersOff = null;

function setupFriendsListeners() {
  if (friendsListenersOff) return; // already set up for this session
  const rref = db.ref("friend_requests/" + myKey());
  const rcb = rref.on("value", (snap) => {
    friendRequestsCache = snap.val() || {};
    updateFriendsBadge();
    renderFriendsLists();
  });
  const sref = db.ref("sent_requests/" + myKey());
  const scb = sref.on("value", (snap) => {
    sentRequestsCache = snap.val() || {};
    renderFriendsLists();
  });
  const fref = db.ref("friends/" + myKey());
  const fcb = fref.on("value", (snap) => {
    friendsCache = snap.val() || {};
    syncFriendsPresenceListeners();
    if (!isOwner()) syncStoriesListeners();
    renderFriendsLists();
  });
  friendsListenersOff = () => {
    rref.off("value", rcb);
    sref.off("value", scb);
    fref.off("value", fcb);
    teardownFriendsPresenceListeners();
  };
}

// Everyone (owner, admin, or otherwise) can see their own friends' online
// status — the presence rule allows reading a friend's presence for exactly
// this reason. Kept in sync with friendsCache: one small live listener per
// friend, added/removed as the friends list changes.
let friendsPresenceCache = {}; // friendKey -> presence value
let friendsPresenceListeners = {}; // friendKey -> off()

function syncFriendsPresenceListeners() {
  const wanted = new Set(Object.keys(friendsCache));
  Object.keys(friendsPresenceListeners).forEach((key) => {
    if (!wanted.has(key)) {
      friendsPresenceListeners[key]();
      delete friendsPresenceListeners[key];
      delete friendsPresenceCache[key];
    }
  });
  wanted.forEach((key) => {
    if (friendsPresenceListeners[key]) return;
    const pref = db.ref("presence/" + key);
    const cb = pref.on("value", (snap) => {
      friendsPresenceCache[key] = snap.val();
      renderFriendsLists();
    });
    friendsPresenceListeners[key] = () => pref.off("value", cb);
  });
}
function teardownFriendsPresenceListeners() {
  Object.values(friendsPresenceListeners).forEach((off) => off());
  friendsPresenceListeners = {};
  friendsPresenceCache = {};
}

function updateFriendsBadge() {
  const count = Object.keys(friendRequestsCache).length;
  friendsBadge.classList.toggle("hidden", count === 0);
}

friendsBtn.addEventListener("click", () => {
  friendAddError.textContent = "";
  friendAddInput.value = "";
  switchFriendsTab("requests");
  renderFriendsLists();
  friendsModalBackdrop.classList.remove("hidden");
});
friendsCloseBtn.addEventListener("click", () => friendsModalBackdrop.classList.add("hidden"));
friendsTabRequests.addEventListener("click", () => switchFriendsTab("requests"));
friendsTabList.addEventListener("click", () => switchFriendsTab("list"));

function switchFriendsTab(mode) {
  friendsTabRequests.classList.toggle("active", mode === "requests");
  friendsTabList.classList.toggle("active", mode === "list");
  friendsPaneRequests.classList.toggle("hidden", mode !== "requests");
  friendsPaneList.classList.toggle("hidden", mode !== "list");
}

friendAddBtn.addEventListener("click", sendFriendRequest);
friendAddInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendFriendRequest(); });

function sendFriendRequest() {
  const target = friendAddInput.value.trim();
  friendAddError.textContent = "";
  if (!target) { friendAddError.textContent = "Enter a username."; return; }
  if (target.toLowerCase() === username.toLowerCase()) { friendAddError.textContent = "That's you."; return; }
  const targetKey = keyFor(target);

  if (friendsCache[targetKey]) { friendAddError.textContent = "You're already friends."; return; }
  if (sentRequestsCache[targetKey]) { friendAddError.textContent = "You already sent them a request."; return; }
  if (friendRequestsCache[targetKey]) { friendAddError.textContent = "They already sent you a request — check the Requests tab."; return; }

  db.ref("usernames/" + targetKey).once("value").then((snap) => {
    if (!snap.exists()) { friendAddError.textContent = "No user found with that username."; return; }
    const targetName = typeof snap.val() === "string" ? snap.val() : target;
    const ts = Date.now();
    db.ref("friend_requests/" + targetKey + "/" + myKey()).set({ fromName: username, ts })
      .then(() => db.ref("sent_requests/" + myKey() + "/" + targetKey).set({ toName: targetName, ts }))
      .then(() => { friendAddInput.value = ""; });
  }).catch(() => { friendAddError.textContent = "Couldn't send that — try again."; });
}

function acceptFriendRequest(fromKey, fromName) {
  const since = Date.now();
  db.ref("friends/" + myKey() + "/" + fromKey).set({ name: fromName, since });
  db.ref("friends/" + fromKey + "/" + myKey()).set({ name: username, since });
  db.ref("friend_requests/" + myKey() + "/" + fromKey).remove();
  db.ref("sent_requests/" + fromKey + "/" + myKey()).remove();
}
function declineFriendRequest(fromKey) {
  db.ref("friend_requests/" + myKey() + "/" + fromKey).remove();
  db.ref("sent_requests/" + fromKey + "/" + myKey()).remove();
}
function cancelSentRequest(toKey) {
  db.ref("sent_requests/" + myKey() + "/" + toKey).remove();
  db.ref("friend_requests/" + toKey + "/" + myKey()).remove();
}
function removeFriend(otherKey, otherName) {
  appConfirm("Remove friend?", `Remove ${otherName} from your friends list?`, "Remove").then((ok) => { if (!ok) return;
    db.ref("friends/" + myKey() + "/" + otherKey).remove();
    db.ref("friends/" + otherKey + "/" + myKey()).remove();
    showToast("Friend removed", "success");
  });
}

function renderFriendsLists() {
  // incoming requests
  const incomingKeys = Object.keys(friendRequestsCache);
  friendRequestsListEl.innerHTML = incomingKeys.length === 0
    ? `<div class="friend-row-empty">No pending requests.</div>`
    : "";
  incomingKeys.forEach((key) => {
    const req = friendRequestsCache[key];
    const p = profileFor(key, req.fromName);
    const row = document.createElement("div");
    row.className = "member-row";
    row.innerHTML = `
      <div class="avatar small" style="background:${p.avatar ? "transparent" : p.color}">${avatarInnerHtml(key, req.fromName)}</div>
      <div class="member-row-text"><div class="member-row-name">${escapeHtml(p.name)}</div></div>
      <div class="friend-row-actions">
        <button class="accept-btn">Accept</button>
        <button class="decline-btn">Decline</button>
      </div>
    `;
    row.querySelector(".accept-btn").addEventListener("click", () => acceptFriendRequest(key, req.fromName));
    row.querySelector(".decline-btn").addEventListener("click", () => declineFriendRequest(key));
    friendRequestsListEl.appendChild(row);
  });

  // sent requests
  const sentKeys = Object.keys(sentRequestsCache);
  friendSentListEl.innerHTML = sentKeys.length === 0
    ? `<div class="friend-row-empty">Nothing pending.</div>`
    : "";
  sentKeys.forEach((key) => {
    const req = sentRequestsCache[key];
    const p = profileFor(key, req.toName);
    const row = document.createElement("div");
    row.className = "member-row";
    row.innerHTML = `
      <div class="avatar small" style="background:${p.avatar ? "transparent" : p.color}">${avatarInnerHtml(key, req.toName)}</div>
      <div class="member-row-text"><div class="member-row-name">${escapeHtml(p.name)}</div></div>
      <div class="friend-row-actions"><button class="cancel-btn">Cancel</button></div>
    `;
    row.querySelector(".cancel-btn").addEventListener("click", () => cancelSentRequest(key));
    friendSentListEl.appendChild(row);
  });

  // friends
  const friendKeys = Object.keys(friendsCache);
  friendsListEl.innerHTML = friendKeys.length === 0
    ? `<div class="friend-row-empty">No friends yet — add someone by username above.</div>`
    : "";
  friendKeys.forEach((key) => {
    const f = friendsCache[key];
    const p = friendsPresenceCache[key];
    const online = p && p.state === "online";
    const p_ = profileFor(key, f.name);
    const row = document.createElement("div");
    row.className = "member-row clickable-row";
    row.innerHTML = `
      <div class="avatar small" style="background:${p_.avatar ? "transparent" : p_.color}">${avatarInnerHtml(key, f.name)}</div>
      <div class="member-row-text">
        <div class="member-row-name">${escapeHtml(p_.name)}</div>
        <div class="member-row-status"><span class="presence-dot ${online ? "online" : ""}"></span>${escapeHtml(presenceLabel(p) || "offline")}</div>
      </div>
      <div class="friend-row-actions">
        <button class="message-btn">Message</button>
        <button class="remove-btn">Remove</button>
      </div>
    `;
    row.addEventListener("click", (e) => {
      if (e.target.closest(".friend-row-actions")) return;
      friendsModalBackdrop.classList.add("hidden");
      openProfileView(key, f.name);
    });
    row.querySelector(".message-btn").addEventListener("click", () => {
      friendsModalBackdrop.classList.add("hidden");
      openOrCreateDm(key, f.name);
    });
    row.querySelector(".remove-btn").addEventListener("click", () => removeFriend(key, p_.name));
    friendsListEl.appendChild(row);
  });
}

// ---------- stories (24hr disappearing photo/text updates) ----------
// Data model:
//   stories/{authorKey}/{storyId} = {
//     authorName, ts, expiresAt, type: 'photo'|'text',
//     image?, text?, bg?, viewers: { key: true }
//   }
const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const STORY_COLORS = [
  "linear-gradient(135deg,#2FA98C,#3E8FD1)",
  "linear-gradient(135deg,#E2897D,#C2483B)",
  "linear-gradient(135deg,#8E6FD1,#3E8FD1)",
  "linear-gradient(135deg,#E0B23E,#E2897D)",
  "linear-gradient(135deg,#4FBFA0,#2FA98C)"
];
let storiesCache = {}; // authorKey -> { storyId: story }
let storiesListeners = {}; // authorKey -> off()
let pendingStoryBgIndex = 0;

// The stories/ rule only grants access per exact author key (self, owner,
// or a friend of that author) — it doesn't grant a broad "read every
// author's stories in one query" the way a top-level .read would. So
// instead of one listener on stories/ as a whole, we keep one small
// listener per author we're actually allowed to read: always ourselves,
// plus — depending on who's asking — either everyone (owner) or just our
// friends. Kept in sync as profilesCache/friendsCache change.
function setupStoriesListener() {
  cleanupExpiredStories();
  syncStoriesListeners();
}

function storiesCandidateKeys() {
  // profilesCache already holds every user's public profile regardless of
  // role, so it doubles as the "everyone" directory for the owner without
  // needing a separate fetch.
  return isOwner() ? Object.keys(profilesCache) : Object.keys(friendsCache);
}

function syncStoriesListeners() {
  const wanted = new Set([myKey(), ...storiesCandidateKeys()]);
  Object.keys(storiesListeners).forEach((key) => {
    if (!wanted.has(key)) {
      storiesListeners[key]();
      delete storiesListeners[key];
      delete storiesCache[key];
    }
  });
  wanted.forEach((key) => {
    if (storiesListeners[key]) return;
    const ref = db.ref("stories/" + key);
    const cb = ref.on("value", (snap) => {
      if (snap.exists()) storiesCache[key] = snap.val();
      else delete storiesCache[key];
      renderStoriesBar();
    });
    storiesListeners[key] = () => ref.off("value", cb);
  });
}
function teardownStoriesListeners() {
  Object.values(storiesListeners).forEach((off) => off());
  storiesListeners = {};
  storiesCache = {};
}

// Best-effort tidy-up: there's no server-side TTL on the free plan, so each
// client prunes its own expired stories on load (we can only write to our
// own path anyway). Other people's expired stories are simply filtered out
// client-side by activeStoriesFor() and never shown.
function cleanupExpiredStories() {
  const ref = db.ref("stories/" + myKey());
  ref.once("value").then((snap) => {
    const node = snap.val() || {};
    const now = Date.now();
    Object.keys(node).forEach((id) => {
      if ((node[id].expiresAt || 0) <= now) {
        ref.child(id).remove();
        db.ref(`storyReactions/${myKey()}/${id}`).remove();
      }
    });
  });
}

function activeStoriesFor(key) {
  const node = storiesCache[key] || {};
  const now = Date.now();
  return Object.keys(node)
    .map((id) => Object.assign({ id }, node[id]))
    .filter((s) => (s.expiresAt || 0) > now)
    .sort((a, b) => a.ts - b.ts);
}

function hasUnseenStories(key) {
  return activeStoriesFor(key).some((s) => !(s.viewers && s.viewers[myKey()]));
}

function renderStoriesBar() {
  storiesBar.innerHTML = "";

  // "Your story" circle
  const mine = activeStoriesFor(myKey());
  const myItem = document.createElement("div");
  myItem.className = "story-item";
  const myP = profileFor(myKey(), username);
  myItem.innerHTML = `
    <div class="story-ring ${mine.length ? "unseen" : ""}">
      <div class="story-add-badge">
        <div class="avatar" style="background:${myP.avatar ? "transparent" : myP.color}">${avatarInnerHtml(myKey(), username)}</div>
        <div class="story-add-plus">+</div>
      </div>
    </div>
    <div class="story-item-label">${mine.length ? "Your story" : "Add story"}</div>
  `;
  myItem.addEventListener("click", () => {
    if (mine.length) openStoryViewer(myKey(), 0);
    else openAddStoryChoice();
  });
  storiesBar.appendChild(myItem);

  // Other people's stories, most recently updated first. Which authors show
  // up here isn't decided in this code — it's whatever storiesCache actually
  // contains, and the stories/ security rule only lets that fill up with:
  // your own (already handled above), the owner's (sees everyone), or a
  // regular/admin account's friends. So this list is automatically the
  // right scope for whoever's looking at it.
  const otherKeys = Object.keys(storiesCache)
    .filter((k) => k !== myKey() && activeStoriesFor(k).length > 0)
    .sort((a, b) => {
      const la = activeStoriesFor(a).slice(-1)[0].ts;
      const lb = activeStoriesFor(b).slice(-1)[0].ts;
      return lb - la;
    });

  otherKeys.forEach((key) => {
    if (key !== myKey()) {
    const reportBtn = document.createElement("button"); reportBtn.className = "link-btn profile-report-btn"; reportBtn.textContent = "Report user";
    reportBtn.addEventListener("click", () => { reportUserLabel.textContent = "Reporting " + p.name; reportReasonInput.value=""; reportError.textContent=""; reportBackdrop.dataset.key=key; reportBackdrop.dataset.name=p.name; reportBackdrop.classList.remove("hidden"); reportReasonInput.focus(); });
    profileviewActions.appendChild(reportBtn);
  }

  const stories = activeStoriesFor(key);
    const fallbackName = (friendsCache[key] && friendsCache[key].name) || key;
    const p = profileFor(key, fallbackName);
    const unseen = hasUnseenStories(key);
    const item = document.createElement("div");
    item.className = "story-item";
    item.innerHTML = `
      <div class="story-ring ${unseen ? "unseen" : ""}">
        <div class="avatar" style="background:${p.avatar ? "transparent" : p.color}">${avatarInnerHtml(key, p.name)}</div>
      </div>
      <div class="story-item-label">${escapeHtml(p.name)}</div>
    `;
    item.addEventListener("click", () => openStoryViewer(key, 0));
    storiesBar.appendChild(item);
  });
}

// ---- posting a story ----
function openAddStoryChoice() {
  modalAddStoryBackdrop.classList.remove("hidden");
}
storyAddCancelBtn.addEventListener("click", () => modalAddStoryBackdrop.classList.add("hidden"));
storyAddPhotoBtn.addEventListener("click", () => {
  modalAddStoryBackdrop.classList.add("hidden");
  storyPhotoInput.click();
});
storyPhotoInput.addEventListener("change", () => {
  const file = storyPhotoInput.files && storyPhotoInput.files[0];
  storyPhotoInput.value = "";
  if (!file) return;
  if (!file.type.startsWith("image/")) { window.alert("Please choose an image file."); return; }
  resizeFitDataUrl(file, 900, 0.7)
    .then((dataUrl) => {
      if (dataUrl.length > 700000) { window.alert("That photo is too large — try a smaller image."); return; }
      postStory({ type: "photo", image: dataUrl });
    })
    .catch(() => window.alert("Couldn't read that image — try another one."));
});

storyAddTextBtn.addEventListener("click", () => {
  modalAddStoryBackdrop.classList.add("hidden");
  textStoryInput.value = "";
  textStoryError.textContent = "";
  pendingStoryBgIndex = 0;
  buildTextStoryColorSwatches();
  applyTextStoryBg();
  modalTextStoryBackdrop.classList.remove("hidden");
  textStoryInput.focus();
});
textStoryCancelBtn.addEventListener("click", () => modalTextStoryBackdrop.classList.add("hidden"));

function buildTextStoryColorSwatches() {
  textStoryColors.innerHTML = "";
  STORY_COLORS.forEach((grad, i) => {
    const sw = document.createElement("div");
    sw.className = "textstory-swatch" + (i === pendingStoryBgIndex ? " active" : "");
    sw.style.background = grad;
    sw.addEventListener("click", () => {
      pendingStoryBgIndex = i;
      buildTextStoryColorSwatches();
      applyTextStoryBg();
    });
    textStoryColors.appendChild(sw);
  });
}
function applyTextStoryBg() {
  textStoryPreview.style.background = STORY_COLORS[pendingStoryBgIndex];
}

textStoryPostBtn.addEventListener("click", () => {
  const text = textStoryInput.value.trim();
  textStoryError.textContent = "";
  if (!text) { textStoryError.textContent = "Write something first."; return; }
  if (text.length > 180) { textStoryError.textContent = "Keep it under 180 characters."; return; }
  modalTextStoryBackdrop.classList.add("hidden");
  postStory({ type: "text", text, bg: pendingStoryBgIndex });
});

function postStory(extra) {
  const ts = Date.now();
  const story = Object.assign({
    authorName: username,
    ts,
    expiresAt: ts + STORY_LIFETIME_MS,
    viewers: {}
  }, extra);
  db.ref("stories/" + myKey()).push(story);
}

// ---- viewing stories ----
let storyViewerQueue = [];
let storyViewerKey = null;
let storyViewerIndex = 0;
let storyViewerTimer = null;
let storyReactionsListenerOff = null;
const STORY_DURATION_MS = 5000;
const STORY_REACTION_EMOJIS = ["❤️", "😂", "😮", "😢", "👍", "🔥"];

function openStoryViewer(key, startIndex) {
  storyViewerQueue = activeStoriesFor(key);
  if (storyViewerQueue.length === 0) return;
  storyViewerKey = key;
  storyViewerIndex = Math.min(startIndex || 0, storyViewerQueue.length - 1);
  storyViewer.classList.remove("hidden");
  renderStoryProgressBars();
  showCurrentStory();
}

function closeStoryViewer() {
  clearTimeout(storyViewerTimer);
  if (storyReactionsListenerOff) { storyReactionsListenerOff(); storyReactionsListenerOff = null; }
  storyViewer.classList.add("hidden");
  storyViewerContent.innerHTML = "";
  storyViewerQueue = [];
  storyViewerKey = null;
}
storyViewerClose.addEventListener("click", closeStoryViewer);
document.addEventListener("keydown", (e) => {
  if (storyViewer.classList.contains("hidden")) return;
  if (e.key === "Escape") closeStoryViewer();
  if (e.key === "ArrowRight") nextStory();
  if (e.key === "ArrowLeft") prevStory();
});

function renderStoryProgressBars() {
  storyProgressBars.innerHTML = "";
  storyViewerQueue.forEach((_, i) => {
    const track = document.createElement("div");
    track.className = "story-progress-track";
    track.innerHTML = `<div class="story-progress-fill${i < storyViewerIndex ? " done" : ""}"></div>`;
    storyProgressBars.appendChild(track);
  });
}

function showCurrentStory() {
  clearTimeout(storyViewerTimer);
  const story = storyViewerQueue[storyViewerIndex];
  if (!story) { closeStoryViewer(); return; }

  const p = profileFor(storyViewerKey, story.authorName);
  paintAvatar(storyViewerAvatar, storyViewerKey, story.authorName);
  storyViewerName.innerHTML = escapeHtml(p.name) + verifiedBadgeHtml(storyViewerKey);
  storyViewerTime.textContent = timeLabel(story.ts);

  storyViewerContent.innerHTML = story.type === "photo"
    ? `<img src="${story.image}" alt="" />`
    : `<div class="story-viewer-textcard" style="background:${STORY_COLORS[story.bg || 0]}"><div>${escapeHtml(story.text || "")}</div></div>`;

  // fill bars up to current, animate current
  const tracks = storyProgressBars.querySelectorAll(".story-progress-track");
  tracks.forEach((t, i) => {
    const fill = t.querySelector(".story-progress-fill");
    fill.style.transition = "none";
    fill.classList.toggle("done", i < storyViewerIndex);
    fill.style.width = i < storyViewerIndex ? "100%" : "0%";
  });
  const currentFill = tracks[storyViewerIndex] && tracks[storyViewerIndex].querySelector(".story-progress-fill");
  if (currentFill) {
    requestAnimationFrame(() => {
      currentFill.style.transition = `width ${STORY_DURATION_MS}ms linear`;
      currentFill.style.width = "100%";
    });
  }

  const isMine = storyViewerKey === myKey();
  const canManage = isMine || isSiteAdmin();
  storyViewerFooter.classList.remove("hidden");
  storyDeleteBtn.classList.toggle("hidden", !canManage);
  storyReplyBtn.classList.toggle("hidden", isMine);
  if (canManage) {
    const viewerCount = story.viewers ? Object.keys(story.viewers).length : 0;
    storyViewersCount.textContent = isMine ? `👁 ${viewerCount} view${viewerCount !== 1 ? "s" : ""}` : "";
    storyDeleteBtn.onclick = () => deleteStory(storyViewerKey, story.id);
  } else {
    storyViewersCount.textContent = "";
  }
  if (!isMine) {
    db.ref(`stories/${storyViewerKey}/${story.id}/viewers/${myKey()}`).set(true);
  }
  renderStoryReactionBar(storyViewerKey, story, isMine);

  storyViewerTimer = setTimeout(nextStory, STORY_DURATION_MS);
}

// Live reaction bar for the currently-shown story: story owners see a
// read-only summary of who reacted with what; everyone else (friends) gets
// a tappable emoji row — tap again to remove your reaction, tap a different
// emoji to change it. One reaction per person per story.
function renderStoryReactionBar(authorKey, story, isMine) {
  if (storyReactionsListenerOff) { storyReactionsListenerOff(); storyReactionsListenerOff = null; }
  const ref = db.ref(`storyReactions/${authorKey}/${story.id}`);
  const cb = (snap) => {
    // Guard against a stale listener updating the bar after the viewer moved on.
    if (storyViewerQueue[storyViewerIndex] !== story) return;
    const reactions = snap.val() || {};
    storyReactionBar.innerHTML = "";
    if (isMine) {
      const counts = {};
      Object.values(reactions).forEach((r) => {
        if (r && r.emoji) counts[r.emoji] = (counts[r.emoji] || 0) + 1;
      });
      const emojis = Object.keys(counts);
      if (emojis.length === 0) {
        storyReactionBar.innerHTML = `<div class="story-reaction-summary"><span class="story-reaction-pill">No reactions yet</span></div>`;
        return;
      }
      const namesFor = (emoji) => Object.values(reactions)
        .filter((r) => r && r.emoji === emoji)
        .map((r) => r.name || "").filter(Boolean).join(", ");
      const summary = document.createElement("div");
      summary.className = "story-reaction-summary";
      emojis.forEach((emoji) => {
        const pill = document.createElement("span");
        pill.className = "story-reaction-pill";
        pill.textContent = `${emoji} ${counts[emoji]}`;
        pill.title = namesFor(emoji);
        summary.appendChild(pill);
      });
      storyReactionBar.appendChild(summary);
      return;
    }
    const myReaction = reactions[myKey()] && reactions[myKey()].emoji;
    STORY_REACTION_EMOJIS.forEach((emoji) => {
      const btn = document.createElement("button");
      btn.textContent = emoji;
      btn.className = emoji === myReaction ? "active" : "";
      btn.addEventListener("click", () => reactToStory(authorKey, story.id, emoji));
      storyReactionBar.appendChild(btn);
    });
  };
  ref.on("value", cb);
  storyReactionsListenerOff = () => ref.off("value", cb);
}

function reactToStory(authorKey, storyId, emoji) {
  const ref = db.ref(`storyReactions/${authorKey}/${storyId}/${myKey()}`);
  ref.once("value").then((snap) => {
    const cur = snap.val();
    if (cur && cur.emoji === emoji) ref.remove();
    else ref.set({ emoji, name: username, ts: Date.now() });
  });
}

storyReplyBtn.addEventListener("click", () => {
  const story = storyViewerQueue[storyViewerIndex]; if (!story || !storyViewerKey || storyViewerKey === myKey()) return;
  const text = window.prompt("Reply to " + profileFor(storyViewerKey, story.authorName).name + "’s story:");
  if (!text || !text.trim()) return;
  const authorName = profileFor(storyViewerKey, story.authorName).name;
  const reply = "↩ Story reply: " + text.trim();
  const dmCode = "dm_" + [myKey(), storyViewerKey].sort().join("_");
  openOrCreateDm(storyViewerKey, authorName).then(() => {
    db.ref("messages/" + dmCode).push({ sender: username, ts: Date.now(), text: reply });
    db.ref("groups/" + dmCode).update({lastActivity:Date.now(),lastSender:username});
    triggerPushNotification(dmCode, username, reply);
  });
});

function nextStory() {
  if (storyViewerIndex < storyViewerQueue.length - 1) {
    storyViewerIndex++;
    showCurrentStory();
  } else {
    closeStoryViewer();
  }
}
function prevStory() {
  if (storyViewerIndex > 0) {
    storyViewerIndex--;
    showCurrentStory();
  } else {
    closeStoryViewer();
  }
}
storyNavNext.addEventListener("click", nextStory);
storyNavPrev.addEventListener("click", prevStory);

function deleteStory(authorKey, storyId) {
  appConfirm("Delete story?", "This story and its reactions will be removed.", "Delete").then((ok) => { if (!ok) return;
    db.ref(`stories/${authorKey}/${storyId}`).remove();
    db.ref(`storyReactions/${authorKey}/${storyId}`).remove();
    closeStoryViewer(); showToast("Story deleted", "success");
  });
}

// ---------- profile pages (view someone's profile) ----------
function openProfileView(key, fallbackName) {
  const p = profileFor(key, fallbackName);
  paintAvatar(profileviewAvatar, key, fallbackName);
  profileviewName.innerHTML = escapeHtml(p.name) + verifiedBadgeHtml(key);
  profileviewUsername.textContent = "@" + key;
  profileviewStatus.textContent = p.status || "";
  profileviewStatus.classList.toggle("hidden", !p.status);
  profileviewBio.textContent = p.bio || "";
  profileviewBio.classList.toggle("hidden", !p.bio);

  db.ref("friends/" + key).once("value").then((snap) => {
    const count = snap.exists() ? Object.keys(snap.val()).length : 0;
    profileviewFriendsCount.textContent = count;
  });

  profileviewActions.innerHTML = "";
  if (key !== myKey()) {
    const msgBtn = document.createElement("button");
    msgBtn.className = "button";
    msgBtn.textContent = "Message";
    msgBtn.addEventListener("click", () => {
      modalProfileViewBackdrop.classList.add("hidden");
      openOrCreateDm(key, p.name);
    });
    profileviewActions.appendChild(msgBtn);

    if (canBlock(myKey(), key)) {
      const blocked = isBlocked(key);
      const moderationBtn = document.createElement("button"); moderationBtn.className = blocked ? "button ghost" : "button profile-block-btn"; moderationBtn.textContent = blocked ? "Unblock" : "Block";
      moderationBtn.addEventListener("click", () => { const label = blocked ? "Unblock" : "Block"; appConfirm(label + " " + p.name + "?", blocked ? "They will be able to send messages again." : "They will no longer be able to send messages.", label).then((ok) => { if (!ok) return; setBlocked(key, !blocked, ""); modalProfileViewBackdrop.classList.add("hidden"); showToast(blocked ? "User unblocked" : "User blocked", "success"); }); });
      profileviewActions.appendChild(moderationBtn);
    }

    if (!friendsCache[key] && !sentRequestsCache[key] && !friendRequestsCache[key]) {
      const addBtn = document.createElement("button");
      addBtn.className = "button ghost";
      addBtn.textContent = "Add friend";
      addBtn.addEventListener("click", () => {
        friendAddInput.value = p.name;
        sendFriendRequest();
        openProfileView(key, fallbackName);
      });
      profileviewActions.appendChild(addBtn);
    } else if (friendsCache[key]) {
      const tag = document.createElement("div");
      tag.className = "profile-view-status";
      tag.textContent = "✓ Friends";
      profileviewActions.appendChild(tag);
    }
  }

  if (key !== myKey()) {
    const reportBtn = document.createElement("button"); reportBtn.className = "link-btn profile-report-btn"; reportBtn.textContent = "Report user";
    reportBtn.addEventListener("click", () => { reportUserLabel.textContent = "Reporting " + p.name; reportReasonInput.value=""; reportError.textContent=""; reportBackdrop.dataset.key=key; reportBackdrop.dataset.name=p.name; reportBackdrop.classList.remove("hidden"); reportReasonInput.focus(); });
    profileviewActions.appendChild(reportBtn);
  }

  const stories = activeStoriesFor(key);
  profileviewGridTitle.classList.toggle("hidden", stories.length === 0);
  profileviewGrid.innerHTML = "";
  if (stories.length === 0) {
    const empty = document.createElement("div");
    empty.className = "profile-view-grid-empty";
    empty.textContent = "No active stories right now.";
    profileviewGrid.appendChild(empty);
  } else {
    stories.forEach((s) => {
      const cell = document.createElement("div");
      cell.className = "profile-view-grid-item";
      cell.innerHTML = s.type === "photo"
        ? `<img src="${s.image}" alt="" />`
        : `<div class="profile-view-grid-textcard" style="background:${STORY_COLORS[s.bg || 0]}">${escapeHtml((s.text || "").slice(0, 40))}</div>`;
      cell.addEventListener("click", () => {
        modalProfileViewBackdrop.classList.add("hidden");
        openStoryViewer(key, activeStoriesFor(key).findIndex((x) => x.id === s.id));
      });
      profileviewGrid.appendChild(cell);
    });
  }

  modalProfileViewBackdrop.classList.remove("hidden");
}
function closeReportModal(){reportBackdrop.classList.add("hidden");}
reportCloseBtn.addEventListener("click",closeReportModal);reportBackdrop.addEventListener("click",e=>{if(e.target===reportBackdrop)closeReportModal();});
reportSendBtn.addEventListener("click",()=>{const reason=reportReasonInput.value.trim(),key=reportBackdrop.dataset.key,name=reportBackdrop.dataset.name;if(!reason){reportError.textContent="Please add a reason.";return;}reportSendBtn.disabled=true;db.ref("reports").push({reporterKey:myKey(),reporterName:username,targetKey:key,targetName:name,reason:reason.slice(0,300),ts:Date.now(),status:"open"}).then(()=>{closeReportModal();showToast("Report sent to moderators.","success");}).catch(()=>{reportError.textContent="Couldn’t send your report. Try again.";}).finally(()=>reportSendBtn.disabled=false);});

profileviewCloseBtn.addEventListener("click", () => modalProfileViewBackdrop.classList.add("hidden"));

// ---------- active chat ----------
let typingListenerOff = null;
let presenceListenerOff = null;
let readsListenerOff = null;
let reactionsListenerOff = null;
let reactionsCache = {}; // msgId -> { emoji: { userKey: true } }
let typingTimeout = null;
let otherReads = {}; // key -> last read ts, for the currently open chat

function otherMemberKeys(g) {
  return g && g.members ? Object.keys(g.members).filter((k) => k !== myKey()) : [];
}

// ---------- message search ----------
let searchQuery = "";
searchBtn.addEventListener("click", () => {
  searchBar.classList.toggle("hidden");
  if (!searchBar.classList.contains("hidden")) {
    searchInput.focus();
  } else {
    searchInput.value = "";
    searchQuery = "";
    renderMessages(lastRenderedMsgs);
  }
});
searchCloseBtn.addEventListener("click", () => {
  searchBar.classList.add("hidden");
  searchInput.value = "";
  searchQuery = "";
  renderMessages(lastRenderedMsgs);
});
searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value.trim().toLowerCase();
  renderMessages(lastRenderedMsgs);
});

function draftStorageKey(code) { return "betachat-draft-" + myKey() + "-" + code; }
function saveDraft() { if (activeChatCode) localStorage.setItem(draftStorageKey(activeChatCode), draftInput.value); }
function restoreDraft(code) { draftInput.value = localStorage.getItem(draftStorageKey(code)) || ""; draftCount.textContent = draftInput.value.length + " / 5000"; draftCount.classList.toggle("hidden", draftInput.value.length < 4000); }

function openChat(code) {
  activeChatCode = code;
  searchQuery = "";
  searchInput.value = "";
  searchBar.classList.add("hidden");
  emptyState.classList.add("hidden");
  chatView.classList.remove("hidden");
  messagesEl.innerHTML = ""; // don't show the previous chat's messages while the new ones load
  document.getElementById("sidebar").classList.add("hide-mobile");
  backBtn.classList.add("show-mobile");
  clearReplyPreview();
  restoreDraft(code);
  applyWallpaper(code);
  renderChatList();
  listenToMessages(code);
  markRead(code);
}

backBtn.addEventListener("click", () => {
  activeChatCode = null;
  chatView.classList.add("hidden");
  emptyState.classList.remove("hidden");
  document.getElementById("sidebar").classList.remove("hide-mobile");
  cleanupChatListeners();
  renderChatList();
});

function cleanupChatListeners() {
  if (messagesListener) { messagesListener(); messagesListener = null; }
  if (typingListenerOff) { typingListenerOff(); typingListenerOff = null; }
  if (presenceListenerOff) { presenceListenerOff(); presenceListenerOff = null; }
  if (readsListenerOff) { readsListenerOff(); readsListenerOff = null; }
  if (reactionsListenerOff) { reactionsListenerOff(); reactionsListenerOff = null; }
  if (disappearingSweepTimer) { clearTimeout(disappearingSweepTimer); disappearingSweepTimer = null; }
  reactionsCache = {};
}

function markRead(code) {
  db.ref("reads/" + code + "/" + myKey()).set(firebase.database.ServerValue.TIMESTAMP);
}

function refreshComposerBlockedState() {
  const blocked = isBlocked(myKey());
  const reason = blockReasonFor(myKey());
  draftInput.disabled = blocked;
  sendBtn.disabled = blocked;
  draftInput.placeholder = blocked
    ? ("You've been blocked" + (reason ? ": " + reason : " from sending messages"))
    : "Message";
}

function refreshChatHeader() {
  const g = currentGroupsCache[activeChatCode];
  if (!g) return;
  refreshComposerBlockedState();
  if (g.isDirect) {
    const otherKey = otherMemberKeys(g)[0];
    const fallback = (otherKey && g.members && g.members[otherKey]) || g.name;
    const p = profileFor(otherKey || g.name, fallback);
    chatNameEl.innerHTML = escapeHtml(p.name) + verifiedBadgeHtml(otherKey || g.name);
    paintAvatar(avatarChat, otherKey || g.name, fallback);
    avatarChat.classList.add("clickable");
    avatarChat.title = "View profile";
    chatNameEl.classList.add("clickable");
  } else {
    chatNameEl.textContent = g.name;
    chatNameEl.classList.remove("clickable");
    if (g.photo) {
      avatarChat.style.background = "transparent";
      avatarChat.innerHTML = `<img src="${g.photo}" class="avatar-img" alt="" />`;
    } else {
      avatarChat.style.background = colorFromName(g.name);
      avatarChat.innerHTML = "";
      avatarChat.textContent = initials(g.name);
    }
    avatarChat.classList.add("clickable");
    avatarChat.title = "Change group photo";
  }
}

// ---------- sidebar overflow menu (consolidated: profile, friends, admin tools, theme, notifications, sign out) ----------
const sidebarMenuBtn = el("sidebar-menu-btn");
const sidebarMenuBackdrop = el("modal-sidebar-menu-backdrop");
const sidebarMenuCloseBtn = el("sidebar-menu-close-btn");

sidebarMenuBtn.addEventListener("click", () => sidebarMenuBackdrop.classList.remove("hidden"));
sidebarMenuCloseBtn.addEventListener("click", () => sidebarMenuBackdrop.classList.add("hidden"));
sidebarMenuBackdrop.addEventListener("click", (e) => {
  if (e.target === sidebarMenuBackdrop) sidebarMenuBackdrop.classList.add("hidden");
});
// Each row hands off to its own existing action/modal — close this menu
// first so we don't end up with two panels stacked on screen.
[editProfileBtn, friendsBtn, manageUsersBtn, ownerDashboardBtn, reportsBtn, botRequestsBtn, themeToggleBtn, notifyToggleBtn, logoutBtn].forEach((btn) => {
  btn.addEventListener("click", () => sidebarMenuBackdrop.classList.add("hidden"));
});

// ---------- chat settings panel (consolidated wallpaper/disappearing/search/members/leave) ----------
function disappearingLabel(seconds) {
  if (!seconds) return "Off";
  if (seconds === 3600) return "1 hour";
  if (seconds === 86400) return "24 hours";
  if (seconds === 604800) return "7 days";
  return "On";
}

function refreshChatSettingsPanel() {
  const g = currentGroupsCache[activeChatCode];
  if (!g) return;
  if (g.isDirect) {
    const otherKey = otherMemberKeys(g)[0];
    const fallback = (otherKey && g.members && g.members[otherKey]) || g.name;
    const p = profileFor(otherKey || g.name, fallback);
    chatSettingsName.innerHTML = escapeHtml(p.name) + verifiedBadgeHtml(otherKey || g.name);
    chatSettingsAvatar.style.background = p.avatar ? "transparent" : p.color;
    chatSettingsAvatar.innerHTML = avatarInnerHtml(otherKey || g.name, fallback);
    chatSettingsMeta.textContent = "";
    chatSettingsMembersLabel.textContent = "View profile";
  } else {
    chatSettingsName.textContent = g.name;
    if (g.photo) {
      chatSettingsAvatar.style.background = "transparent";
      chatSettingsAvatar.innerHTML = `<img src="${g.photo}" class="avatar-img" alt="" />`;
    } else {
      chatSettingsAvatar.style.background = colorFromName(g.name);
      chatSettingsAvatar.innerHTML = initials(g.name);
    }
    const memberCount = g.members ? Object.keys(g.members).length : 0;
    chatSettingsMeta.textContent = (g.description ? g.description + " · " : "") + "Invite code " + g.code;
    const pendingRequests = joinRequestCounts[g.code] || 0;
    chatSettingsMembersLabel.textContent = pendingRequests > 0
      ? `Members (${memberCount}) · ${pendingRequests} pending`
      : `Members (${memberCount})`;
  }
  disappearingStatusEl.textContent = disappearingLabel(g.disappearingSeconds || 0);
  refreshMuteChatUi();
  addMemberBtn.style.display = g.isDirect ? "none" : "flex";
  groupEditBtn.style.display = g.isDirect || !isGroupAdmin(g, myKey()) ? "none" : "flex";
  copyInviteLinkBtn.style.display = g.isDirect ? "none" : "flex";
}

chatSettingsBtn.addEventListener("click", () => {
  if (!activeChatCode) return;
  refreshChatSettingsPanel();
  chatSettingsBackdrop.classList.remove("hidden");
});
chatSettingsCloseBtn.addEventListener("click", () => chatSettingsBackdrop.classList.add("hidden"));
chatSettingsBackdrop.addEventListener("click", (e) => {
  if (e.target === chatSettingsBackdrop) chatSettingsBackdrop.classList.add("hidden");
});
// Any row inside the panel hands off to its own existing modal/action —
// close this panel first so we don't end up with two stacked on screen.
[wallpaperBtn, disappearingBtn, searchBtn, membersBtn, addMemberBtn, leaveChatBtn].forEach((btn) => {
  btn.addEventListener("click", () => chatSettingsBackdrop.classList.add("hidden"));
});

function openActiveDmProfile() {
  const g = currentGroupsCache[activeChatCode];
  if (!g || !g.isDirect) return;
  const otherKey = otherMemberKeys(g)[0];
  if (!otherKey) return;
  const fallback = (g.members && g.members[otherKey]) || g.name;
  openProfileView(otherKey, fallback);
}

copyInviteLinkBtn.addEventListener("click", () => {
  if (!activeChatCode) return;
  const link = location.origin + location.pathname + "?join=" + encodeURIComponent(activeChatCode);
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(() => window.alert("Invite link copied. Opening it sends a join request to group admins."));
  else window.prompt("Copy this invite link:", link);
});

groupEditBtn.addEventListener("click", () => {
  const g = currentGroupsCache[activeChatCode]; if (!g || g.isDirect || !isGroupAdmin(g, myKey())) return;
  groupEditNameInput.value=g.name||"";groupEditDescriptionInput.value=g.description||"";groupEditError.textContent="";groupEditBackdrop.classList.remove("hidden");groupEditNameInput.focus();
});
function closeGroupEdit(){groupEditBackdrop.classList.add("hidden");}
groupEditCloseBtn.addEventListener("click",closeGroupEdit);groupEditBackdrop.addEventListener("click",e=>{if(e.target===groupEditBackdrop)closeGroupEdit();});
groupEditSaveBtn.addEventListener("click",()=>{const g=currentGroupsCache[activeChatCode];const name=groupEditNameInput.value.trim();if(!g||!name){groupEditError.textContent="Enter a group name.";return;}groupEditSaveBtn.disabled=true;db.ref("groups/"+activeChatCode).update({name:name.slice(0,40),description:groupEditDescriptionInput.value.trim().slice(0,140)}).then(()=>{closeGroupEdit();showToast("Group details saved","success");}).catch(()=>{groupEditError.textContent="Couldn’t save group details.";}).finally(()=>groupEditSaveBtn.disabled=false);});

avatarChat.addEventListener("click", () => {
  const g = currentGroupsCache[activeChatCode];
  if (!g) return;
  if (g.isDirect) { openActiveDmProfile(); return; }
  groupPhotoInput.click();
});
chatNameEl.addEventListener("click", () => {
  const g = currentGroupsCache[activeChatCode];
  if (g && g.isDirect) openActiveDmProfile();
});
groupPhotoInput.addEventListener("change", () => {
  const file = groupPhotoInput.files && groupPhotoInput.files[0];
  const code = activeChatCode;
  groupPhotoInput.value = "";
  if (!file || !code) return;
  if (!file.type.startsWith("image/")) return;
  resizeImageToDataUrl(file, 160).then((dataUrl) => {
    if (dataUrl.length > 220000) { window.alert("That photo is too large — try a smaller image."); return; }
    db.ref("groups/" + code + "/photo").set(dataUrl);
  });
});

// ---------- members modal ----------
function isGroupAdmin(g, key) {
  return !!(g && g.admins && g.admins[key]);
}
membersBtn.addEventListener("click", () => {
  const g = currentGroupsCache[activeChatCode];
  if (!g || !g.members) return;
  const iAmAdmin = isGroupAdmin(g, myKey());
  membersListEl.innerHTML = "";
  if (iAmAdmin && !g.isDirect) renderJoinRequests(activeChatCode);
  Object.keys(g.members).forEach((key) => {
    const fallback = g.members[key];
    const p = profileFor(key, fallback);
    const memberIsAdmin = isGroupAdmin(g, key);
    const row = document.createElement("div");
    row.className = "member-row clickable-row";
    row.innerHTML = `
      <div class="avatar small" style="background:${p.avatar ? "transparent" : p.color}">${avatarInnerHtml(key, fallback)}</div>
      <div class="member-row-text">
        <div class="member-row-name">${escapeHtml(p.name)}${key === myKey() ? " (you)" : ""}${memberIsAdmin ? '<span class="admin-badge">Admin</span>' : ""}</div>
        ${p.status ? `<div class="member-row-status">${escapeHtml(p.status)}</div>` : ""}
      </div>
      ${iAmAdmin && key !== myKey() && !g.isDirect ? `
        <div class="member-row-actions">
          <button class="admin-toggle-btn" data-key="${escapeAttr(key)}">${memberIsAdmin ? "Remove admin" : "Make admin"}</button>
          <button class="remove-member-btn" data-key="${escapeAttr(key)}">Remove</button>
        </div>` : ""}
    `;
    row.addEventListener("click", (e) => {
      if (e.target.closest(".member-row-actions")) return;
      membersModalBackdrop.classList.add("hidden");
      openProfileView(key, fallback);
    });
    membersListEl.appendChild(row);
  });
  membersModalBackdrop.classList.remove("hidden");
});
// ---------- join requests (admins only) ----------
// Invite codes no longer add someone straight to a group — they file a
// request under joinRequests/{code}/{key} that only an admin of that group
// can turn into real membership (or clear away). Loaded fresh (once, not a
// live listener) each time the Members panel is opened.
function renderJoinRequests(code) {
  db.ref("joinRequests/" + code).once("value").then((snap) => {
    // The chat changed, or the panel was closed/reopened, before this
    // read came back — don't insert a stale/duplicate section.
    if (activeChatCode !== code || membersModalBackdrop.classList.contains("hidden")) return;
    const existing = membersListEl.querySelector(".join-requests-section");
    if (existing) existing.remove();
    const reqs = snap.val() || {};
    const keys = Object.keys(reqs);
    if (!keys.length) return;
    const section = document.createElement("div");
    section.className = "join-requests-section";
    const heading = document.createElement("div");
    heading.className = "member-row-status join-requests-heading";
    heading.textContent = `Pending join requests (${keys.length})`;
    section.appendChild(heading);
    keys.forEach((key) => {
      const req = reqs[key] || {};
      const name = req.name || key;
      const row = document.createElement("div");
      row.className = "member-row";
      row.innerHTML = `
        <div class="avatar small" style="background:${colorFromName(name)}">${initials(name)}</div>
        <div class="member-row-text">
          <div class="member-row-name">${escapeHtml(name)}</div>
        </div>
        <div class="member-row-actions">
          <button class="approve-request-btn" data-key="${escapeAttr(key)}" data-name="${escapeAttr(name)}">Approve</button>
          <button class="deny-request-btn" data-key="${escapeAttr(key)}">Deny</button>
        </div>`;
      section.appendChild(row);
    });
    membersListEl.insertBefore(section, membersListEl.firstChild);
  });
}

membersListEl.addEventListener("click", (e) => {
  const approveBtn = e.target.closest(".approve-request-btn");
  if (approveBtn) {
    const code = activeChatCode;
    const key = approveBtn.dataset.key;
    const name = approveBtn.dataset.name;
    db.ref(`groups/${code}/members/${key}`).set(name)
      .then(() => db.ref(`usergroups/${key}/${code}`).set(true))
      .then(() => db.ref(`joinRequests/${code}/${key}`).remove())
      .then(() => membersBtn.click())
      .catch((err) => window.alert("Couldn't approve: " + err.message));
    return;
  }
  const denyBtn = e.target.closest(".deny-request-btn");
  if (denyBtn) {
    const code = activeChatCode;
    const key = denyBtn.dataset.key;
    db.ref(`joinRequests/${code}/${key}`).remove()
      .then(() => membersBtn.click())
      .catch((err) => window.alert("Couldn't deny: " + err.message));
    return;
  }
});

membersCloseBtn.addEventListener("click", () => membersModalBackdrop.classList.add("hidden"));

membersListEl.addEventListener("click", (e) => {
  const g = currentGroupsCache[activeChatCode];
  if (!g) return;
  const toggleBtn = e.target.closest(".admin-toggle-btn");
  if (toggleBtn) {
    const key = toggleBtn.dataset.key;
    if (!g.admins) g.admins = {};
    const ref = db.ref(`groups/${activeChatCode}/admins/${key}`);
    if (isGroupAdmin(g, key)) { delete g.admins[key]; ref.remove(); }
    else { g.admins[key] = true; ref.set(true); }
    membersBtn.click(); // re-render the list from the (now-patched) local cache
    return;
  }
  const removeBtn = e.target.closest(".remove-member-btn");
  if (removeBtn) {
    const key = removeBtn.dataset.key;
    const name = (g.members && g.members[key]) || "this person";
    if (!window.confirm(`Remove ${name} from this chat?`)) return;
    db.ref(`groups/${activeChatCode}/members/${key}`).remove();
    db.ref(`groups/${activeChatCode}/admins/${key}`).remove();
    db.ref(`usergroups/${key}/${activeChatCode}`).remove();
    membersModalBackdrop.classList.add("hidden");
  }
});

function listenToMessages(code) {
  cleanupChatListeners();
  lastPresenceForChat = null;
  const g = currentGroupsCache[code];
  let headerBase = "";
  if (g) {
    refreshChatHeader();
    const memberCount = g.members ? Object.keys(g.members).length : 0;
    headerBase = g.isDirect ? "" : `${memberCount} member${memberCount !== 1 ? "s" : ""} · invite code ${g.code}`;
    chatMetaEl.textContent = headerBase;
    chatMetaEl.classList.remove("typing");
    addMemberBtn.style.display = g.isDirect ? "none" : "flex";
  groupEditBtn.style.display = g.isDirect || !isGroupAdmin(g, myKey()) ? "none" : "flex";
  copyInviteLinkBtn.style.display = g.isDirect ? "none" : "flex";

    // presence, only meaningful for 1:1 chats
    if (g.isDirect) {
      const otherKey = otherMemberKeys(g)[0];
      if (otherKey) {
        const pref = db.ref("presence/" + otherKey);
        const pcb = pref.on("value", (psnap) => {
          if (activeChatCode !== code) return; // stale listener from a chat we've since left
          const p = psnap.val();
          lastPresenceForChat = p;
          if (!chatMetaEl.classList.contains("typing")) {
            const online = p && p.state === "online";
            chatMetaEl.innerHTML = `<span class="presence-dot ${online ? "online" : ""}"></span>${presenceLabel(p) || "offline"}`;
          }
        });
        presenceListenerOff = () => pref.off("value", pcb);
      }
    }
  }

  // typing indicator
  const tref = db.ref("typing/" + code);
  const tcb = tref.on("value", (tsnap) => {
    if (activeChatCode !== code) return; // stale listener from a chat we've since left
    const val = tsnap.val() || {};
    const others = Object.keys(val).filter((k) => k !== myKey() && val[k]);
    if (others.length > 0) {
      chatMetaEl.textContent = "typing…";
      chatMetaEl.classList.add("typing");
    } else {
      chatMetaEl.classList.remove("typing");
      if (g && !g.isDirect) {
        chatMetaEl.textContent = headerBase;
      } else if (g && g.isDirect) {
        const p = lastPresenceForChat;
        const online = p && p.state === "online";
        chatMetaEl.innerHTML = `<span class="presence-dot ${online ? "online" : ""}"></span>${presenceLabel(p) || "offline"}`;
      }
    }
  });
  typingListenerOff = () => tref.off("value", tcb);

  // read receipts for messages I sent
  const rref = db.ref("reads/" + code);
  const rcb = rref.on("value", (rsnap) => {
    if (activeChatCode !== code) return; // stale listener from a chat we've since left
    otherReads = rsnap.val() || {};
    renderMessages(lastRenderedMsgs);
  });
  readsListenerOff = () => rref.off("value", rcb);

  // reactions
  const xref = db.ref("reactions/" + code);
  const xcb = xref.on("value", (xsnap) => {
    if (activeChatCode !== code) return; // stale listener from a chat we've since left
    reactionsCache = xsnap.val() || {};
    renderMessages(lastRenderedMsgs);
  });
  reactionsListenerOff = () => xref.off("value", xcb);

  const ref = db.ref("messages/" + code);
  const cb = ref.on("value", (snap) => {
    if (activeChatCode !== code) return; // stale listener from a chat we've since left
    const val = snap.val() || {};
    const now = Date.now();
    const msgs = Object.keys(val)
      .filter((k) => k !== "placeholder")
      .map((k) => Object.assign({ id: k }, val[k]))
      .filter((m) => {
        if (m.expiresAt && m.expiresAt <= now) {
          // Best-effort cleanup — whoever's viewing the chat when a message
          // expires removes it for everyone.
          db.ref("messages/" + code + "/" + m.id).remove();
          return false;
        }
        return true;
      })
      .sort((a, b) => a.ts - b.ts);
    lastRenderedMsgs = msgs;
    renderMessages(msgs);
    if (activeChatCode === code) markRead(code);
    scheduleDisappearingSweep(code, msgs);
  });
  messagesListener = () => ref.off("value", cb);
}

// The filter above only re-runs when Firebase's "value" event fires — i.e.
// on a genuinely new/edited/removed message — NOT just because time has
// passed. Without this, a message set to disappear in (say) 30 seconds
// would sit there indefinitely in a chat with no other activity, only
// getting cleaned up whenever something *else* happened to touch that
// chat later. This schedules an actual timer for the soonest upcoming
// expiry in the currently-open chat, so it disappears right on time.
function scheduleDisappearingSweep(code, msgs) {
  if (disappearingSweepTimer) { clearTimeout(disappearingSweepTimer); disappearingSweepTimer = null; }
  const upcoming = msgs
    .map((m) => m.expiresAt)
    .filter((t) => typeof t === "number");
  if (!upcoming.length) return;
  const nextExpiry = Math.min(...upcoming);
  const delay = Math.max(nextExpiry - Date.now(), 250);
  disappearingSweepTimer = setTimeout(() => {
    if (activeChatCode !== code) return; // left this chat before the timer fired
    const now = Date.now();
    const stillGood = lastRenderedMsgs.filter((m) => {
      if (m.expiresAt && m.expiresAt <= now) {
        db.ref("messages/" + code + "/" + m.id).remove();
        return false;
      }
      return true;
    });
    if (stillGood.length !== lastRenderedMsgs.length) {
      lastRenderedMsgs = stillGood;
      renderMessages(stillGood);
    }
    scheduleDisappearingSweep(code, stillGood);
  }, delay);
}

let lastRenderedMsgs = [];
function updateJumpLatestButton() {
  const away = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight > 180;
  jumpLatestBtn.classList.toggle("hidden", !away);
}
messagesEl.addEventListener("scroll", updateJumpLatestButton, { passive: true });
jumpLatestBtn.addEventListener("click", () => { messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" }); jumpLatestBtn.classList.add("hidden"); });

function dateDividerLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "long", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

function messageTextHtml(text, g) {
  const safe = escapeHtml(text || "");
  if (!g || !g.members) return safe;
  const members = Object.keys(g.members).map((key) => ({ key, name: profileFor(key, g.members[key]).name }));
  return safe.replace(/@([a-zA-Z0-9_. -]{2,40})/g, (full, raw) => {
    const wanted = raw.trim().toLowerCase(); const found = members.find((m) => m.name.toLowerCase() === wanted || m.key.toLowerCase() === wanted);
    return found ? `<button class="mention-token" data-user-key="${escapeAttr(found.key)}">@${escapeHtml(raw.trim())}</button>` : full;
  });
}

function renderMessages(rawMsgs) {
  const msgs = searchQuery
    ? rawMsgs.filter((m) => !m.deleted && (
        (m.text || "").toLowerCase().includes(searchQuery) ||
        (m.fileName || "").toLowerCase().includes(searchQuery)
      ))
    : rawMsgs;
  const wasNearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
  messagesEl.innerHTML = "";
  if (msgs.length === 0) {
    const div = document.createElement("div");
    div.className = searchQuery ? "search-no-results" : "empty-messages";
    div.textContent = searchQuery ? "No messages match your search." : "No messages yet. Say hello.";
    messagesEl.appendChild(div);
    return;
  }
  const g = currentGroupsCache[activeChatCode];
  const others = g ? otherMemberKeys(g) : [];
  let lastDateStr = null;
  let prevMsg = null;
  const GROUP_WINDOW_MS = 5 * 60 * 1000;

  msgs.forEach((m) => {
    const dStr = new Date(m.ts).toDateString();
    if (dStr !== lastDateStr) {
      const divider = document.createElement("div");
      divider.className = "date-divider";
      divider.textContent = dateDividerLabel(m.ts);
      messagesEl.appendChild(divider);
      lastDateStr = dStr;
      prevMsg = null; // don't group across a date divider
    }

    const mine = m.sender === username;
    const isPinned = !!(g && g.pinnedMessageId === m.id);

    if (m.system) {
      const sysRow = document.createElement("div");
      sysRow.className = "system-msg-row";
      sysRow.textContent = m.text || "";
      messagesEl.appendChild(sysRow);
      prevMsg = null; // system messages never group with bubbles
      return;
    }

    const grouped = !!(
      prevMsg && prevMsg.sender === m.sender && !prevMsg.deleted && !m.deleted &&
      (m.ts - prevMsg.ts) < GROUP_WINDOW_MS
    );
    const row = document.createElement("div");
    row.className = "msg-row " + (mine ? "mine" : "theirs") + (grouped ? " grouped" : "");
    row.dataset.msgId = m.id;

    let ticksHtml = "";
    if (mine && !m.deleted) {
      const readByAll = others.length > 0 && others.every((k) => (otherReads[k] || 0) >= m.ts);
      ticksHtml = `<span class="read-ticks ${readByAll ? "read" : ""}">${readByAll ? "✓✓" : "✓"}</span>`;
    }

    let senderLabel = m.sender;
    let senderColor = colorFromName(m.sender);
    let senderKeyForBadge = keyFor(m.sender);
    if (!mine && g && g.members) {
      const senderKey = Object.keys(g.members).find((k) => g.members[k] === m.sender);
      if (senderKey) {
        const p = profileFor(senderKey, m.sender);
        senderLabel = p.name;
        senderColor = p.color;
        senderKeyForBadge = senderKey;
      }
    }

    let bubbleInner;
    if (m.deleted) {
      bubbleInner = "Message deleted";
    } else if (m.image) {
      bubbleInner = `<img src="${m.image}" class="msg-image" alt="" />` +
        (m.text ? `<div class="msg-caption">${escapeHtml(m.text)}</div>` : "");
    } else if (m.file) {
      bubbleInner = `<a class="msg-file" href="${m.file}" download="${escapeAttr(m.fileName || "file")}">` +
        `<span class="msg-file-icon">📄</span>` +
        `<span class="msg-file-info"><span class="msg-file-name">${escapeHtml(m.fileName || "file")}</span>` +
        `<span class="msg-file-size">${formatBytes(m.fileSize)}</span></span></a>` +
        (m.text ? `<div class="msg-caption">${escapeHtml(m.text)}</div>` : "");
    } else {
      bubbleInner = messageTextHtml(m.text, g);
    }
    if (m.replyTo && !m.deleted) {
      bubbleInner = `<div class="msg-quote" data-quote-id="${escapeAttr(m.replyTo.id)}">
        <div class="msg-quote-sender">${escapeHtml(m.replyTo.sender || "")}</div>
        <div class="msg-quote-text">${escapeHtml(m.replyTo.preview || "")}</div>
      </div>` + bubbleInner;
    }

    const reactions = reactionsCache[m.id] || {};
    const reactionPills = Object.keys(reactions)
      .map((emoji) => {
        const users = reactions[emoji] || {};
        const count = Object.keys(users).length;
        if (count === 0) return "";
        const isMine = !!users[myKey()];
        return `<div class="reaction-pill ${isMine ? "mine" : ""}" data-emoji="${emoji}">${emoji} ${count}</div>`;
      })
      .join("");

    const actionsHtml = m.deleted ? "" : `
      <div class="msg-actions">
        <button class="msg-action-btn msg-react-btn" aria-label="React" title="React">♡</button>
        <button class="msg-action-btn msg-reply-btn" aria-label="Reply" title="Reply">↩</button>
        <button class="msg-action-btn msg-forward-btn" aria-label="Forward" title="Forward">↗</button>
        <button class="msg-action-btn msg-pin-btn" aria-label="${isPinned ? "Unpin" : "Pin"}" title="${isPinned ? "Unpin" : "Pin"}">⌑</button>
        ${mine ? `<button class="msg-action-btn msg-edit-btn" aria-label="Edit message" title="Edit message">✎</button>` : ""}
        ${(mine || isSiteAdmin()) ? `<button class="msg-action-btn msg-delete-btn" aria-label="Delete message" title="Delete message">×</button>` : ""}
      </div>
    `;

    row.innerHTML = `
      ${!mine && !m.deleted && !grouped ? `<div class="msg-sender" style="color:${senderColor}">${escapeHtml(senderLabel)}${verifiedBadgeHtml(senderKeyForBadge)}</div>` : ""}
      <div class="msg-row-inner">
        <div class="msg-bubble ${mine ? "mine" : "theirs"} ${m.image && !m.deleted ? "has-image" : ""} ${m.deleted ? "deleted" : ""}">${bubbleInner}</div>
        ${actionsHtml}
      </div>
      ${reactionPills ? `<div class="reactions-row">${reactionPills}</div>` : ""}
      <div class="msg-time-row">
        <span class="msg-time">${timeLabel(m.ts)}</span>
        ${m.edited && !m.deleted ? '<span class="edited-tag">edited</span>' : ""}
        ${m.forwarded && !m.deleted ? '<span class="forwarded-tag">forwarded</span>' : ""}
        ${m.expiresAt && !m.deleted ? '<span class="disappear-tag" title="Disappears automatically">⏱</span>' : ""}
        ${ticksHtml}
      </div>
    `;
    messagesEl.appendChild(row);
    prevMsg = m;
  });
  const newest = msgs[msgs.length - 1];
  if (wasNearBottom || (newest && newest.sender === username)) messagesEl.scrollTop = messagesEl.scrollHeight;
  renderPinnedBanner();
  updateJumpLatestButton();
}

// ---------- reactions ----------
const REACTION_EMOJIS = ["❤️", "😂", "👍", "😮", "😢", "🙏"];
let reactionPickerEl = null;

function closeReactionPicker() {
  if (reactionPickerEl) { reactionPickerEl.remove(); reactionPickerEl = null; }
}
function openReactionPicker(anchorBtn, msgId) {
  closeReactionPicker();
  const picker = document.createElement("div");
  picker.className = "reaction-picker";
  picker.innerHTML = REACTION_EMOJIS.map((e) => `<button data-emoji="${e}">${e}</button>`).join("");
  document.body.appendChild(picker);
  const rect = anchorBtn.getBoundingClientRect();
  const margin = 8;
  // Prefer showing above the button; if there isn't room (message near the
  // top of the screen), flip to showing below it instead of running off
  // the top edge, invisible and un-tappable.
  let top = rect.top - picker.offsetHeight - 10;
  if (top < margin) top = rect.bottom + 10;
  top = Math.max(margin, Math.min(top, window.innerHeight - picker.offsetHeight - margin));
  let left = rect.left - 80;
  left = Math.max(margin, Math.min(left, window.innerWidth - picker.offsetWidth - margin));
  picker.style.top = top + "px";
  picker.style.left = left + "px";
  picker.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-emoji]");
    if (btn) toggleReaction(msgId, btn.dataset.emoji);
    closeReactionPicker();
  });
  reactionPickerEl = picker;
}
document.addEventListener("click", (e) => {
  if (reactionPickerEl && !e.target.closest(".reaction-picker") && !e.target.closest(".msg-react-btn")) {
    closeReactionPicker();
  }
});

function toggleReaction(msgId, emoji) {
  if (!activeChatCode) return;
  const ref = db.ref(`reactions/${activeChatCode}/${msgId}/${emoji}/${myKey()}`);
  ref.once("value").then((snap) => {
    if (snap.exists()) ref.remove();
    else ref.set(true);
  });
}

let forwardMessageDraft = null;
let forwardTargetCode = null;
function closeForwardModal() { forwardModalBackdrop.classList.add("hidden"); forwardMessageDraft = null; forwardTargetCode = null; }
function forwardMessage(msgId) {
  const m = lastRenderedMsgs.find((item) => item.id === msgId); if (!m || m.deleted) return;
  const choices = Object.values(currentGroupsCache).filter((g) => g.code !== activeChatCode);
  if (!choices.length) { window.alert("Create or join another chat before forwarding."); return; }
  forwardMessageDraft = m; forwardTargetCode = null; forwardSendBtn.disabled = true; forwardChatList.innerHTML = "";
  choices.sort((a,b)=>(b.lastActivity||0)-(a.lastActivity||0)).forEach((g) => {
    const item=document.createElement("button"); item.className="forward-chat-option";
    const count=g.members?Object.keys(g.members).length:0;
    item.innerHTML=`<span class="forward-option-avatar">${escapeHtml(initials(g.name))}</span><span><strong>${escapeHtml(g.name)}</strong><small>${g.isDirect?"Direct message":count+" members"}</small></span><span class="forward-option-check">✓</span>`;
    item.addEventListener("click",()=>{forwardTargetCode=g.code;forwardChatList.querySelectorAll(".forward-chat-option").forEach(x=>x.classList.remove("selected"));item.classList.add("selected");forwardSendBtn.disabled=false;});
    forwardChatList.appendChild(item);
  });
  forwardModalBackdrop.classList.remove("hidden");
}
forwardCloseBtn.addEventListener("click",closeForwardModal);
forwardModalBackdrop.addEventListener("click",(e)=>{if(e.target===forwardModalBackdrop)closeForwardModal();});
forwardSendBtn.addEventListener("click",()=>{
  const m=forwardMessageDraft;const target=currentGroupsCache[forwardTargetCode];if(!m||!target)return;
  forwardSendBtn.disabled=true;const copy={sender:username,ts:Date.now(),text:m.text||"",forwarded:true};if(m.image)copy.image=m.image;if(m.file)Object.assign(copy,{file:m.file,fileName:m.fileName,fileSize:m.fileSize});
  db.ref("messages/"+target.code).push(copy);db.ref("groups/"+target.code).update({lastActivity:Date.now(),lastSender:username});closeForwardModal();showToast("Message forwarded to "+target.name,"success");
});

function deleteMessage(msgId) {
  if (!activeChatCode) return;
  appConfirm("Delete message?", "This message will be removed for everyone in the chat.", "Delete").then((ok) => { if (!ok) return; db.ref(`messages/${activeChatCode}/${msgId}`).update({ deleted: true, text: "", image: null, file: null, fileName: null });
  db.ref(`reactions/${activeChatCode}/${msgId}`).remove(); });
}

function startEditMessage(msgId) {
  const m = lastRenderedMsgs.find((x) => x.id === msgId);
  const row = messagesEl.querySelector(`.msg-row[data-msg-id="${CSS.escape(msgId)}"]`);
  if (!m || !row) return;
  const bubble = row.querySelector(".msg-bubble");
  if (!bubble) return;
  const original = bubble.innerHTML;

  bubble.innerHTML = `<input class="msg-edit-input" value="${escapeAttr(m.text || "")}" />`;
  const input = bubble.querySelector(".msg-edit-input");
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  let settled = false;
  function commit() {
    if (settled) return;
    settled = true;
    const newText = input.value.trim();
    if (newText !== (m.text || "")) {
      db.ref(`messages/${activeChatCode}/${msgId}`).update({ text: newText, edited: true });
    } else {
      bubble.innerHTML = original;
    }
  }
  function cancel() {
    if (settled) return;
    settled = true;
    bubble.innerHTML = original;
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  input.addEventListener("blur", cancel);
}

messagesEl.addEventListener("click", (e) => {
  const imgEl = e.target.closest(".msg-image");
  if (imgEl) {
    openLightbox(imgEl.src);
    return;
  }
  const row = e.target.closest(".msg-row");
  if (!row) return;
  const msgId = row.dataset.msgId;
  if (e.target.closest(".msg-react-btn")) {
    openReactionPicker(e.target.closest(".msg-react-btn"), msgId);
    return;
  }
  if (e.target.closest(".msg-delete-btn")) {
    deleteMessage(msgId);
    return;
  }
  if (e.target.closest(".msg-edit-btn")) {
    startEditMessage(msgId);
    return;
  }
  if (e.target.closest(".msg-reply-btn")) {
    startReply(msgId);
    return;
  }
  if (e.target.closest(".msg-forward-btn")) {
    forwardMessage(msgId);
    return;
  }
  if (e.target.closest(".msg-pin-btn")) {
    pinMessage(msgId);
    return;
  }
  const mention = e.target.closest(".mention-token");
  if (mention) { const key = mention.dataset.userKey; const g = currentGroupsCache[activeChatCode]; if (key && g) openProfileView(key, g.members[key]); return; }
  const quote = e.target.closest(".msg-quote");
  if (quote && quote.dataset.quoteId) {
    scrollToAndHighlightMessage(quote.dataset.quoteId);
    return;
  }
  const pill = e.target.closest(".reaction-pill");
  if (pill) {
    toggleReaction(msgId, pill.dataset.emoji);
    return;
  }
  // Tapping the bubble itself (not a link/image inside it) toggles the
  // delete/edit/reply/pin row — hover doesn't work on touch devices, so
  // without this there'd be no way to reach those actions on mobile.
  const bubble = e.target.closest(".msg-bubble");
  if (bubble && !e.target.closest(".msg-file") && !e.target.closest(".msg-quote")) {
    const actions = row.querySelector(".msg-actions");
    if (actions) {
      const willShow = !actions.classList.contains("force-show");
      document.querySelectorAll(".msg-actions.force-show").forEach((el) => el.classList.remove("force-show"));
      if (willShow) actions.classList.add("force-show");
    }
  }
});
// Tapping anywhere outside a message bubble closes any open action row.
document.addEventListener("click", (e) => {
  if (e.target.closest(".msg-bubble") || e.target.closest(".msg-actions")) return;
  document.querySelectorAll(".msg-actions.force-show").forEach((el) => el.classList.remove("force-show"));
});

// full-screen photo preview
function openLightbox(src) {
  if (!src) return;
  const backdrop = document.createElement("div");
  backdrop.className = "lightbox-backdrop";
  const img = document.createElement("img");
  img.src = src;
  img.alt = "";
  backdrop.appendChild(img);
  backdrop.addEventListener("click", () => backdrop.remove());
  document.addEventListener("keydown", function onEsc(ev) {
    if (ev.key === "Escape") { backdrop.remove(); document.removeEventListener("keydown", onEsc); }
  });
  document.body.appendChild(backdrop);
}

// ---------- add member / leave ----------
addMemberBtn.addEventListener("click", () => {
  if (!activeChatCode) return;
  const target = window.prompt("Add someone by username:");
  if (!target || !target.trim()) return;
  const targetKey = keyFor(target.trim());
  const code = activeChatCode;
  db.ref("usernames/" + targetKey).once("value").then((snap) => {
    if (!snap.exists()) { window.alert("No user found with that username."); return; }
    const targetName = typeof snap.val() === "string" ? snap.val() : target.trim();
    const g = currentGroupsCache[code];
    const groupName = g ? g.name : "the group";
    db.ref("groups/" + code + "/members/" + targetKey).set(targetName)
      .then(() => db.ref("usergroups/" + targetKey + "/" + code).set(true))
      .then(() => {
        // Let everyone in the group see who added whom — visible, in-chat,
        // no separate "who did this" question needed.
        const announceText = `➕ ${username} added ${targetName} to the group.`;
        const msg = { sender: username, ts: Date.now(), text: announceText, system: true };
        db.ref("messages/" + code).push(msg);
        db.ref("groups/" + code + "/lastActivity").set(Date.now());
        db.ref("groups/" + code + "/lastSender").set(username);
        triggerPushNotification(code, username, announceText);
        // Also DM the added person directly, in case they don't open the
        // group chat right away — tells them who added them and to what.
        if (targetKey !== myKey()) {
          sendAutoMessageTo(targetKey, targetName, `👋 ${username} added you to the group "${groupName}".`);
        }
      });
  });
});

leaveChatBtn.addEventListener("click", () => {
  if (!activeChatCode) return;
  const g = currentGroupsCache[activeChatCode];
  appConfirm("Leave this chat?", `You’ll stop receiving new messages from “${g ? g.name : "this chat"}”.`, "Leave").then((ok) => { if (!ok) return;
  const code = activeChatCode;
  db.ref("usergroups/" + myKey() + "/" + code).remove();
  if (g && !g.isDirect) {
    db.ref("groups/" + code + "/members/" + myKey()).remove();
  }
  activeChatCode = null;
  chatView.classList.add("hidden");
  emptyState.classList.remove("hidden");
  document.getElementById("sidebar").classList.remove("hide-mobile");
  cleanupChatListeners();
  });
});

sendBtn.addEventListener("click", sendMessage);
draftInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendMessage(); });
draftInput.addEventListener("input", () => {
  draftCount.textContent = draftInput.value.length + " / 5000";
  draftCount.classList.toggle("hidden", draftInput.value.length < 4000);
  renderMentionPicker();
  saveDraft();
  if (!activeChatCode) return;
  db.ref("typing/" + activeChatCode + "/" + myKey()).set(true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    db.ref("typing/" + activeChatCode + "/" + myKey()).remove();
  }, 2000);
});

function renderMentionPicker() {
  if (!activeChatCode) { mentionPicker.classList.add("hidden"); return; }
  const g = currentGroupsCache[activeChatCode]; const match = draftInput.value.match(/(?:^|\s)@([^@\s]*)$/);
  if (!g || g.isDirect || !g.members || !match) { mentionPicker.classList.add("hidden"); return; }
  const query = match[1].toLowerCase(); const options = Object.keys(g.members).filter((key) => key !== myKey()).map((key) => ({key,name:profileFor(key,g.members[key]).name})).filter((m) => m.name.toLowerCase().includes(query) || m.key.includes(query)).slice(0,5);
  if (!options.length) { mentionPicker.classList.add("hidden"); return; }
  mentionPicker.innerHTML = options.map((m) => `<button data-key="${escapeAttr(m.key)}">@${escapeHtml(m.name)}</button>`).join(""); mentionPicker.classList.remove("hidden");
}
mentionPicker.addEventListener("click", (e) => { const b=e.target.closest("button[data-key]"); if(!b) return; const g=currentGroupsCache[activeChatCode]; const name=profileFor(b.dataset.key,g.members[b.dataset.key]).name; draftInput.value=draftInput.value.replace(/@[^@\s]*$/, "@"+name+" "); mentionPicker.classList.add("hidden"); draftInput.focus(); });

function alertIfBlocked() {
  if (!isBlocked(myKey())) return false;
  const reason = blockReasonFor(myKey());
  window.alert("You've been blocked from sending messages." + (reason ? "\nReason: " + reason : ""));
  return true;
}

// ---------- reply-to-message ----------
let replyingToMsg = null; // { id, senderLabel, preview }

function previewTextFor(m) {
  if (m.deleted) return "Message deleted";
  if (m.image) return m.text ? "📷 " + m.text : "📷 Photo";
  if (m.file) return "📄 " + (m.fileName || "File");
  return (m.text || "").slice(0, 80);
}

function startReply(msgId) {
  const m = lastRenderedMsgs.find((x) => x.id === msgId);
  if (!m || m.deleted) return;
  const senderLabel = m.sender === username ? "You" : m.sender;
  replyingToMsg = { id: m.id, senderLabel, preview: previewTextFor(m) };
  replyPreviewSender.textContent = senderLabel;
  replyPreviewText.textContent = replyingToMsg.preview;
  replyPreviewBar.classList.remove("hidden");
  draftInput.focus();
}
function clearReplyPreview() {
  replyingToMsg = null;
  replyPreviewBar.classList.add("hidden");
}
replyPreviewCancel.addEventListener("click", clearReplyPreview);

function scrollToAndHighlightMessage(msgId) {
  const row = messagesEl.querySelector(`.msg-row[data-msg-id="${CSS.escape(msgId)}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.remove("highlight-flash");
  void row.offsetWidth; // restart animation if clicked repeatedly
  row.classList.add("highlight-flash");
}

// ---------- pin message ----------
function pinMessage(msgId) {
  if (!activeChatCode) return;
  const g = currentGroupsCache[activeChatCode];
  const alreadyPinned = g && g.pinnedMessageId === msgId;
  db.ref("groups/" + activeChatCode + "/pinnedMessageId").set(alreadyPinned ? null : msgId);
}

function renderPinnedBanner() {
  const g = currentGroupsCache[activeChatCode];
  const pinnedId = g && g.pinnedMessageId;
  if (!pinnedId) { pinnedBanner.classList.add("hidden"); return; }
  const m = lastRenderedMsgs.find((x) => x.id === pinnedId);
  if (!m || m.deleted) { pinnedBanner.classList.add("hidden"); return; }
  pinnedBannerText.textContent = (m.sender === username ? "You: " : m.sender + ": ") + previewTextFor(m);
  pinnedBanner.classList.remove("hidden");
}
pinnedBanner.addEventListener("click", (e) => {
  if (e.target.closest("#pinned-banner-unpin")) return;
  const g = currentGroupsCache[activeChatCode];
  if (g && g.pinnedMessageId) scrollToAndHighlightMessage(g.pinnedMessageId);
});
pinnedBannerUnpin.addEventListener("click", () => {
  if (activeChatCode) db.ref("groups/" + activeChatCode + "/pinnedMessageId").set(null);
});

// ---------- disappearing messages ----------
disappearingBtn.addEventListener("click", () => {
  if (!activeChatCode) return;
  const g = currentGroupsCache[activeChatCode];
  const current = (g && g.disappearingSeconds) || 0;
  disappearingOptions.forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.seconds) === current);
  });
  disappearingModalBackdrop.classList.remove("hidden");
});
disappearingCloseBtn.addEventListener("click", () => disappearingModalBackdrop.classList.add("hidden"));
disappearingOptions.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!activeChatCode) return;
    const seconds = Number(btn.dataset.seconds);
    db.ref("groups/" + activeChatCode + "/disappearingSeconds").set(seconds || null)
      .then(() => showToast("Disappearing messages: " + disappearingLabel(seconds), "success"))
      .catch(() => showToast("Couldn’t update disappearing messages.", "error"));
    disappearingModalBackdrop.classList.add("hidden");
  });
});

function sendMessage() {
  const text = draftInput.value.trim();
  if (!text || !activeChatCode) return;
  if (alertIfBlocked()) return;
  if (navigator.onLine) draftInput.value = "";
  clearTimeout(typingTimeout);
  db.ref("typing/" + activeChatCode + "/" + myKey()).remove();
  pushMessage({ text });
}

function pushMessage(extra) {
  const code = activeChatCode;
  if (!code || outgoingMessage) return Promise.resolve();
  if (alertIfBlocked()) return Promise.resolve();
  if (!navigator.onLine) {
    failedOutgoing = extra;
    setSendStatus("error", "You’re offline — tap Retry when you reconnect.");
    return Promise.resolve();
  }
  outgoingMessage = true;
  sendBtn.disabled = true;
  setSendStatus("sending", "Sending…");
  const msg = Object.assign({ sender: username, ts: Date.now(), text: "", clientId: `${myKey()}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` }, extra);
  if (replyingToMsg) {
    msg.replyTo = { id: replyingToMsg.id, sender: replyingToMsg.senderLabel, preview: replyingToMsg.preview };
    clearReplyPreview();
  }
  const g = currentGroupsCache[code];
  if (g && g.disappearingSeconds) msg.expiresAt = Date.now() + g.disappearingSeconds * 1000;
  const msgRef = db.ref("messages/" + code).push();
  return msgRef.set(msg)
    .then(() => Promise.all([
      db.ref("groups/" + code + "/lastActivity").set(Date.now()),
      db.ref("groups/" + code + "/lastSender").set(username),
      db.ref("groups/" + code + "/lastMessage").set((msg.text || (msg.image ? "Photo" : msg.file ? "File" : "Message")).slice(0, 100))
    ]))
    .then(() => {
      localStorage.removeItem(draftStorageKey(code));
      setSendStatus("success", "Sent");
      setTimeout(() => setSendStatus("", ""), 900);
      triggerPushNotification(code, username, msg.text || (msg.image ? "📷 Photo" : ""));
      if (code === botDmCodeFor(myKey()) && msg.text) handleBotMessage(msg.text);
    })
    .catch(() => {
      failedOutgoing = extra;
      if (extra.text && !draftInput.value) draftInput.value = extra.text;
      setSendStatus("error", "Message not sent. Tap Retry to try again.");
    })
    .finally(() => { outgoingMessage = false; sendBtn.disabled = false; });
}

imageInput.addEventListener("change", () => {
  const file = imageInput.files && imageInput.files[0];
  const caption = draftInput.value.trim();
  imageInput.value = "";
  if (!file || !activeChatCode) return;
  if (!file.type.startsWith("image/")) { window.alert("Please choose an image file."); return; }
  resizeFitDataUrl(file, 900, 0.7)
    .then((dataUrl) => {
      if (dataUrl.length > 700000) { window.alert("That photo is too large — try a smaller image."); return; }
      draftInput.value = "";
      pushMessage({ image: dataUrl, text: caption });
    })
    .catch(() => window.alert("Couldn't read that image — try another one."));
});

// Any non-image file (PDFs, docs, etc). We read it as-is and keep the
// original filename string untouched — JS strings, Firebase, and HTML
// attributes are all UTF-8/UTF-16 native, so no manual percent-encoding
// is needed (that's what was corrupting non-Latin filenames before).
fileInput.addEventListener("change", () => {
  const file = fileInput.files && fileInput.files[0];
  const caption = draftInput.value.trim();
  fileInput.value = "";
  if (!file || !activeChatCode) return;

  if (file.type.startsWith("image/")) {
    resizeFitDataUrl(file, 900, 0.7).then((dataUrl) => {
      if (dataUrl.length > 700000) { window.alert("That photo is too large — try a smaller image."); return; }
      draftInput.value = "";
      pushMessage({ image: dataUrl, text: caption });
    });
    return;
  }

  if (file.size > 700000) {
    window.alert("That file is too large to send here (max ~700KB, since it's stored directly in the chat database).");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    draftInput.value = "";
    pushMessage({ file: reader.result, fileName: file.name, fileSize: file.size, text: caption });
  };
  reader.onerror = () => window.alert("Couldn't read that file — try again.");
  reader.readAsDataURL(file);
});

window.__appLockBootCallback = init;
if (isAppLockEnabled()) {
  screenSplash.classList.add("hidden");
  attemptAppUnlock(init);
} else {
  init();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// Keep the composer above Android/iOS software keyboards when Visual Viewport is available.
(function setupVisualViewport() {
  if (!window.visualViewport) return;
  let lastKeyboard = 0;
  const update = () => {
    const vv = window.visualViewport;
    const keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty("--keyboard-offset", keyboard + "px");
    document.documentElement.style.setProperty("--visual-viewport-height", vv.height + "px");
    // The visible area just resized (keyboard opening/closing) — without
    // this, the message list keeps its old scroll position, which now
    // shows as a blank gap where the reserved composer space used to be
    // safely off-screen below the fold.
    if (keyboard !== lastKeyboard && messagesEl) {
      requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
    }
    lastKeyboard = keyboard;
  };
  window.visualViewport.addEventListener("resize", update);
  window.visualViewport.addEventListener("scroll", update);
  update();
})();
