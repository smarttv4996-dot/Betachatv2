// Netlify serverless function: when the built-in keyword-matching bot
// (botReplyFor in js/app.js) can't answer something, the client calls this
// as a smarter fallback before offering to escalate to an admin.
//
// Uses Anthropic's Messages API with a system prompt describing BetaChat's
// actual feature set, so answers are grounded in what the app can really do
// instead of the model inventing features that don't exist.
//
// Request body (JSON): { question, userName }
// Response (JSON): { answer, needsAdmin }
//   needsAdmin is true when the model itself decides this genuinely needs a
//   human (account-specific issues, bugs, anything it can't resolve by
//   explaining a feature) — the client falls back to the existing
//   escalate-to-admin flow in that case.

const SYSTEM_PROMPT = `তুমি "BetaChat Bot" — BetaChat নামের একটা চ্যাট অ্যাপের সহায়ক বট। ব্যবহারকারীদের প্রশ্নের সংক্ষিপ্ত, বন্ধুত্বপূর্ণ উত্তর দাও।

অ্যাপের ফিচারসমূহ (শুধু এগুলো নিয়েই কথা বলবে, নতুন কিছু বানিয়ে বলবে না):
- Friends: profile থেকে বা username দিয়ে খুঁজে "Add friend" চাপা যায়
- Groups: "+ New chat" থেকে group বানানো বা code দিয়ে join করা যায়
- Stories: sidebar-এর "Add story" থেকে ছবি/টেক্সট স্টোরি দেওয়া যায়, ২৪ ঘণ্টা পর মুছে যায়
- Verified badge (নীল টিক): শুধু owner দিতে পারে
- Admin: message/story delete করতে পারে, সাধারণ user block করতে পারে; শুধু owner নতুন admin বানাতে/সরাতে পারে
- Block: block হলে login করা যায় কিন্তু message পাঠানো যায় না, কারণসহ দেখানো হয়
- Chat wallpaper: প্রতিটা চ্যাটের উপরে 🎨 বাটন দিয়ে theme বা নিজের ছবি wallpaper হিসেবে বসানো যায়
- Disappearing messages: চ্যাট হেডারের ⏱ বাটন দিয়ে on/off করা যায় (1 ঘণ্টা/24 ঘণ্টা/7 দিন)
- Message reply: মেসেজে ↩️ বাটন চেপে reply/quote করা যায়
- Message pin: মেসেজে 📌 বাটন চেপে pin করা যায়, চ্যাটের উপরে দেখা যায়
- App lock (শুধু Android app-এ): profile settings-এ fingerprint/face lock on করা যায়
- Push notification: নতুন মেসেজ এলে notification আসে (Android app-এ)

নিয়ম:
- উত্তর সংক্ষিপ্ত রাখো (২-৪ বাক্য)
- ব্যবহারকারী যে ভাষায় লিখেছে (বাংলা/ইংরেজি) সেই ভাষাতেই উত্তর দাও
- অ্যাপের ফিচার নিয়ে প্রশ্ন হলে উপরের তথ্য দিয়ে সরাসরি উত্তর দাও
- যদি প্রশ্নটা account-specific সমস্যা (যেমন "আমাকে ভুল করে block করা হয়েছে", "আমার account হ্যাক হয়েছে"), bug report, বা এমন কিছু যা তুমি সমাধান করতে পারবে না — তাহলে NEEDS_ADMIN দিয়ে শুরু করে ছোট করে বলো কেন admin দরকার
- সাধারণ gossip/অপ্রাসঙ্গিক প্রশ্নে ভদ্রভাবে জানাও তুমি শুধু BetaChat নিয়ে সাহায্য করতে পারো`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Not configured yet — tell the client to fall back gracefully.
    return { statusCode: 200, body: JSON.stringify({ answer: null, needsAdmin: true }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: "Invalid JSON body" };
  }

  const { question, userName } = payload;
  if (!question) {
    return { statusCode: 400, body: "Missing question" };
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `${userName || "একজন ব্যবহারকারী"} জিজ্ঞেস করেছেন: ${question}` }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { statusCode: 200, body: JSON.stringify({ answer: null, needsAdmin: true, debug: errText.slice(0, 200) }) };
    }

    const data = await res.json();
    const text = (data.content || []).map((b) => b.text || "").join("").trim();
    const needsAdmin = text.startsWith("NEEDS_ADMIN");
    const answer = needsAdmin ? text.replace(/^NEEDS_ADMIN[:\s]*/, "") : text;

    return { statusCode: 200, body: JSON.stringify({ answer: answer || null, needsAdmin: needsAdmin || !answer }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ answer: null, needsAdmin: true, error: err.message }) };
  }
};
