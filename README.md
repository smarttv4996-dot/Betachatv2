# BetaChat — setup guide

This is a real chat app: static HTML/CSS/JS + Firebase Realtime Database for live
messaging. No build step — you can deploy the folder as-is.

## 1. Create a free Firebase project (5 min)

1. Go to https://console.firebase.google.com and click "Add project" (free).
2. Once created, click the **</> (Web)** icon to register a web app.
3. Firebase shows you a `firebaseConfig` object — copy the whole thing.
4. Open `js/config.js` in this folder and paste your values in, replacing the
   placeholders (`YOUR_API_KEY`, etc).

## 2. Turn on the Realtime Database

1. In the Firebase console, left sidebar → **Build → Realtime Database**.
2. Click **Create Database**. Choose a location, then start in **test mode**.
3. Go to the **Rules** tab and set:
   ```json
   {
     "rules": {
       ".read": "auth != null",
       ".write": "auth != null",
       "admins": {
         ".write": "auth != null && (auth.token.email === 'admin@betachat.local' || auth.token.email === 'ahsanularifin@betachat.local')"
       },
       "verified": {
         ".write": "auth != null && (auth.token.email === 'admin@betachat.local' || auth.token.email === 'ahsanularifin@betachat.local')"
       },
       "blocked": {
         ".write": "auth != null && (auth.token.email === 'admin@betachat.local' || auth.token.email === 'ahsanularifin@betachat.local')"
       },
       "userEmails": {
         ".read": true
       },
       "appointments": {
         ".read": "auth != null && (auth.token.email === 'admin@betachat.local' || auth.token.email === 'ahsanularifin@betachat.local')"
       },
       "botConversations": {
         ".read": "auth != null && (auth.token.email === 'admin@betachat.local' || auth.token.email === 'ahsanularifin@betachat.local')"
       }
     }
   }
   ```
   This means only signed-in users (see step 3 below) can read or write —
   much tighter than fully open, though still not enterprise-grade security.
   The `admins`, `verified`, and `blocked` paths are further locked down so
   only the two owner accounts can ever write to them — without this, anyone
   signed in could open the browser console and grant themselves admin,
   verify themselves, or unblock themselves, no matter what the app's UI
   does. If you ever rename the owner accounts, update the two emails above
   to match (the pattern is the username lowercased with spaces and symbols
   stripped, plus `@betachat.local`).

   `userEmails` is deliberately **publicly readable** (not gated behind
   `auth != null` like everything else) — the forgot-password flow needs to
   look up a username's real email *before* the person is signed in, so
   Firebase's Email/Password provider can be told which account to send the
   reset link to. Writing to it still requires being signed in, same as the
   root rule, and the app only ever writes its own entry right after signup.

   `appointments` and `botConversations` are further locked down so only the
   two owner accounts can *read* them — under the plain root rule, any
   signed-in user could technically read every user's bot conversation and
   help request just by opening the browser console, even though the app's
   own "Bot requests" panel UI only shows it to owners/admins. Note this
   only restricts *reading* those two paths; every signed-in user (and the
   bot itself) can still *write* to them, since the root `.write` rule
   already allows that and filing a request/logging a conversation has to
   work for ordinary users.

## 3. Turn on Email/Password sign-in

1. Left sidebar → **Build → Authentication → Get started**.
2. Under **Sign-in method**, enable **Email/Password**.
3. That's it — the app handles the rest. People sign up with a username,
   email, and password; under the hood a real Firebase Auth account is
   created with their email so passwords are stored and checked securely by
   Firebase, never by our own code, and so the password-reset flow below has
   a real address to send to.

   Firebase sends reset emails using its default "Password reset" template —
   Firebase console → **Authentication → Templates** — if you want to
   customize the sender name or wording (e.g. add "BetaChat" branding).

## 4. Deploy to Netlify

1. Zip this whole `betachat-web` folder (or just drag the folder itself).
2. Go to https://app.netlify.com/drop
3. Drag the folder (or the zip) onto the page. Netlify gives you a live URL
   in seconds.
4. Send that URL to whoever you want to chat with. Anyone who opens it can
   type a name and start chatting — no installs, no accounts.

## 5. Install it as a real app (no APK, no Play Store)

The project already includes `manifest.json`, `sw.js`, and an `icons/` folder,
which is everything Chrome needs to treat this as an installable web app
(a "WebAPK") instead of a plain bookmark.

Once it's deployed and you open the Netlify URL in **Chrome on Android**:

1. Tap **⋮** (top right) → **"Add to Home screen"** (Chrome may instead say
   **"Install app"** — same thing).
2. Confirm. Android generates a real app entry: its own icon, its own entry
   in the app drawer and recent-apps switcher, no address bar when opened.
3. Behind the scenes Chrome actually builds a small APK for this on your
   device — that's the exact mechanism behind apps installed this way.

On iPhone (Safari): Share icon → "Add to Home Screen" gives the same
standalone, full-screen behavior, though iOS doesn't generate an APK-style
package the way Android does.

Note: `sw.js` here is intentionally a no-op — it doesn't cache anything, so
every request still goes straight to Firebase and live chat works exactly
as before. It exists purely to satisfy Chrome's installability check.

## Friends: send, accept, decline

There's now a 👥 button in the sidebar (with a red dot when you have
pending requests) that opens the Friends panel:

- **Add a friend** by username at the top — sends them a request.
- **Requests tab**: incoming requests you can Accept or Decline, and your
  own sent requests (Cancel to withdraw one before it's answered).
- **Friends tab**: everyone who's accepted, with quick **Message** (opens/
  starts a DM) and **Remove** actions.

Data model, in case you want to extend it:
- `friend_requests/{toKey}/{fromKey}` — incoming requests, keyed by recipient
- `sent_requests/{fromKey}/{toKey}` — a mirror so the sender can see their
  own pending list without having to scan every other user's requests
- `friends/{key}/{otherKey}` — written to *both* people's nodes on accept,
  since a friendship is symmetric

Like group admins, this is enforced in the UI only — the Firebase rules
still just check `auth != null`. Someone could technically write directly
to `friends/{their-key}/{anyone}` and grant themselves a friendship. Not a
concern for a casual app, but worth knowing if this ever needs to be
tamper-proof.

## What's new: edit, status, admins, dark mode, search, notifications

- **Edit messages**: ✏️ on your own messages lets you fix a typo in place;
  edited messages get a small "edited" tag. (Editing an image/file message
  edits its caption.)
- **Status**: set a short status line (e.g. "at the gym") in Edit Profile —
  shows next to your name in the members list.
- **Group admins**: whoever creates a group is its first admin. Admins can
  promote/demote other admins and remove members from the ☰ members list.
  Note: this is enforced in the UI only, not in Firebase security rules —
  see the note in "Where this could break" below. Existing groups made
  before this update have no admins recorded, so admin controls stay
  hidden there until you recreate the group.
- **Dark / light mode**: 🌙/☀️ toggle in the sidebar, remembered per browser.
- **Message search**: 🔍 in the chat header filters the currently-loaded
  messages in that chat by text or filename.
- **Desktop notifications**: 🔕/🔔 in the sidebar requests browser
  notification permission; you'll get a native notification for new
  messages in chats you're not currently looking at (tab hidden or a
  different chat open).

### Where this could break
Group admin controls are UI-only — the Firebase rules still only check
`auth != null`, so a technically-savvy member could still write to
`groups/{code}/members` directly. If this app ever holds anything
sensitive, that's the next thing to lock down with real per-path rules
(e.g. only allow removing `members/{key}` if the requester's key exists
under `groups/{code}/admins`).

### Not built yet (flagged, not forgotten)
- **Online activity feed** — needs a decision on what counts as an
  "activity" worth surfacing (came online? joined a group? changed photo?)
  and a dedicated feed view.

## Bug fix: "online" status stuck after signing out

Presence relied entirely on Firebase's own `onDisconnect()`, which only
fires once it detects the realtime connection actually drop. A normal
sign-out doesn't close that connection — the tab usually stays open — so
someone could sign out and still show as "online" indefinitely. Signing
out now explicitly writes `offline` before the auth session ends (writes
need to happen while still authenticated, so this happens right before
`signOut()`, not after). A `beforeunload` handler does the same
best-effort for plain tab closes, on top of the existing server-side
`onDisconnect` safety net.

## Bug fixes (layout, images, files, grouping)

- **Text wrapping**: bubbles were sized with `max-width: 60%` against an
  ancestor whose own width was itself shrink-to-fit — an undefined
  percentage basis, which browsers can resolve to ~0 and cause every word
  to wrap onto its own line. Bubbles now use `max-width: min(60vw, 480px)`,
  which is always well-defined, plus gentler `overflow-wrap` instead of
  forced `word-break`.
- **Oversized images**: `.msg-image` is now capped with `max-width: 100%` /
  `max-height: 300px` against the bubble's own (now well-defined) width, so
  a full-resolution photo can't blow out the layout.
- **Photo preview**: clicking a sent photo opens a proper full-screen
  lightbox (click or Esc to close) instead of a broken overlay.
- **File attachments**: added a 📎 button for sending non-image files
  (PDF, docs, etc, up to ~700KB). Filenames are kept as plain JS/UTF-8
  strings throughout — no manual `encodeURIComponent`/byte-slicing, which
  is what was corrupting non-Latin filenames (e.g. Bengali) into `%` signs.
- **Consecutive messages**: messages from the same sender sent within 5
  minutes of each other now group together under a single sender header
  instead of repeating it every time.
- **Hover jitter**: the reaction/delete buttons are now positioned
  absolutely next to the bubble instead of sitting inline in the flex row,
  so revealing them on hover no longer shifts surrounding messages.

## What's new: reactions, photos, delete, group photo & members

- **Emoji reactions**: hover a message (or tap it on mobile) and click the 🙂
  icon to react. Tap an existing reaction pill to add/remove your own.
- **Send photos**: the 🖼 button next to the message box lets you send a
  photo (optionally with a caption typed in the message box first). Images
  are resized in the browser before sending.
- **Delete messages**: hover your own message and click 🗑. It's replaced
  with "Message deleted" for everyone (soft delete, not un-sendable-style
  removal, to keep the conversation flow intact).
- **Group photo**: in a group chat (not a DM), click the avatar in the chat
  header to set a group photo.
- **Members list**: click the ☰ icon in a group chat header to see everyone
  in the chat with their current name/photo.

All of this rides on the same `profiles/` layer from before — no new
Firebase rules needed, since the root `auth != null` rule already covers
these new data paths (`reactions/`, and the `photo`/`deleted`/`image`
fields on existing paths).

## Profiles (display name + photo)

Anyone can tap their avatar (or "Edit profile") in the sidebar to set a
**display name** and **profile photo**. A few notes:

- Your **login username** (used to sign in) never changes — the display
  name is just a cosmetic layer shown to other people, like a nickname.
- Photos are resized to a small square in the browser and stored as the
  chat's data (no Firebase Storage bucket needed) — fine for casual use,
  but keep photos simple since the free database plan has storage caps.
- Changes show up live everywhere: chat list, message bubbles, chat headers.

## Stories (24hr disappearing updates) & Profile pages

- **Stories**: the row of circles above "+ New chat" shows your story (add a
  📷 photo or an "Aa" text card) and stories from your friends. Tap a circle
  to view full-screen — tap the right/left edge to move forward/back, tap ✕
  or press Esc to close. Stories auto-expire 24 hours after posting; expired
  ones just stop showing up (filtered client-side, plus a best-effort
  self-cleanup of your own expired stories on load, since the free Firebase
  plan has no server-side TTL/cloud functions to expire them for you).
  Tap your own active story to see a view count and delete it early.
  Data model: `stories/{authorKey}/{storyId}` = `{ authorName, ts,
  expiresAt, type: 'photo'|'text', image?, text?, bg?, viewers: {key:true} }`.
  Only friends' stories appear in the bar, same audience as the rest of the
  friends system — like everything else here, this is enforced in the UI
  only, not in Firebase rules.

- **Story reactions**: while viewing someone else's story, a row of emoji
  (❤️ 😂 😮 😢 👍 🔥) appears at the bottom — tap one to react, tap it again
  to remove it, or tap a different emoji to switch (one reaction per person
  per story). Viewing your *own* story shows a read-only summary instead
  (e.g. "❤️ 3  😂 1"), with a hover tooltip on each pill listing who reacted.
  Data model: `storyReactions/{authorKey}/{storyId}/{viewerKey}` =
  `{ emoji, name, ts }` — again UI-only enforcement, same as the rest of the
  stories feature.

- **Profile pages**: tap anyone's avatar or name — in a DM header, the
  members list, or the friends list — to open their profile: photo, display
  name, username, status, bio, a friend count, and a grid of their currently
  active story photos (tap one to view it full-screen). From there you can
  message them or send a friend request. Edit your own bio from "Edit
  profile" (⚙️) alongside your existing name/photo/status.



- Each person creates a real account: username + password, checked by
  Firebase Authentication (not our own code).
- Each chat has a random invite **code**. Share the code with someone so they
  can join your chat.
- Messages sync live through Firebase — no page refresh needed.
- Sessions persist — once signed in, you stay signed in on that browser
  until you tap "Sign out."

## Owners, admins, verified badges & blocking

There are two permanent **owner** accounts — `admin` and `ahsanul arifin`.
Owners can never be removed, demoted, or blocked, and only owners see the
"Manage users" (🛡️) button in the sidebar. From that panel an owner can, for
any other user:

- **Make/remove admin** — admins can delete any message or story (like
  owners), and automatically get the verified badge.
- **Verify/unverify** — shows the blue checkmark badge next to their name,
  independent of admin status.
- **Block/unblock** — a blocked user can still log in and browse, but their
  message box is disabled and any attempt to send is rejected, both in the
  UI and (if you applied the rules above) server-side.

This only works as real security if you applied the tightened `admins` /
`verified` / `blocked` rules in step 2 above — otherwise these are
client-side conveniences only, and a technical user could bypass them from
the browser console.

## Help bot: escalating to Admins

Every user gets a permanent DM with **BetaChat Bot**, which answers common
questions (friend requests, groups, stories, verified badges, blocking) with
simple keyword matching.

- **Asking directly**: typing "talk to admin" / "contact owner" (or the
  Bengali equivalents) always files a help request right away.
- **When the bot can't help**: instead of just apologizing, the bot now asks
  whether it should pass the question on to the Admins ("চাইলে কি এই
  প্রশ্নটি সব Admin-কে জানিয়ে দেব? হ্যাঁ/না"). Replying "হ্যাঁ"/"yes" files
  the same kind of request using the original question; replying "না"/"no"
  just drops it.
- Either way, the request is logged under `appointments/` and **every**
  current Admin and Owner — not just the two hardcoded owner accounts — gets
  a notice in their own bot DM and can open the 🤖 **Bot requests** panel
  (now visible to Admins too, not owner-only) to see the request, a preview
  of the conversation so far, and jump straight into that user's chat to
  help. Marking a request "Resolved" records which Admin/Owner resolved it,
  so the Owner has a full audit trail of who asked what, who stepped in, and
  what was said — without needing to open every chat individually.

## Limits to know about

- **Anyone with a chat's code can join it** — invite codes aren't private
  links, they're more like a shared room key.
- **Password reset**: on the sign-in screen, "Forgot password?" asks for a
  username, looks up the email they signed up with (`userEmails/{key}`), and
  sends Firebase's standard password-reset email to it. Only works for
  accounts created after this feature was added, since older accounts were
  never given a real email (they used a synthetic `username@betachat.local`
  address Firebase can't actually deliver mail to) — those users need an
  Admin's help via the BetaChat Bot instead. Email is now a **required**
  field at signup for this reason.
- **No push notifications** — people only see new messages while the tab is open.
- **Free tier limits** — Firebase's free ("Spark") plan is generous for testing
  with friends, but has caps on simultaneous connections and data transfer.

If you want this locked down properly later (real accounts, private chats,
push notifications), that's a good next step to build out with Claude Code.
