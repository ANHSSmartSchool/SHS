/* ==================================
   ANHS SMARTSCHOOL - FIREBASE CONFIGURATION
   ==================================
   Firebase project: anhssmartschool
*/

const firebaseConfig = {
    apiKey: "AIzaSyBVImAHbkEeSlXIxiy5F6Bd6vEa1-hv59s",
    authDomain: "anhssmartschool.firebaseapp.com",
    projectId: "anhssmartschool",
    storageBucket: "anhssmartschool.firebasestorage.app",
    messagingSenderId: "1047800559575",
    appId: "1:1047800559575:web:42e76492cada7a6064fd92",
    measurementId: "G-1MYX37RZ8X"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Firebase Analytics (uses the supplied measurementId)
if (typeof firebase.analytics === "function") {
    const analytics = firebase.analytics();
}

// Firebase services used by ANHS SmartSchool
const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();
