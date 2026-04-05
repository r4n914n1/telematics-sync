/**
 * firebase-config.js
 *
 * KAKO DA KONFIGURISEŠES:
 * 1. Idi na https://console.firebase.google.com
 * 2. Napravi projekat → Realtime Database → Start in test mode
 * 3. Project Settings (⚙️) → Your apps → </> → kopiraj vrednosti ovde
 * 4. Zameni sve "TVOJ_..." vrednosti ispod sa stvarnim vrednostima
 */

const firebaseConfig = {
  apiKey: "AIzaSyD-fuXOflfMZDdDolyw5iLNS5Xa-c32bOw",
  authDomain: "apprd-6e6da.firebaseapp.com",
  databaseURL: "https://apprd-6e6da-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "apprd-6e6da",
  storageBucket: "apprd-6e6da.firebasestorage.app",
  messagingSenderId: "714100199134",
  appId: "1:714100199134:web:164ce644edd65df7f67c4f",
  measurementId: "G-RF49F4PNZW"
};

// db je dostupno globalno — null dok Firebase nije konfigurisan
window.db = null;
window.auth = null;

const _isConfigured = !firebaseConfig.apiKey.startsWith("TVOJ");

if (_isConfigured) {
  try {
    firebase.initializeApp(firebaseConfig);
    window.db = firebase.database();
    window.auth = firebase.auth();
    console.info("[Firebase] Konekcija uspešna.");
  } catch (err) {
    console.warn("[Firebase] Greška pri inicijalizaciji:", err.message);
  }
} else {
  console.info("[Firebase] Konfiguracija nije uneta — koriste se statični podaci.");
}

