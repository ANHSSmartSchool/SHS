/* ANHS SMARTSCHOOL - GOOGLE DRIVE CONFIG
   Fill in the two values below (see GOOGLE_DRIVE_SETUP.txt).
   While they still say PASTE_..., the app keeps using Supabase Storage,
   so nothing breaks before Drive is set up. */
window.DRIVE_CONFIG = {
    /* Google Cloud Console > APIs & Services > Credentials > OAuth client ID (Web application) */
    clientId: "1047800559575-im9a1o6ntlg0bj77ujd4p4b1domdne92.apps.googleusercontent.com",

    /* The shared Drive folder where all lesson plans go.
       Open the folder in Drive; the ID is the last part of the URL:
       https://drive.google.com/drive/folders/THIS_PART */
    rootFolderId: "1GY_7iuX8a7N03F9F63V2uhy-Jv2QqfjG",

    /* Optional: your school Google Workspace domain, e.g. "deped.gov.ph".
       Only pre-selects the right account in the sign-in popup. Leave "" to skip. */
    hostedDomain: "",

    /* "drive" lets the app write into the shared folder you created.
       (The narrower "drive.file" cannot write into a folder the app did not create.) */
    scope: "https://www.googleapis.com/auth/drive"
};
