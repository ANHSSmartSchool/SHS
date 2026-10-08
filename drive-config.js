/* ANHS SMARTSCHOOL - GOOGLE DRIVE CONFIG
   Fill in the two values below (see GOOGLE_DRIVE_SETUP.txt).
   While they still say PASTE_..., the app keeps using Supabase Storage,
   so nothing breaks before Drive is set up. */
window.DRIVE_CONFIG = {
    /* Google Cloud Console > APIs & Services > Credentials > OAuth client ID (Web application) */
    clientId: "PASTE_YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com",

    /* The shared Drive folder where all lesson plans go.
       Open the folder in Drive; the ID is the last part of the URL:
       https://drive.google.com/drive/folders/THIS_PART */
    rootFolderId: "PASTE_YOUR_DRIVE_FOLDER_ID",

    /* Optional: your school Google Workspace domain, e.g. "deped.gov.ph".
       Only pre-selects the right account in the sign-in popup. Leave "" to skip. */
    hostedDomain: "",

    /* "drive" lets the app write into the shared folder you created.
       (The narrower "drive.file" cannot write into a folder the app did not create.) */
    scope: "https://www.googleapis.com/auth/drive"
};
