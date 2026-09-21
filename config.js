// 1. Go to https://console.firebase.google.com and create a free project.
// 2. Inside the project, click "Add app" -> Web (</>) and register it.
// 3. Firebase will show you a config object like the one below. Copy yours in here.
// 4. In the left menu go to Build -> Realtime Database -> Create Database (start in test mode).
// 5. Save this file, then re-zip the folder and re-upload to Netlify.

const firebaseConfig = {
  apiKey: "AIzaSyBKzfgBE5nOaGT2w_GjlvJBq8hqLNERwlo",
  authDomain: "betachat-v2.firebaseapp.com",
  databaseURL: "https://betachat-v2-default-rtdb.firebaseio.com",
  projectId: "betachat-v2",
  storageBucket: "betachat-v2.firebasestorage.app",
  messagingSenderId: "105097045462",
  appId: "1:105097045462:web:af935a4075043edc127077",
  measurementId: "G-ZYHG6XZTX2"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
