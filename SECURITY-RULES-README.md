# Firebase Security Rules — এবার সত্যিকারের rules

## ⚠️ Update: দ্বিতীয় দফা অডিটে যা ঠিক করা হলো
প্রথমবার rules লেখার পর পুরো app.js-এর সাথে মিলিয়ে আবার লাইন ধরে ধরে চেক করে
এই বাগগুলো পাওয়া গেছে ও ঠিক করা হয়েছে:

1. **সবচেয়ে গুরুত্বপূর্ণ:** Firebase rules "cascade" করে — কোনো path-এর
   কোনো এক লেভেলে `.write` true হলেই লেখা যায়, তার নিচের আরও কড়া rule
   থাকলেও সেটা পাশ কাটিয়ে যায়। প্রথম ভার্সনে `groups/{code}`-এর একটা broad
   ".write" ছিল যেটা ভেতরের `admins/{key}` (শুধু admin-রাই বদলাতে পারবে)
   আর `members/{key}` (শুধু admin/নিজে) rule-দুটোকে কার্যত অকেজো করে
   দিচ্ছিল — মানে যেকোনো member নিজেকে group-admin বানিয়ে ফেলতে পারতো।
   এখন `groups/{code}`-এর নিজের `.write` শুধু **নতুন গ্রুপ বানানোর** সময়ের
   জন্য; বাকি সব (photo, pinnedMessageId, disappearingSeconds,
   lastActivity, lastSender, members/{key}, admins/{key}) — প্রতিটার
   আলাদা, নির্দিষ্ট rule আছে এখন। একই সমস্যা `messages/{code}`-এও ছিল
   (যেকোনো member অন্য কারো মেসেজ এডিট/ডিলিট করতে পারতো) — সেটাও ঠিক
   করা হয়েছে।
2. Message delete/edit বাটন `isSiteAdmin()`-এও দেখায় (শুধু group-admin না),
   কিন্তু rules শুধু group-admin allow করছিল — site admin-রা নিজেদের
   member না এমন গ্রুপেও মেসেজ মুছতে পারতেন না। ঠিক করা হয়েছে।
3. BetaChat Bot-এর DM আর "সব Admin-কে জানানো" ফিচার — এই দুটোর জন্য
   `groups/{code}`-এ কখনোই `admins` field বসে না (শুধু DM), আর "notify
   admins" ফিচারটা অন্য একজনের bot-DM-এ লেখে — প্রথম rules-এ এসব
   ধরাই ছিল না, মানে **নতুন কোনো signup-এর জন্য DM/Bot চ্যাট তৈরিই হতো
   না**। এখন `isBotChat` ফ্ল্যাগ দিয়ে আলাদাভাবে হ্যান্ডেল করা হয়েছে।
4. Story delete করার সময় `storyReactions/` bulk-remove, আর message
   delete করার সময় `reactions/` bulk-remove — এই দুটোর জন্য কোনো
   `.write` rule-ই ছিল না প্যারেন্ট লেভেলে, তাই মুছতে গেলে ঐ অংশটুকু fail
   করতো (বাকি সব ঠিকই ডিলিট হতো)। যোগ করা হয়েছে।
5. Disappearing message নিজে থেকে মুছে যাওয়ার (client-side cleanup) জন্য
   যে কেউ (শুধু sender/admin না) মুছতে পারার দরকার ছিল — যোগ করা হয়েছে।
6. `appointments/` আগে যেকোনো signed-in ব্যবহারকারী edit/delete করতে
   পারতেন (নতুন request জমা দেওয়ার permission দিতে গিয়ে ভুলবশত পুরো node-ই
   খুলে দেওয়া হয়েছিল) — এখন শুধু নতুন request তৈরি করা open, বাকি
   (status বদলানো ইত্যাদি) শুধু admin।

উপরের কোনোটাই আগে "Publish" করা ভার্সনে test করে ধরা পড়েনি কারণ Rules
Playground-এর নিজস্ব bug-এর জন্য টেস্ট চালানো যায়নি — তাই এই ফাইলটা আবার
নতুন করে replace করে Publish করা দরকার (নিচের ধাপ দেখুন)।

## যা ঠিক করা হলো

### ১. Admin / Verified / Block আর UI দিয়ে না, Firebase rules দিয়ে আটকানো
আগে `admins/`, `verified/`, `blocked/`, `hiddenFromAdmins/` — এই চারটা path
Firebase test-mode-এ ছিল (`.read: true, .write: true`), মানে সাইন-ইন করা যে
কেউ browser console থেকে সরাসরি
```js
firebase.database().ref("admins/nijer_username_key").set(true)
```
চালিয়ে নিজেকে admin বানিয়ে ফেলতে পারতো। এখন এই চারটা path সরাসরি লিখতে
পারবে শুধু ৩টা নির্দিষ্ট owner username key (`ahsanul arifin`, `founder`,
`owner`) — বাকি সবার জন্য `.write: false`। আগে `admin` নামের username-কেও
owner-সমতুল্য ক্ষমতা দেওয়া ছিল rules-এ (যদিও app.js-এর `OWNER_USERNAMES`
লিস্টে সেটা কখনোই ছিল না) — সেই বাড়তি/অসামঞ্জস্যপূর্ণ check এখন সব জায়গা
থেকে সরিয়ে ফেলা হয়েছে।

**নতুন: owner slot claim করা (`usernames/` + `ownerClaimed/`)।** এই তিনটা
owner নাম আগে থেকেই `usernames/` node-এ বসানো (placeholder) থাকে, যাতে
সাধারণ কেউ signup করার সময় এই নাম নিতে না পারে। কিন্তু আসল owner নিজে যখন
ওই একই নাম দিয়ে signup করেন, app.js-এর `doSignUp()` চেক করে
`ownerClaimed/{key}` আছে কিনা — না থাকলে claim করতে দেয় (usernames/-এর
placeholder overwrite করে আসল নাম বসায়, তারপর `ownerClaimed/{key}: true`
সেট করে)। rules নিশ্চিত করে এই write শুধুমাত্র সেই uid-ই করতে পারবে যার
`uids/{uid}` ইতিমধ্যে ওই owner key-এর সাথে map করা, এবং একবার claim হয়ে
গেলে সেটা আর কেউ দ্বিতীয়বার claim/overwrite করতে পারবে না।

সাধারণ admin-রা block/unblock করেন `netlify/functions/admin-block.js`
দিয়ে, যেটা Firebase Admin SDK ব্যবহার করে (service-account credential —
এই rules-গুলো একেবারেই পাশ কাটিয়ে যায়, কারণ সেটা সার্ভারে ID token verify
করে তারপর লেখে)। তাই ওটার জন্য আলাদা কিছু বদলানো লাগেনি।

### ২. Invite code → এখন আর সরাসরি join না, request → approve
`groups/{code}` চিরকাল যে কোনো সাইন-ইন করা মানুষ পড়তে পারবে (কোড দিয়ে
খুঁজে বের করতে হয় বলে), কিন্তু `members/{code}/{key}`-এ এখন সরাসরি নিজেকে
বসিয়ে দেওয়া যাবে না। Invite code দিলে এখন `joinRequests/{code}/{key}`-এ
একটা request জমা হয়; group-এর কোনো Admin সেটা Members প্যানেলে দেখে
Approve/Deny করবেন। Approve করলে তবেই `members/` আর `usergroups/`-এ ঢোকে।

**Blocked user request পাঠাতে পারবে না** — rules-এই আটকানো।

### ৩. আসল চ্যাট কনটেন্ট (`messages/{code}`) এখন শুধু member-রাই পড়তে/লিখতে
পারবে
আগে messages path-ও test-mode-এ খোলা ছিল। এখন কেউ member না হলে ঐ চ্যাটের
একটা মেসেজও পড়তে/লিখতে পারবে না। মেসেজ এডিট/ডিলিট করা যাবে শুধু নিজেরটা,
অথবা group admin (moderation-এর জন্য)।

### ৪. বাকি সব path (friends, stories, presence, typing, reactions...)
প্রতিটাকেই অন্তত "সাইন-ইন করা লাগবে + নিজের ডেটা বা যেটা লেখার কথা সেটাই
লেখা যাবে" — এই লেভেলে বাঁধা হয়েছে, যাতে পুরনো ফিচারগুলো ঠিক আগের মতোই
কাজ করে (যেমন friend-request accept করলে দুইজনের friends/ node-এই লেখা
হয়, story-তে অন্য কেউ reaction/view বসায়) কিন্তু সম্পূর্ণ open আর না থাকে।

## uids/{uid} ম্যাপিং — এই পুরো জিনিসটার ভিত্তি

`myKey()` (username থেকে বানানো key, যেমন `ahsanul_arifin`) আর Firebase
Auth-এর `auth.uid` — এই দুইটা আলাদা জিনিস। Rules-এর ভেতর থেকে
"এই মুহূর্তে সাইন-ইন করা মানুষটা সত্যিই কোন key-এর মালিক" যাচাই করার জন্য
`app.js`-এ একটা ছোট ফাংশন যোগ করা হয়েছে (`ensureUidMapping`), যেটা প্রথমবার
সাইন-ইন/সাইন-আপের সময় `uids/{auth.uid} = myKey()` লিখে রাখে। এই এন্ট্রি
**একবারই** লেখা যায় — rules অনুযায়ী `uids/{uid}` যদি আগে থেকেই থাকে, ওটা
বদলানো যাবে না, তাই কেউ পরে নিজের uid অন্য কারো key-এর দিকে ঘুরিয়ে দিয়ে সেই
মানুষ সাজতে পারবে না।

## Deploy করার ধাপ

1. Firebase Console → আপনার প্রজেক্ট → Build → Realtime Database → Rules ট্যাব
2. `database.rules.json`-এর পুরো কনটেন্ট কপি করে ওখানে পেস্ট করুন
3. **Publish করার আগে** ডান পাশের "Rules Playground" দিয়ে অন্তত এগুলো টেস্ট
   করে দেখুন:
   - সাধারণ (non-owner) user দিয়ে `admins/{কারো_key}` লিখতে চেষ্টা করলে
     Denied আসছে কিনা
   - একজন সাইন-ইন করা user দিয়ে অন্য কারো `groups/{code}/members/{আমার_key}`-এ
     সরাসরি নিজেকে বসাতে চেষ্টা করলে (join request ছাড়া) Denied আসছে কিনা
   - Member না এমন কেউ `messages/{code}`-এ read করতে চেষ্টা করলে Denied
     আসছে কিনা
4. Publish
5. **সাথে সাথেই** ওয়েব অ্যাপে (এবং Android build-এ) `js/app.js`-এর নতুন
   ভার্সনটা deploy করুন — কারণ পুরনো `app.js` এখনো instant-join আর
   `uids/` mapping ছাড়া চালানোর চেষ্টা করবে, যেটা নতুন rules-এর সাথে কাজ
   করবে না।
6. আপনার নিজের owner অ্যাকাউন্ট দিয়ে একবার লগ-আউট → লগ-ইন করে দেখুন সব
   ঠিকঠাক কাজ করছে (Manage Users প্যানেল, Block/Unblock, invite code দিয়ে
   একটা টেস্ট গ্রুপে join request পাঠানো ও approve করা)।

## জেনে রাখা ভালো (সীমাবদ্ধতা)

- `friends/`, `friend_requests/`, `sent_requests/` — দুই পক্ষের যে কেউ
  একে অপরের node-এ লিখতে পারবে (আগের মতোই, অ্যাপের friend-accept ফ্লো এভাবেই
  কাজ করে)। এটা perfect না — কেউ চাইলে request ছাড়াই সরাসরি নিজেকে কারো
  friend বানিয়ে দিতে পারে — কিন্তু এটা নতুন কোনো দুর্বলতা না, আগেও (test-mode-এ)
  এভাবেই সম্ভব ছিল, শুধু এখন বাকি সব path-এর মতো অন্তত auth লাগবে।
- `groups/{code}` মেটাডেটা (নাম, member লিস্ট) যে কোনো সাইন-ইন করা মানুষ
  পড়তে পারবে (invite code lookup-এর জন্য দরকার) — কিন্তু আসল মেসেজ
  (`messages/{code}`) শুধু member-রাই।
- rules test করার পর যদি কোথাও legitimate কাজ Denied দেখায়, সেই নির্দিষ্ট
  path-টা কোথায় আটকাচ্ছে সেটা Playground-এর error থেকে বোঝা যাবে — আমাকে
  বললে সেই অংশটা ঠিক করে দিতে পারবো।
