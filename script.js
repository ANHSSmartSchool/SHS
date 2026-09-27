/* ==================================
   ANHS SMARTSCHOOL JAVASCRIPT
================================== */


/* ================================
   LOGIN / AUTHENTICATION
================================ */

/* Accounts now live in Supabase:
   - Supabase Authentication holds the email + password.
   - A matching Supabase document in the "users" collection
     (doc ID = the account's Auth UID) holds the profile info
     below: role, name, title, initials, grade, section.
   See FIREBASE_SETUP.txt for exactly how to create one.
   Teacher accounts see a reduced menu (see ADMIN_ONLY_PAGES)
   and can only see and upload their own lesson plans (see
   applyLessonPlanVisibility). The "name" field is what ties a
   teacher account to their rows in the Lesson Plan table /
   Teacher Name dropdown - keep it identical in both places. */

let currentUser = null;
const loginPasswordInput = document.getElementById("loginPassword");

/* ---- Screen switching + role handling ----
   (The original script referenced these but never defined them, so a
   successful sign-in crashed with "applyUserRole is not defined".) */

const loginPageEl = document.getElementById("loginPage");
const appShellEl = document.getElementById("app");

/* Pages a teacher account may not open. */
const RESTRICTED_TEACHER_PAGES = ["teachers", "submissiontracker", "settings"];
/* Pages only a full admin may open (hidden for department heads too). */
const ADMIN_ONLY_PAGES = ["settings"];

function roleLabel(role) {
    if (role === "admin") return "School Admin";
    if (role === "department_head") return "Department Head";
    return "Teacher";
}

function applyUserRole(account) {

    const displayName = account.name || account.email || "User";
    const title = account.title || roleLabel(account.role);

    ["sidebarUserName", "topbarUserName"].forEach(function(id) {
        const el = document.getElementById(id);
        if (el) el.textContent = displayName;
    });

    ["sidebarUserRole", "topbarUserRole"].forEach(function(id) {
        const el = document.getElementById(id);
        if (el) el.textContent = title;
    });

    applyAccountAvatar(account);

    if (typeof pageNames !== "undefined" && pageNames.dashboard) {
        pageNames.dashboard.subtitle = "Welcome back, " + displayName + "!";
    }

    const isTeacher = account.role === "teacher";
    const isAdmin = account.role === "admin";

    const navRules = {
        navTeachers: isTeacher,
        navSubmissionTracker: isTeacher,
        navSettings: !isAdmin
    };

    Object.keys(navRules).forEach(function(id) {
        const el = document.getElementById(id);
        if (el) el.classList.toggle("hidden", navRules[id]);
    });

    const addTeacher = document.getElementById("addTeacherBtn");
    if (addTeacher) addTeacher.classList.toggle("hidden", !isAdmin);

}

function showApp() {
    if (loginPageEl) loginPageEl.classList.add("hidden");
    if (appShellEl) appShellEl.classList.remove("hidden");
}

async function showLoginPage() {

    try { await supabaseClient.auth.signOut(); } catch (err) { console.error("Sign-out failed:", err); }

    stopDataListeners();
    currentUser = null;

    if (appShellEl) appShellEl.classList.add("hidden");
    if (loginPageEl) loginPageEl.classList.remove("hidden");

    closePasswordModal();

    if (loginPasswordInput) loginPasswordInput.value = "";
    if (typeof loginError !== "undefined" && loginError) loginError.classList.remove("show");

}


/* ---- Change password (any signed-in account) ----
   Also used after someone clicks the "Forgot password" email link:
   Supabase signs them in for that visit and this dialog lets them
   set the new password. */

const passwordModal = document.getElementById("passwordModal");
const passwordForm = document.getElementById("passwordForm");
const passwordError = document.getElementById("passwordError");
const MIN_PASSWORD_LENGTH = 8;
let recoveryPending = /type=recovery/.test(window.location.hash);

function openPasswordModal(fromRecovery) {
    if (!passwordModal) return;
    if (passwordForm) passwordForm.reset();
    if (passwordError) { passwordError.textContent = ""; passwordError.classList.remove("show"); }
    document.getElementById("passwordModalTitle").textContent = fromRecovery ? "Set Your New Password" : "Change Password";
    document.getElementById("passwordModalHint").textContent = fromRecovery
        ? "You opened a password reset link. Choose a new password to finish."
        : "Choose a new password for your account.";
    passwordModal.classList.add("show");
    const first = document.getElementById("newPassword");
    if (first) first.focus();
}

function closePasswordModal() {
    if (passwordModal) passwordModal.classList.remove("show");
    if (passwordForm) passwordForm.reset();
}

function showPasswordError(message) {
    if (!passwordError) return;
    passwordError.textContent = message;
    passwordError.classList.add("show");
}

const changePasswordBtn = document.getElementById("changePasswordBtn");
if (changePasswordBtn) changePasswordBtn.addEventListener("click", function() {
    if (!currentUser) return;
    openPasswordModal(false);
});

["closePasswordModal", "cancelPasswordModal"].forEach(function(id) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", closePasswordModal);
});

if (passwordModal) passwordModal.addEventListener("click", function(event) {
    if (event.target === passwordModal) closePasswordModal();
});

if (passwordForm) passwordForm.addEventListener("submit", async function(event) {

    event.preventDefault();

    const newPassword = document.getElementById("newPassword").value;
    const confirmPassword = document.getElementById("confirmPassword").value;

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
        return showPasswordError("Password must be at least " + MIN_PASSWORD_LENGTH + " characters.");
    }

    if (newPassword !== confirmPassword) {
        return showPasswordError("The two passwords do not match.");
    }

    const saveBtn = document.getElementById("savePasswordBtn");
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving..."; }

    try {

        const { error } = await supabaseClient.auth.updateUser({ password: newPassword });
        if (error) throw error;

        closePasswordModal();
        alert("Your password has been changed.");

    } catch (err) {

        console.error("Could not change password:", err);
        showPasswordError(err && err.message ? err.message : "Sorry, the password couldn't be changed. Please try again.");

    } finally {

        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save Password"; }

    }

});


/* ================================
   TEACHERS / LESSON PLANS - FIRESTORE
   LIVE DATA (replaces the old in-page
   demo rows so the roster and every
   submission are saved for real and
   shared across every device/account).
================================ */

let teachersCache = [];
let lessonPlansCache = [];
let teachersUnsubscribe = null;
let lessonPlansUnsubscribe = null;


function escapeHtml(value) {

    return String(value === null || value === undefined ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

}


/* Starts (or restarts) the two live Supabase listeners.
   Called once a user is signed in. Every other teacher/admin
   signed in at the same time gets the same updates in real
   time, which is what makes submissions "shared" instead of
   living only in one browser's memory. */

function startDataListeners() {
    if (teachersUnsubscribe) supabaseClient.removeChannel(teachersUnsubscribe);
    if (lessonPlansUnsubscribe) supabaseClient.removeChannel(lessonPlansUnsubscribe);
    teachersUnsubscribe = supabaseClient.channel("teachers-live")
        .on("postgres_changes", { event: "*", schema: "public", table: "teachers" }, loadTeachers)
        .subscribe();
    lessonPlansUnsubscribe = supabaseClient.channel("lessonplans-live")
        .on("postgres_changes", { event: "*", schema: "public", table: "lesson_plans" }, loadLessonPlans)
        .subscribe();
    loadTeachers();
    loadLessonPlans();
}

async function loadTeachers() {
    const { data, error } = await supabaseClient.from("teachers").select("*").order("name", { ascending: true });
    if (error) { console.error("Could not load the teacher roster:", error); return; }
    teachersCache = (data || []).map(t => Object.assign({}, t, { postGrad:t.post_grad, createdBy:t.created_by, createdAt:t.created_at }));
    renderTeacherTable(); populateLessonTeacherOptions(); renderTeacherComplianceWidget(); renderSubmissionTracker(); updateDashboardCounts(); updateComplianceDashboard();
}

async function loadLessonPlans() {
    const { data, error } = await supabaseClient.from("lesson_plans").select("*").order("submitted_at", { ascending: false });
    if (error) { console.error("Could not load lesson plan submissions:", error); return; }
    lessonPlansCache = (data || []).map(plan => Object.assign({}, plan, {
        submittedAt:plan.submitted_at, dueAt:plan.due_at, fileName:plan.file_name, fileIcon:plan.file_icon,
        storagePath:plan.storage_path, fileURL:plan.file_url || null, createdBy:plan.created_by, createdAt:plan.created_at,
        sectionText:plan.section_text || "", hasFile:!!plan.storage_path
    }));
    renderLessonPlanTable(); renderTeacherComplianceWidget(); renderSubmissionTracker(); updateDashboardCounts(); updateComplianceDashboard();
}

function stopDataListeners() {
    if (teachersUnsubscribe) supabaseClient.removeChannel(teachersUnsubscribe);
    if (lessonPlansUnsubscribe) supabaseClient.removeChannel(lessonPlansUnsubscribe);
    teachersUnsubscribe = null; lessonPlansUnsubscribe = null; teachersCache = []; lessonPlansCache = [];
}

async function loadUserProfile(user) {
    const { data: profile, error } = await supabaseClient.from("profiles").select("*").eq("id", user.id).maybeSingle();
    if (error) { console.error("Could not load user profile:", error); return null; }
    if (!profile) return null;
    return { uid:user.id, username:user.email, email:user.email, role:profile.role, name:profile.name, title:profile.title,
        initials:profile.initials, grade:profile.grade, section:profile.section, photoURL:profile.photo_url || null };
}

let resumedSession = false;
supabaseClient.auth.onAuthStateChange(function(event, session) {
    if (event === "PASSWORD_RECOVERY") {
        recoveryPending = true;
        if (currentUser) { recoveryPending = false; openPasswordModal(true); return; }
    }
    if (!session || currentUser || resumedSession) return;
    resumedSession = true;
    setTimeout(async function() {
        const account = await loadUserProfile(session.user);
        if (!account) return;
        currentUser = account; applyUserRole(account); startDataListeners(); showApp(); showPage("dashboard");
        if (recoveryPending) { recoveryPending = false; openPasswordModal(true); }
    }, 0);
});

const forgotPasswordLink = document.querySelector(".forgot-link");
if (forgotPasswordLink) forgotPasswordLink.addEventListener("click", async function(event) {
    event.preventDefault();
    const email = document.getElementById("loginUsername")?.value.trim();
    if (!email) return alert("Enter your email address first, then click Forgot password.");
    try {
        const redirectTo = window.location.origin + window.location.pathname;
        const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) throw error;
        alert("Password reset instructions have been sent if the account exists.");
    } catch (err) { console.error(err); alert("We could not start the password reset. Check the Supabase Auth settings."); }
});


/* ================================
   PROFILE PICTURE & SCHOOL LOGO
   UPLOAD (stored in Supabase Storage
   and linked from Supabase, so the
   same picture shows on every device)
================================ */

const avatarUploadInput =
    document.getElementById("avatarUploadInput");

const logoUploadInput =
    document.getElementById("logoUploadInput");


function readImageFile(file, callback) {

    if (!file) return;

    if (!file.type || !file.type.startsWith("image/")) {

        alert("Please choose an image file.");
        return;

    }

    callback(file);

}


function setAvatarDisplay(el, imageUrl, initials) {

    if (!el) return;

    if (imageUrl) {

        el.style.backgroundImage = "url(\"" + imageUrl + "\")";
        el.classList.add("has-image");
        el.textContent = "";

    } else {

        el.style.backgroundImage = "";
        el.classList.remove("has-image");
        el.textContent = initials || "";

    }

}


function applyAccountAvatar(account) {

    setAvatarDisplay(document.getElementById("sidebarAvatar"), account.photoURL, account.initials);
    setAvatarDisplay(document.getElementById("topbarAvatar"), account.photoURL, account.initials);

}


function setLogoDisplay(imageUrl) {

    const logos = [
        document.getElementById("loginBrandLogo"),
        document.getElementById("sidebarBrandLogo")
    ];

    logos.forEach(function(el) {

        if (!el) return;

        if (imageUrl) {

            el.style.backgroundImage = "url(\"" + imageUrl + "\")";
            el.classList.add("has-image");

        } else {

            el.style.backgroundImage = "";
            el.classList.remove("has-image");

        }

    });

}


/* The school logo is shared by everyone, so it's loaded from
   Supabase as soon as the page opens, even before anyone logs
   in (the login page shows it too). */

async function applyStoredLogo() {

    try {

        const { data, error } = await supabaseClient.from("settings").select("logo_url").eq("id", "school").maybeSingle();
        if (error) throw error;
        if (data && data.logo_url) setLogoDisplay(data.logo_url);

    } catch (err) {

        console.error("Could not load school logo:", err);

    }

}


/* Clicking either avatar opens the file picker for a new
   profile picture, saved for the currently signed-in account. */

["sidebarAvatar", "topbarAvatar"].forEach(function(id) {

    const el = document.getElementById(id);

    if (el && avatarUploadInput) {

        el.addEventListener("click", function() {

            if (!currentUser) return;

            avatarUploadInput.click();

        });

    }

});


if (avatarUploadInput) {

    avatarUploadInput.addEventListener("change", function(event) {

        const file = event.target.files[0];

        readImageFile(file, async function(imageFile) {

            if (!currentUser) return;

            try {

                const path = currentUser.uid + "/avatar";
                const { error: uploadError } = await supabaseClient.storage.from("avatars").upload(path, imageFile, { upsert:true, contentType:imageFile.type });
                if (uploadError) throw uploadError;
                const { data: publicData } = supabaseClient.storage.from("avatars").getPublicUrl(path);
                const url = publicData.publicUrl;
                const { error: profileError } = await supabaseClient.from("profiles").update({ photo_url:url }).eq("id", currentUser.uid);
                if (profileError) throw profileError;

                currentUser.photoURL = url;

                applyAccountAvatar(currentUser);

            } catch (err) {

                console.error("Could not upload profile picture:", err);

                alert("Sorry, that picture couldn't be uploaded. Please try again.");

            }

        });

        avatarUploadInput.value = "";

    });

}


/* Clicking the ANHS SmartSchool icon (login page or sidebar)
   opens the file picker for a new school logo, shared by
   every account. */

["loginBrandLogo", "sidebarBrandLogo"].forEach(function(id) {

    const el = document.getElementById(id);

    if (el && logoUploadInput) {

        el.classList.add("editable-logo");

        el.addEventListener("click", function() {

            logoUploadInput.click();

        });

    }

});


if (logoUploadInput) {

    logoUploadInput.addEventListener("change", function(event) {

        const file = event.target.files[0];

        readImageFile(file, async function(imageFile) {

            try {

                const path = "school-logo";
                const { error: uploadError } = await supabaseClient.storage.from("school-assets").upload(path, imageFile, { upsert:true, contentType:imageFile.type });
                if (uploadError) throw uploadError;
                const { data: publicData } = supabaseClient.storage.from("school-assets").getPublicUrl(path);
                const url = publicData.publicUrl;
                const { error: settingsError } = await supabaseClient.from("settings").upsert({ id:"school", logo_url:url }, { onConflict:"id" });
                if (settingsError) throw settingsError;

                setLogoDisplay(url);

            } catch (err) {

                console.error("Could not upload school logo:", err);

                alert("Sorry, that logo couldn't be uploaded. Please try again.");

            }

        });

        logoUploadInput.value = "";

    });

}


applyStoredLogo();


if (togglePassword) {

    togglePassword.addEventListener("click", function() {

        const isPassword =
            loginPasswordInput.type === "password";

        loginPasswordInput.type =
            isPassword
                ? "text"
                : "password";

        this.innerHTML =
            isPassword
                ? '<i class="fa-regular fa-eye-slash"></i>'
                : '<i class="fa-regular fa-eye"></i>';

    });

}


if (loginForm) {

    loginForm.addEventListener(
        "submit",
        async function(event) {

            event.preventDefault();


            const email =
                document.getElementById(
                    "loginUsername"
                ).value.trim();

            const password =
                loginPasswordInput.value;


            loginError.classList.remove("show");


            try {

                const { data: authData, error: authError } = await supabaseClient.auth.signInWithPassword({ email, password });
                if (authError) throw authError;

                const account =
                    await loadUserProfile(authData.user);

                if (!account) {

                    loginError.textContent =
                        "No profile found for this account. Ask your admin to finish setting it up in Supabase.";

                    loginError.classList.add("show");

                    await supabaseClient.auth.signOut();

                    return;

                }

                currentUser = account;

                applyUserRole(account);

                startDataListeners();

                showApp();

                showPage("dashboard");

            } catch (err) {

                console.error("Login failed:", err);

                const msg = String((err && err.message) || "");
                const isCredentialError =
                    err && (err.name === "AuthApiError" || err.status === 400) &&
                    /invalid login credentials/i.test(msg);

                if (isCredentialError) {
                    loginError.textContent = "Invalid email or password.";
                } else if (err && /confirm/i.test(msg)) {
                    loginError.textContent = "Please confirm your email first.";
                } else if (/fetch|network/i.test(msg)) {
                    loginError.textContent = "Cannot reach Supabase. Check supabase-config.js.";
                } else {
                    loginError.textContent = "Signed in, but the app failed to load: " + msg;
                }

                loginError.classList.add("show");

            }

        }
    );

}


/* ================================
   PAGE NAVIGATION
================================ */

const navItems = document.querySelectorAll(".nav-item");
const pages = document.querySelectorAll(".page");

const pageTitle = document.getElementById("pageTitle");
const pageSubtitle = document.getElementById("pageSubtitle");

const pageNames = {

    dashboard: {
        title: "Dashboard",
        subtitle: "Welcome back, Administrator!"
    },

    teachers: {
        title: "Teachers",
        subtitle: "Manage faculty information and assignments."
    },

    submissiontracker: {
        title: "Submission Tracker",
        subtitle: "Monitor every teacher's lesson-plan compliance for the selected week."
    },

    lessonplans: {
        title: "Lesson Plans / DLL",
        subtitle: "Prepare and track daily lesson logs."
    },

    settings: {
        title: "Settings",
        subtitle: "Configure ANHS SmartSchool."
    }

};


function showPage(pageName) {

    pages.forEach(page => {

        page.classList.remove("active-page");

    });


    const selectedPage =
        document.getElementById(pageName);

    if (selectedPage) {

        selectedPage.classList.add("active-page");

    }


    navItems.forEach(item => {

        item.classList.remove("active");

        if (item.dataset.page === pageName) {

            item.classList.add("active");

        }

    });


    if (pageNames[pageName]) {

        pageTitle.textContent =
            pageNames[pageName].title;

        pageSubtitle.textContent =
            pageNames[pageName].subtitle;

    }


    /* Close sidebar on mobile */

    document
        .getElementById("sidebar")
        .classList.remove("open");


    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });

}


/* Navigation links */

navItems.forEach(item => {

    item.addEventListener("click", function(event) {

        event.preventDefault();

        showPage(this.dataset.page);

    });

});


/* Quick action buttons */

document.querySelectorAll("[data-page]")
    .forEach(button => {

        if (!button.classList.contains("nav-item")) {

            button.addEventListener("click", function() {

                showPage(this.dataset.page);

            });

        }

    });


/* ================================
   MOBILE SIDEBAR
================================ */

const menuToggle =
    document.getElementById("menuToggle");

const sidebar =
    document.getElementById("sidebar");

menuToggle.addEventListener("click", function() {

    sidebar.classList.toggle("open");

});


/* ================================
   LESSON PLAN SEARCH
================================ */

const lessonPlanSearch =
    document.getElementById("lessonPlanSearch");

if (lessonPlanSearch) {

    lessonPlanSearch.addEventListener("input", function() {

        const searchValue =
            this.value.toLowerCase();

        const rows =
            document.querySelectorAll(
                "#lessonPlanTable tbody tr"
            );

        rows.forEach(row => {

            const text =
                row.textContent.toLowerCase();

            row.style.display =
                text.includes(searchValue)
                    ? ""
                    : "none";

        });

    });

}


/* ================================
   LESSON PLAN MODAL
================================ */

const lessonPlanModal =
    document.getElementById("lessonPlanModal");

const addLessonPlanBtn =
    document.getElementById("addLessonPlanBtn");

const closeLessonPlanModal =
    document.getElementById("closeLessonPlanModal");

const cancelLessonPlanModal =
    document.getElementById("cancelLessonPlanModal");


function openLessonPlanModal() {

    lessonPlanModal.classList.add("show");

    setDefaultLessonDueDate();

    /* Teachers can only ever upload under their own name —
       lock the Teacher Name field to whoever is logged in
       so they can't submit as (or see files under) someone
       else. Admins keep full control of the field. */

    const teacherSelect =
        document.getElementById("newLessonTeacher");

    if (teacherSelect) {

        if (currentUser && currentUser.role === "teacher") {

            /* The Teacher Name list is built from the roster. If this
               teacher hasn't been added to the roster (or it hasn't loaded),
               add their own name here so the field is never left empty. */
            const hasOwnOption = Array.from(teacherSelect.options).some(function(option) {
                return option.value === currentUser.name;
            });

            if (!hasOwnOption) {
                const ownOption = document.createElement("option");
                ownOption.value = currentUser.name;
                ownOption.textContent = currentUser.name;
                teacherSelect.appendChild(ownOption);
            }

            teacherSelect.value = currentUser.name;
            teacherSelect.disabled = true;
            teacherSelect.dispatchEvent(new Event("change"));

        } else {

            teacherSelect.disabled = false;

        }

    }

}


function hideLessonPlanModal() {

    lessonPlanModal.classList.remove("show");

    lessonPlanForm.reset();

    clearLessonFile();

}


if (addLessonPlanBtn) {

    addLessonPlanBtn.addEventListener(
        "click",
        openLessonPlanModal
    );

}


if (closeLessonPlanModal) {

    closeLessonPlanModal.addEventListener(
        "click",
        hideLessonPlanModal
    );

}


if (cancelLessonPlanModal) {

    cancelLessonPlanModal.addEventListener(
        "click",
        hideLessonPlanModal
    );

}


/* Close modal by clicking background */

if (lessonPlanModal) {

    lessonPlanModal.addEventListener("click", function(event) {

        if (event.target === lessonPlanModal) {

            hideLessonPlanModal();

        }

    });

}


/* ================================
   TEACHER -> DEPARTMENT AUTO-FILL
================================ */

const newLessonTeacher =
    document.getElementById("newLessonTeacher");

const newLessonDepartment =
    document.getElementById("newLessonDepartment");

if (newLessonTeacher && newLessonDepartment) {

    newLessonTeacher.addEventListener("change", function() {

        const selectedOption =
            this.options[this.selectedIndex];

        const department =
            selectedOption
                ? selectedOption.dataset.department || ""
                : "";

        newLessonDepartment.value = department;

    });

}


/* ================================
   LESSON PLAN WEEK OPTIONS + CONFIGURABLE DEADLINE
================================ */

const newLessonWeek = document.getElementById("newLessonWeek");
const newLessonDueDate = document.getElementById("newLessonDueDate");
const dueDateHelp = document.getElementById("dueDateHelp");

const DEFAULT_DEADLINE_SETTINGS = {
    day: 5,       // Friday (1=Monday ... 5=Friday)
    time: "17:00"
};

function getDeadlineSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem("anhsLessonDeadlineSettings") || "null");
        if (saved && Number(saved.day) >= 1 && Number(saved.day) <= 5 && /^\d{2}:\d{2}$/.test(saved.time || "")) {
            return { day: Number(saved.day), time: saved.time };
        }
    } catch (error) {
        console.warn("Could not read saved deadline settings.", error);
    }
    return { ...DEFAULT_DEADLINE_SETTINGS };
}

function saveDeadlineSettings(settings) {
    localStorage.setItem("anhsLessonDeadlineSettings", JSON.stringify(settings));
}

function formatDeadlineSettings(settings) {
    const dayNames = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    const [hours, minutes] = settings.time.split(":").map(Number);
    const sample = new Date(2000, 0, 1, hours, minutes);
    return `${dayNames[settings.day]}, ${sample.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

function getConfiguredDeadline(dateValue) {
    if (!dateValue) return "";
    const settings = getDeadlineSettings();
    const date = new Date(dateValue + "T00:00:00");
    const currentDay = date.getDay() === 0 ? 7 : date.getDay();
    const daysToDeadline = (settings.day - currentDay + 7) % 7;
    date.setDate(date.getDate() + daysToDeadline);
    const [hours, minutes] = settings.time.split(":").map(Number);
    date.setHours(hours, minutes, 0, 0);

    const pad = value => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(hours)}:${pad(minutes)}`;
}

function updateDeadlineHelp() {
    const label = formatDeadlineSettings(getDeadlineSettings());
    if (dueDateHelp) dueDateHelp.textContent = `Default weekly deadline: ${label}. You may adjust it for this cycle.`;
    const preview = document.getElementById("deadlinePreview");
    if (preview) preview.textContent = `Default weekly deadline: ${label}`;
}

/* With no lesson-date field any more, the default due date is the
   configured weekly deadline (e.g. Friday 5:00 PM) of the CURRENT
   week (Monday-Sunday). A plan sent after that deadline shows as Late
   in the current week instead of disappearing into next week. The
   admin can still adjust the due date in the form. */
function setDefaultLessonDueDate() {
    if (!newLessonDueDate) return;
    const deadline = getConfiguredDeadline(toInputDate(getWeekStart(0)));
    if (deadline) newLessonDueDate.value = deadline;
    updateDeadlineHelp();
}

if (newLessonWeek) {
    const placeholderOption = document.createElement("option");
    placeholderOption.value = "";
    placeholderOption.disabled = true;
    placeholderOption.selected = true;
    placeholderOption.textContent = "Select week";
    newLessonWeek.appendChild(placeholderOption);
    for (let week = 1; week <= 12; week++) {
        const option = document.createElement("option");
        option.value = `Week ${week}`;
        option.textContent = `Week ${week}`;
        newLessonWeek.appendChild(option);
    }
}

/* ================================
   SETTINGS - WEEKLY DEADLINE
================================ */

function initializeDeadlineSettings() {
    const settings = getDeadlineSettings();
    const dayInput = document.getElementById("deadlineDaySetting");
    const timeInput = document.getElementById("deadlineTimeSetting");
    if (dayInput) dayInput.value = String(settings.day);
    if (timeInput) timeInput.value = settings.time;
    updateDeadlineHelp();
}

const saveSettingsBtn = document.getElementById("saveSettingsBtn");
if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener("click", function() {
        const day = Number(document.getElementById("deadlineDaySetting").value);
        const time = document.getElementById("deadlineTimeSetting").value;
        if (day < 1 || day > 5 || !/^\d{2}:\d{2}$/.test(time)) {
            alert("Please select a valid Monday-Friday deadline and time.");
            return;
        }
        saveDeadlineSettings({ day, time });
        updateDeadlineHelp();
        setDefaultLessonDueDate();
        normalizeLessonPlanStatuses();
        alert(`Settings saved. New lesson plans will use ${formatDeadlineSettings({ day, time })} as the default weekly deadline.`);
    });
}

initializeDeadlineSettings();

/* ================================
   LESSON PLAN FILE UPLOAD
================================ */

const lessonFileUpload =
    document.getElementById("lessonFileUpload");

const lessonFileInput =
    document.getElementById("newLessonFile");

const lessonFileDropzone =
    document.getElementById("lessonFileDropzone");

const lessonFileName =
    document.getElementById("lessonFileName");

const lessonFileSize =
    document.getElementById("lessonFileSize");

const lessonFileRemove =
    document.getElementById("lessonFileRemove");


function formatFileSize(bytes) {

    if (bytes < 1024) return `${bytes} B`;

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

}


function setLessonFile(file) {

    if (!file) return;

    lessonFileName.textContent = file.name;
    lessonFileSize.textContent = formatFileSize(file.size);

    lessonFileUpload.classList.add("has-file");

    lessonFileUpload.classList.remove(
        "field-invalid"
    );

}


function clearLessonFile() {

    lessonFileInput.value = "";

    lessonFileUpload.classList.remove("has-file");

}


if (lessonFileDropzone) {

    lessonFileDropzone.addEventListener(
        "click",
        function() {
            lessonFileInput.click();
        }
    );

    lessonFileDropzone.addEventListener(
        "dragover",
        function(event) {
            event.preventDefault();
            lessonFileDropzone.classList.add("dragover");
        }
    );

    lessonFileDropzone.addEventListener(
        "dragleave",
        function() {
            lessonFileDropzone.classList.remove("dragover");
        }
    );

    lessonFileDropzone.addEventListener(
        "drop",
        function(event) {

            event.preventDefault();

            lessonFileDropzone.classList.remove("dragover");

            const file =
                event.dataTransfer.files &&
                event.dataTransfer.files[0];

            if (file) {

                lessonFileInput.files =
                    event.dataTransfer.files;

                setLessonFile(file);

            }

        }
    );

}


if (lessonFileInput) {

    lessonFileInput.addEventListener(
        "change",
        function() {

            const file = this.files[0];

            if (file) {
                setLessonFile(file);
            }

        }
    );

}


if (lessonFileRemove) {

    lessonFileRemove.addEventListener(
        "click",
        function(event) {

            event.stopPropagation();

            clearLessonFile();

        }
    );

}


/* ================================
   LESSON PLAN COMPLIANCE STATUS
================================ */

function getLessonPlanStatus(submittedAt, dueAt, hasFile = true) {

    if (!hasFile) return "Missing";
    if (!submittedAt || !dueAt) return "Missing";

    return new Date(submittedAt).getTime() <= new Date(dueAt).getTime()
        ? "On Time"
        : "Late";

}


function getStatusClass(status) {

    if (status === "On Time") return "status-on-time";
    if (status === "Late") return "status-late";
    return "status-missing";

}


/* ================================
   ROLE-BASED LESSON PLAN ACCESS

   Teachers may only upload and see their OWN lesson
   plan / DLL submissions — never another teacher's
   uploaded file. Every submission is automatically
   checked by Admin, so there's no manual routing here.
================================ */

function applyLessonPlanVisibility() {

    const rows =
        document.querySelectorAll("#lessonPlanTable tbody tr");

    const isTeacher =
        !!currentUser && currentUser.role === "teacher";

    rows.forEach(function(row) {

        const teacherName =
            row.querySelectorAll("td")[1]?.textContent.trim() || "";

        const isOwnRow =
            !currentUser || namesMatch(teacherName, currentUser.name);

        /* A teacher only ever sees rows that belong to them. */
        row.classList.toggle("hidden", isTeacher && !isOwnRow);

    });

}


function formatDueDate(dateTimeValue) {

    if (!dateTimeValue) return "—";

    return new Date(dateTimeValue).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit"
    });

}


function normalizeLessonPlanStatuses() {

    /* Status/due-date cells are now computed live off the
       Supabase-backed cache every time the table renders, so
       refreshing after a deadline-settings change is just a
       re-render rather than patching cells in place. */
    renderLessonPlanTable();

}


/* ================================
   ADD LESSON PLAN
================================ */

const lessonPlanForm =
    document.getElementById("lessonPlanForm");


if (lessonPlanForm) {

    lessonPlanForm.addEventListener(
        "submit",
        async function(event) {

            event.preventDefault();


            const rawDueDate =
                document.getElementById(
                    "newLessonDueDate"
                ).value;

            const grade =
                document.getElementById(
                    "newLessonGrade"
                ).value;

            const term =
                document.getElementById(
                    "newLessonTerm"
                ).value;

            const week =
                document.getElementById(
                    "newLessonWeek"
                ).value;

            let teacher =
                document.getElementById(
                    "newLessonTeacher"
                ).value;

            /* A teacher account can only ever submit under its own name. */
            if (currentUser && currentUser.role === "teacher") {
                teacher = currentUser.name;
            }

            const department =
                document.getElementById(
                    "newLessonDepartment"
                ).value;

            const subject =
                document.getElementById(
                    "newLessonSubject"
                ).value;

            const file =
                lessonFileInput.files[0];


            /* Validate the required fields */

            let hasError = false;

            if (!grade) {
                document.getElementById("newLessonGrade").classList.add("field-invalid");
                hasError = true;
            } else {
                document.getElementById("newLessonGrade").classList.remove("field-invalid");
            }

            if (!rawDueDate) {
                document.getElementById("newLessonDueDate").classList.add("field-invalid");
                hasError = true;
            } else {
                document.getElementById("newLessonDueDate").classList.remove("field-invalid");
            }

            /* Validate uploaded file — required */

            if (!file) {

                lessonFileUpload.classList.add(
                    "field-invalid"
                );

                hasError = true;

            }

            if (!teacher) {
                alert("Please select the teacher name first.");
                hasError = true;
            }


            if (hasError) {
                return;
            }


            const fileExtension =
                file.name.split(".").pop().toLowerCase();

            const fileIcon =
                fileExtension === "pdf"
                    ? "fa-file-pdf"
                    : ["doc", "docx"].includes(fileExtension)
                        ? "fa-file-word"
                        : ["ppt", "pptx"].includes(fileExtension)
                            ? "fa-file-powerpoint"
                            : "fa-file-lines";


            const submittedAt = new Date().toISOString();
            /* The form gives a local date-time with no timezone; convert it to a
               real UTC timestamp so the database stores the intended moment
               (otherwise a 5:00 PM deadline is stored as 5:00 PM UTC = 1:00 AM
               the next day in the Philippines). */
            const dueAt = new Date(rawDueDate).toISOString();


            /* Upload the actual file to Supabase Storage (same
               pattern already used for avatars/the school logo)
               so it's saved for real and can be opened from any
               device, then save the submission record — with a
               link to that file — in Supabase so every signed-in
               account sees it immediately. */

            const submitBtn =
                lessonPlanForm.querySelector('button[type="submit"]');

            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.dataset.originalText = submitBtn.textContent;
                submitBtn.textContent = "Uploading...";
            }

            try {

                /* Files are organised under DLL Modules by Grade Level, then
                   Department, then Term and Week, e.g. "Grade 11/TechPro/Term
                   1/Week 1/<Teacher_Name>_<time>_<file>", so every week has
                   its own folder in Supabase Storage and admin can browse the
                   bucket directly by grade/department/term/week. Grade,
                   Department, Term and Week are all fixed dropdown values,
                   so they're safe to use as literal folder names as-is.
                   Privacy is now enforced by storage object ownership (see the
                   updated lesson_files_* RLS policies) rather than by nesting
                   an account-id folder in the path. */
                const folderSafe = function(value) {
                    return String(value || "").trim().replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Unsorted";
                };
                const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
                const storagePath = grade.trim() + "/" + department.trim() + "/" + term.trim() + "/" + week.trim() + "/" +
                    folderSafe(teacher) + "_" + Date.now() + "_" + safeName;
                const { error: uploadError } = await supabaseClient.storage.from("lesson-plans").upload(storagePath, file, { upsert:false, contentType:file.type || "application/octet-stream" });
                if (uploadError) throw uploadError;
                const { error: insertError } = await supabaseClient.from("lesson_plans").insert({
                    teacher, department, subject, term, week, grade,
                    submitted_at:submittedAt, due_at:dueAt, file_name:file.name, file_icon:fileIcon, storage_path:storagePath,
                    reviewer:"admin", created_by:currentUser.uid
                });
                if (insertError) { await supabaseClient.storage.from("lesson-plans").remove([storagePath]); throw insertError; }

                await loadLessonPlans();

                hideLessonPlanModal();

                alert(
                    "Lesson plan successfully saved to ANHS SmartSchool."
                );

            } catch (err) {

                console.error("Could not save the lesson plan:", err);

                alert(
                    "Sorry, that lesson plan couldn't be uploaded. Please check your connection and try again." +
                    (err && err.message ? "\n\nDetails: " + err.message : "")
                );

            } finally {

                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = submitBtn.dataset.originalText || "Save Lesson Plan";
                }

            }

        }
    );

}


/* ================================
   TEACHER SEARCH + DEPARTMENT FILTER
================================ */

const teacherSearch =
    document.getElementById("teacherSearch");

const teacherDepartmentFilter =
    document.getElementById("teacherDepartmentFilter");


function filterTeacherTable() {

    const searchValue =
        teacherSearch
            ? teacherSearch.value.toLowerCase()
            : "";

    const departmentValue =
        teacherDepartmentFilter
            ? teacherDepartmentFilter.value
            : "all";

    const rows =
        document.querySelectorAll(
            "#teacherTable tbody tr"
        );

    rows.forEach(row => {

        const text =
            row.textContent.toLowerCase();

        const matchesSearch =
            text.includes(searchValue);

        const matchesDepartment =
            departmentValue === "all" ||
            row.dataset.department === departmentValue;

        row.style.display =
            matchesSearch && matchesDepartment
                ? ""
                : "none";

    });

}


if (teacherSearch) {

    teacherSearch.addEventListener(
        "input",
        filterTeacherTable
    );

}


if (teacherDepartmentFilter) {

    teacherDepartmentFilter.addEventListener(
        "change",
        filterTeacherTable
    );

}


/* ================================
   TEACHER MODAL
================================ */

const teacherModal =
    document.getElementById("teacherModal");

const addTeacherBtn =
    document.getElementById("addTeacherBtn");

const closeTeacherModal =
    document.getElementById("closeTeacherModal");

const cancelTeacherModal =
    document.getElementById("cancelTeacherModal");


/* When set, the teacher form submits an UPDATE to this roster row
   instead of an INSERT. Cleared whenever the modal is opened fresh
   from "Add Teacher" or closed. */
let editingTeacherId = null;

const teacherModalTitle = teacherModal ? teacherModal.querySelector(".modal-header h2") : null;
const teacherModalSubtitle = teacherModal ? teacherModal.querySelector(".modal-header p") : null;
const teacherFormSubmitBtn = document.querySelector("#teacherForm button[type=\"submit\"]");

function setTeacherModalMode(mode) {
    if (teacherModalTitle) teacherModalTitle.textContent = mode === "edit" ? "Edit Teacher" : "Add Teacher";
    if (teacherModalSubtitle) teacherModalSubtitle.textContent = mode === "edit" ? "Update faculty information." : "Enter faculty information.";
    if (teacherFormSubmitBtn) teacherFormSubmitBtn.textContent = mode === "edit" ? "Update Teacher" : "Save Teacher";
}

function openTeacherModal() {

    teacherModal.classList.add("show");

}


function hideTeacherModal() {

    teacherModal.classList.remove("show");
    editingTeacherId = null;
    setTeacherModalMode("add");
    if (teacherForm) teacherForm.reset();

}


/* Fills the form with an existing roster row and switches the
   modal into edit mode. */
function openTeacherModalForEdit(teacher) {

    if (!teacher) return;

    editingTeacherId = teacher.id;
    setTeacherModalMode("edit");

    const setValue = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = value ?? "";
    };

    setValue("newTeacherName", teacher.name);
    setValue("newTeacherSex", teacher.sex);
    setValue("newTeacherAge", teacher.age);
    setValue("newTeacherDepartment", teacher.department);
    setValue("newTeacherPosition", teacher.position);
    setValue("newTeacherYears", teacher.years);
    setValue("newTeacherPostGrad", teacher.postGrad);

    openTeacherModal();

}


if (addTeacherBtn) {

    addTeacherBtn.addEventListener(
        "click",
        function() {
            editingTeacherId = null;
            setTeacherModalMode("add");
            if (teacherForm) teacherForm.reset();
            openTeacherModal();
        }
    );

}


if (closeTeacherModal) {

    closeTeacherModal.addEventListener(
        "click",
        hideTeacherModal
    );

}


if (cancelTeacherModal) {

    cancelTeacherModal.addEventListener(
        "click",
        hideTeacherModal
    );

}


if (teacherModal) {

    teacherModal.addEventListener("click", function(event) {

        if (event.target === teacherModal) {

            hideTeacherModal();

        }

    });

}


/* ================================
   ADD TEACHER
================================ */

const teacherForm =
    document.getElementById("teacherForm");


if (teacherForm) {

    teacherForm.addEventListener(
        "submit",
        async function(event) {

            event.preventDefault();


            const name =
                document.getElementById(
                    "newTeacherName"
                ).value.trim();

            const sex =
                document.getElementById(
                    "newTeacherSex"
                ).value;

            const age =
                document.getElementById(
                    "newTeacherAge"
                ).value;

            const department =
                document.getElementById(
                    "newTeacherDepartment"
                ).value;

            const position =
                document.getElementById(
                    "newTeacherPosition"
                ).value.trim();

            const years =
                document.getElementById(
                    "newTeacherYears"
                ).value;

            const postGrad =
                document.getElementById(
                    "newTeacherPostGrad"
                ).value;

            if (!name) return;


            /* Saved straight to Supabase's "teachers" collection
               instead of just being appended to the table in
               memory, so the roster is shared with every signed-in
               account and survives a refresh. */

            const submitBtn =
                teacherForm.querySelector('button[type="submit"]');

            const isEditing = !!editingTeacherId;

            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.dataset.originalText = submitBtn.textContent;
                submitBtn.textContent = isEditing ? "Updating..." : "Saving...";
            }

            try {

                const payload = {
                    name, sex, age:age ? Number(age) : null, department, position, years:years ? Number(years) : null,
                    post_grad:postGrad
                };

                const { error } = isEditing
                    ? await supabaseClient.from("teachers").update(payload).eq("id", editingTeacherId)
                    : await supabaseClient.from("teachers").insert(Object.assign({}, payload, { created_by:currentUser ? currentUser.uid : null }));
                if (error) throw error;

                await loadTeachers();

                hideTeacherModal();

                alert(
                    isEditing
                        ? "Teacher record successfully updated."
                        : "Teacher successfully added to ANHS SmartSchool."
                );

            } catch (err) {

                console.error("Could not save teacher:", err);

                alert(
                    "Sorry, that teacher couldn't be saved. Please try again."
                );

            } finally {

                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = submitBtn.dataset.originalText || (isEditing ? "Update Teacher" : "Save Teacher");
                }

            }

        }
    );

}


/* ================================
   DELETE TEACHER (roster only — does
   not touch their login account or
   any lesson plans they've already
   submitted)
================================ */

async function deleteTeacherRecord(teacherId, teacherName) {

    if (!currentUser || currentUser.role !== "admin") return;

    const confirmed = confirm(
        `Remove ${teacherName || "this teacher"} from the roster? ` +
        "This does not delete their login account or past lesson plan submissions."
    );

    if (!confirmed) return;

    try {

        const { error } = await supabaseClient.from("teachers").delete().eq("id", teacherId);
        if (error) throw error;

        await loadTeachers();

    } catch (err) {

        console.error("Could not remove teacher:", err);

        alert("Sorry, that teacher couldn't be removed. Please try again.");

    }

}


/* ================================
   LESSON PLAN PREVIEW
   Every submission is automatically checked by Admin —
   there's no manual routing/assignment step anymore.
================================ */

const lessonPreviewModal = document.getElementById("lessonPreviewModal");
const closeLessonPreviewModal = document.getElementById("closeLessonPreviewModal");
const closePreviewBtn = document.getElementById("closePreviewBtn");
const maximizeLessonPreviewModal = document.getElementById("maximizeLessonPreviewModal");
let activeLessonPlanId = null;

/* Toggles the preview modal between its normal size and a
   near-fullscreen size, so long lesson plan / DLL documents are
   easier to read without leaving the page. The icon and title
   flip between "expand" (maximize) and "compress" (minimize). */
function toggleLessonPreviewMaximize() {
    const modalContent = lessonPreviewModal?.querySelector(".lesson-preview-modal");
    if (!modalContent) return;
    const icon = maximizeLessonPreviewModal.querySelector("i");
    const isMaximized = modalContent.classList.toggle("maximized");
    if (isMaximized) {
        icon.classList.remove("fa-expand");
        icon.classList.add("fa-compress");
        maximizeLessonPreviewModal.title = "Minimize";
    } else {
        icon.classList.remove("fa-compress");
        icon.classList.add("fa-expand");
        maximizeLessonPreviewModal.title = "Maximize";
    }
}
maximizeLessonPreviewModal?.addEventListener("click", toggleLessonPreviewMaximize);

/* Sourced from lessonPlansCache by id (rather than scraped from a
   table row) so both the Table view and the DLL Modules folder view
   can open the same preview modal. */
async function openLessonPreview(planId) {
    if (!lessonPreviewModal || !planId) return;

    const plan = lessonPlansCache.find(p => p.id === planId);
    if (!plan) return;

    const isTeacher = !!currentUser && currentUser.role === "teacher";

    /* Safety net: a teacher can never open another
       teacher's uploaded file, even if this were somehow
       triggered outside the normal table view. */
    if (isTeacher && !namesMatch(plan.teacher, currentUser.name)) return;

    activeLessonPlanId = planId;

    const status = getLessonPlanStatus(plan.submittedAt, plan.dueAt, !!(plan.fileURL || plan.storagePath));
    document.getElementById("previewTeacher").textContent = plan.teacher || "—";
    document.getElementById("previewSubject").textContent = plan.subject || "—";
    document.getElementById("previewTermWeek").textContent = `${plan.term || "—"} / ${plan.week || "—"}`;
    document.getElementById("previewStatus").innerHTML = `<span class="status ${getStatusClass(status)}">${status}</span>`;
    document.getElementById("previewReviewer").textContent = "Admin / School Administrator";
    const fileName = plan.fileName || (plan.storagePath ? "File" : "No file submitted");
    document.getElementById("previewFileName").textContent = fileName;
    const frame = document.getElementById("lessonFileFrame");
    const message = document.getElementById("previewFileMessage");
    frame.hidden = true;
    frame.removeAttribute("src");
    frame.onload = null;
    if (plan.storagePath) {
        lessonPreviewModal.classList.add("show");
        message.textContent = "Preparing secure file preview...";
        try {
            const { data, error } = await supabaseClient.storage.from("lesson-plans").createSignedUrl(plan.storagePath, 300);
            if (error) throw error;
            if (/\.pdf$/i.test(fileName)) {
                /* PDFs render natively in the browser. */
                frame.src = data.signedUrl;
                frame.hidden = false;
                message.textContent = "PDF preview is available below.";
            } else if (/\.(docx?|pptx?)$/i.test(fileName)) {
                /* Word/PowerPoint files are rendered in-page via the
                   Microsoft Office Online viewer, so the checker never
                   has to download the file just to look at it. It needs
                   a URL it can fetch itself, so we hand it the same
                   short-lived signed URL used for PDFs. */
                frame.onload = function() { message.textContent = "Document preview is available below."; };
                frame.src = "https://view.officeapps.live.com/op/embed.aspx?src=" + encodeURIComponent(data.signedUrl);
                frame.hidden = false;
                message.textContent = "Loading document preview...";
            } else {
                message.textContent = "A preview isn't available for this file type.";
            }
        } catch (err) { console.error(err); message.textContent = "The file could not be opened. Please check your access and try again."; }
    } else { message.textContent = "No uploaded file is available for preview."; lessonPreviewModal.classList.add("show"); }
}

function closeLessonPreview() {
    lessonPreviewModal?.classList.remove("show");
    const frame = document.getElementById("lessonFileFrame");
    if (frame) { frame.removeAttribute("src"); frame.onload = null; }
    const modalContent = lessonPreviewModal?.querySelector(".lesson-preview-modal");
    if (modalContent) {
        modalContent.classList.remove("maximized");
        const icon = maximizeLessonPreviewModal?.querySelector("i");
        if (icon) { icon.classList.remove("fa-compress"); icon.classList.add("fa-expand"); }
        if (maximizeLessonPreviewModal) maximizeLessonPreviewModal.title = "Maximize";
    }
    activeLessonPlanId = null;
}

document.addEventListener("click", function(event) {
    const previewButton = event.target.closest(".preview-lesson-btn");
    const deleteTeacherButton = event.target.closest(".delete-teacher-btn");
    const editTeacherButton = event.target.closest(".edit-teacher-btn");

    if (previewButton) {
        openLessonPreview(previewButton.closest("tr")?.dataset.id);
        return;
    }

    if (deleteTeacherButton) {
        const row = deleteTeacherButton.closest("tr");
        if (row && row.dataset.id) {
            const name = row.querySelector("td")?.textContent.trim();
            deleteTeacherRecord(row.dataset.id, name);
        }
        return;
    }

    if (editTeacherButton) {
        if (!currentUser || currentUser.role !== "admin") return;
        const row = editTeacherButton.closest("tr");
        const teacher = row && teachersCache.find(t => t.id === row.dataset.id);
        openTeacherModalForEdit(teacher);
    }
});

closeLessonPreviewModal?.addEventListener("click", closeLessonPreview);
closePreviewBtn?.addEventListener("click", closeLessonPreview);
lessonPreviewModal?.addEventListener("click", function(event) {
    if (event.target === lessonPreviewModal) closeLessonPreview();
});


/* ================================
   LOGOUT
================================ */

const logoutBtn =
    document.querySelector(
        ".logout-btn"
    );


logoutBtn.addEventListener(
    "click",
    function() {

        const confirmLogout =
            confirm(
                "Are you sure you want to logout?"
            );


        if (confirmLogout) {

            showLoginPage();

        }

    }
);




/* ================================
   SUBMISSION MONITORING TRACKER
================================ */

function getWeekStart(offsetWeeks = 0) {
    const today = new Date();
    const day = today.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    monday.setDate(monday.getDate() + diffToMonday + (offsetWeeks * 7));
    monday.setHours(0, 0, 0, 0);
    return monday;
}

function getWeekEnd(offsetWeeks = 0) {
    const monday = getWeekStart(offsetWeeks);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    return sunday;
}

function getWeekRangeLabel(offsetWeeks = 0) {
    const start = getWeekStart(offsetWeeks);
    const end = getWeekEnd(offsetWeeks);
    const options = { month: "short", day: "numeric" };
    return `${start.toLocaleDateString(undefined, options)} - ${end.toLocaleDateString(undefined, options)}`;
}

function getTrackerWeekOffset() {
    const value = document.getElementById("trackerWeekFilter")?.value || "current";
    if (value === "previous") return -1;
    if (value === "next") return 1;
    return 0;
}

/* Teacher roster and lesson-plan records now come straight from
   the live Supabase caches (see startDataListeners) instead of
   being scraped back out of the HTML table — the table is just a
   rendered view of this data now. */

function getTeacherRecords() {
    return teachersCache.map(teacher => ({
        name: teacher.name || "Unknown Teacher",
        department: teacher.department || "Academic"
    }));
}

function getLessonPlanRecords() {
    return lessonPlansCache.map(plan => ({
        submittedAt: plan.submittedAt || "",
        dueAt: plan.dueAt || "",
        teacher: plan.teacher || "",
        term: plan.term || "",
        week: plan.week || "",
        hasFile: !!(plan.fileURL || plan.storagePath)
    }));
}


/* ================================
   RENDER: TEACHERS TABLE
================================ */

function renderTeacherTable() {

    const tbody = document.querySelector("#teacherTable tbody");
    if (!tbody) return;

    const isAdmin = !!currentUser && currentUser.role === "admin";

    if (!teachersCache.length) {

        tbody.innerHTML = `<tr><td colspan="8" class="tracker-no-results">
            <i class="fa-solid fa-user-slash"></i>
            No teachers in the roster yet. Use "Add Teacher" to add one.
        </td></tr>`;

    } else {

        tbody.innerHTML = teachersCache.map(function(teacher) {

            const department = teacher.department || "Academic";
            const departmentClass = department === "TechPro" ? "techpro" : "academic";

            return `<tr data-department="${escapeHtml(department)}" data-id="${teacher.id}">
                <td>${escapeHtml(teacher.name)}</td>
                <td>${escapeHtml(teacher.sex || "—")}</td>
                <td>${escapeHtml(teacher.age || "—")}</td>
                <td><span class="status ${departmentClass}">${escapeHtml(department)}</span></td>
                <td>${escapeHtml(teacher.position || "—")}</td>
                <td>${escapeHtml(teacher.years || "—")}</td>
                <td>${escapeHtml(teacher.postGrad || "—")}</td>
                <td class="lesson-action-cell">
                    <div class="lesson-actions">
                        <button type="button" class="table-btn edit-teacher-btn" title="Edit teacher" ${isAdmin ? "" : "disabled"}>
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        <button type="button" class="table-btn delete-teacher-btn" title="Remove teacher" ${isAdmin ? "" : "disabled"}>
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>`;

        }).join("");

    }

    filterTeacherTable();

}


/* ================================
   RENDER: LESSON PLAN / DLL TABLE
================================ */

function renderLessonPlanTable() {

    const tbody = document.querySelector("#lessonPlanTable tbody");
    if (!tbody) return;

    if (!lessonPlansCache.length) {

        tbody.innerHTML = `<tr><td colspan="11" class="tracker-no-results">
            <i class="fa-solid fa-file-circle-xmark"></i>
            No lesson plans submitted yet.
        </td></tr>`;

    } else {

        tbody.innerHTML = lessonPlansCache.map(function(plan) {

            const status = getLessonPlanStatus(plan.submittedAt, plan.dueAt, !!(plan.fileURL || plan.storagePath));
            const department = plan.department || "Academic";
            const departmentClass = department === "TechPro" ? "techpro" : "academic";

            const fileCellHtml = plan.storagePath
                ? `<span class="file-chip"><i class="fa-solid ${plan.fileIcon || "fa-file-lines"}"></i> ${escapeHtml(plan.fileName || "File")}</span>`
                : `<span class="file-chip"><i class="fa-solid fa-file-circle-xmark"></i> No file submitted</span>`;

            return `<tr
                data-id="${plan.id}"
                data-submitted-at="${plan.submittedAt || ""}"
                data-due-at="${plan.dueAt || ""}"
                data-file-name="${escapeHtml(plan.fileName || "")}"
                data-storage-path="${escapeHtml(plan.storagePath || "")}"
            >
                <td>${plan.submittedAt ? formatDueDate(plan.submittedAt) : "—"}</td>
                <td>${escapeHtml(plan.teacher || "")}</td>
                <td>${escapeHtml(plan.grade || "—")}</td>
                <td><span class="status ${departmentClass}">${escapeHtml(department)}</span></td>
                <td>${escapeHtml(plan.subject || "")}</td>
                <td>${escapeHtml(plan.term || "")}</td>
                <td>${escapeHtml(plan.week || "")}</td>
                <td class="lesson-due-cell">${plan.dueAt ? formatDueDate(plan.dueAt) : "—"}</td>
                <td>${fileCellHtml}</td>
                <td class="lesson-status-cell"><span class="status ${getStatusClass(status)}">${status}</span></td>
                <td class="lesson-action-cell">
                    <div class="lesson-actions">
                        <button type="button" class="table-btn preview-lesson-btn" title="Preview lesson plan">
                            <i class="fa-solid fa-eye"></i>
                        </button>
                        <span class="review-status-badge">
                            <i class="fa-solid fa-user-shield"></i> Admin / School Administrator
                        </span>
                    </div>
                </td>
            </tr>`;

        }).join("");

    }

    applyLessonPlanVisibility();

    if (lessonPlanSearch && lessonPlanSearch.value) {
        lessonPlanSearch.dispatchEvent(new Event("input"));
    }

    renderLessonPlanFolders();

}


/* ================================
   DLL MODULES — FOLDER VIEW
   Same lessonPlansCache as the table, just browsed as
   School Year > Grade 11/12 > TechPro/Academics > Term 1/2/3 > Week 1-12 > files,
   matching how the files are actually organised in Supabase Storage.

   School Year is the top-level folder. It's admin-managed (add / delete)
   rather than tied to Supabase data, so the list of years is kept in
   localStorage — same pattern as anhsLessonDeadlineSettings above.
================================ */

const SCHOOL_YEAR_FOLDERS_KEY = "anhsSchoolYearFolders_v2";
const DEFAULT_SCHOOL_YEAR_FOLDERS = ["School Year 2026-2027"];

function loadSchoolYearFolders() {
    try {
        const saved = JSON.parse(localStorage.getItem(SCHOOL_YEAR_FOLDERS_KEY) || "null");
        if (Array.isArray(saved) && saved.length) return saved;
    } catch (e) {
        console.error("Could not load school year folders:", e);
    }
    return DEFAULT_SCHOOL_YEAR_FOLDERS.slice();
}

function saveSchoolYearFolders() {
    localStorage.setItem(SCHOOL_YEAR_FOLDERS_KEY, JSON.stringify(schoolYearFolders));
}

let schoolYearFolders = loadSchoolYearFolders();

const GRADE_FOLDERS = ["Grade 11", "Grade 12"];
/* label = what's shown/clicked as the folder name; value = the
   underlying plan.department value that folder filters on. */
const DEPARTMENT_FOLDERS = [
    { label: "TechPro", value: "TechPro" },
    { label: "Academics", value: "Academic" }
];
const TERM_FOLDERS = ["Term 1", "Term 2", "Term 3"];
const WEEK_FOLDERS = Array.from({ length: 12 }, (_, i) => `Week ${i + 1}`);

let folderViewActive = false;
let folderViewYear = null;
let folderViewGrade = null;
let folderViewDept = null;
let folderViewTerm = null;
let folderViewWeek = null;

function isFolderViewAdmin() {
    return !!currentUser && currentUser.role === "admin";
}

function getFolderViewPlans() {
    const isTeacher = !!currentUser && currentUser.role === "teacher";
    return isTeacher
        ? lessonPlansCache.filter(plan => namesMatch(plan.teacher, currentUser.name))
        : lessonPlansCache;
}

function setLessonPlanView(view) {
    folderViewActive = view === "folders";

    const toggleButtons = document.querySelectorAll("#lessonPlanViewToggle .view-toggle-btn");
    toggleButtons.forEach(btn => btn.classList.toggle("active", btn.dataset.view === view));

    const tableContainer = document.getElementById("lessonPlanTableContainer");
    const folderContainer = document.getElementById("lessonPlanFolderView");
    if (tableContainer) tableContainer.classList.toggle("hidden", folderViewActive);
    if (folderContainer) folderContainer.classList.toggle("hidden", !folderViewActive);

    if (folderViewActive) renderLessonPlanFolders();
}

function renderLessonPlanBreadcrumb() {
    const el = document.getElementById("lessonPlanBreadcrumb");
    if (!el) return;

    const parts = [];
    parts.push(
        folderViewYear
            ? `<button type="button" data-crumb="root"><i class="fa-solid fa-folder-tree"></i> DLL Modules</button>`
            : `<span class="crumb-current"><i class="fa-solid fa-folder-tree"></i> DLL Modules</span>`
    );

    if (folderViewYear) {
        parts.push(`<span class="crumb-sep">/</span>`);
        parts.push(
            folderViewGrade
                ? `<button type="button" data-crumb="year">${escapeHtml(folderViewYear)}</button>`
                : `<span class="crumb-current">${escapeHtml(folderViewYear)}</span>`
        );
    }

    if (folderViewGrade) {
        parts.push(`<span class="crumb-sep">/</span>`);
        parts.push(
            folderViewDept
                ? `<button type="button" data-crumb="grade">${escapeHtml(folderViewGrade)}</button>`
                : `<span class="crumb-current">${escapeHtml(folderViewGrade)}</span>`
        );
    }

    if (folderViewDept) {
        parts.push(`<span class="crumb-sep">/</span>`);
        parts.push(
            folderViewTerm
                ? `<button type="button" data-crumb="dept">${escapeHtml(folderViewDept.label)}</button>`
                : `<span class="crumb-current">${escapeHtml(folderViewDept.label)}</span>`
        );
    }

    if (folderViewTerm) {
        parts.push(`<span class="crumb-sep">/</span>`);
        parts.push(
            folderViewWeek
                ? `<button type="button" data-crumb="term">${escapeHtml(folderViewTerm)}</button>`
                : `<span class="crumb-current">${escapeHtml(folderViewTerm)}</span>`
        );
    }

    if (folderViewWeek) {
        parts.push(`<span class="crumb-sep">/</span>`);
        parts.push(`<span class="crumb-current">${escapeHtml(folderViewWeek)}</span>`);
    }

    el.innerHTML = parts.join("");
}

function renderLessonPlanFolders() {
    if (!folderViewActive) return;

    const grid = document.getElementById("lessonPlanFolderGrid");
    const fileList = document.getElementById("lessonPlanFolderFiles");
    if (!grid || !fileList) return;

    renderLessonPlanBreadcrumb();

    const plans = getFolderViewPlans();
    const canManageFolders = isFolderViewAdmin();

    /* Level 1: School Year folders (admin can add/delete these) */
    if (!folderViewYear) {
        grid.classList.remove("hidden");
        grid.classList.toggle("folder-grid-manageable", canManageFolders);
        fileList.classList.add("hidden");
        grid.innerHTML = schoolYearFolders.map(year => {
            const count = plans.filter(p => p.grade && p.storagePath).length;
            return `<div class="folder-card" data-year="${escapeHtml(year)}">
                ${canManageFolders ? `<button type="button" class="folder-delete-btn" data-delete-year="${escapeHtml(year)}" title="Delete this school year folder"><i class="fa-solid fa-trash"></i></button>` : ""}
                <i class="fa-solid fa-folder"></i>
                <strong>${escapeHtml(year)}</strong>
                <small>${count} file${count === 1 ? "" : "s"}</small>
            </div>`;
        }).join("");

        if (canManageFolders) {
            grid.innerHTML += `<div class="folder-card folder-add-card" data-add-year>
                <i class="fa-solid fa-plus"></i>
                <strong>Add School Year</strong>
                <small>Create a new folder</small>
            </div>`;
        }

        return;
    }

    /* Level 2: Grade folders inside the selected school year */
    if (!folderViewGrade) {
        grid.classList.remove("hidden");
        grid.classList.remove("folder-grid-manageable");
        fileList.classList.add("hidden");
        grid.innerHTML = GRADE_FOLDERS.map(grade => {
            const count = plans.filter(p => p.grade === grade && p.storagePath).length;
            return `<div class="folder-card" data-grade="${escapeHtml(grade)}">
                <i class="fa-solid fa-folder"></i>
                <strong>${escapeHtml(grade)}</strong>
                <small>${count} file${count === 1 ? "" : "s"}</small>
            </div>`;
        }).join("");
        return;
    }

    /* Level 3: Department folders (TechPro / Academics) inside the selected grade */
    if (!folderViewDept) {
        grid.classList.remove("hidden");
        fileList.classList.add("hidden");
        grid.innerHTML = DEPARTMENT_FOLDERS.map(dept => {
            const count = plans.filter(p => p.grade === folderViewGrade && (p.department || "Academic") === dept.value && p.storagePath).length;
            return `<div class="folder-card" data-dept="${escapeHtml(dept.value)}">
                <i class="fa-solid fa-folder"></i>
                <strong>${escapeHtml(dept.label)}</strong>
                <small>${count} file${count === 1 ? "" : "s"}</small>
            </div>`;
        }).join("");
        return;
    }

    /* Level 4: Term folders inside the selected grade/department */
    if (!folderViewTerm) {
        grid.classList.remove("hidden");
        fileList.classList.add("hidden");
        grid.innerHTML = TERM_FOLDERS.map(term => {
            const count = plans.filter(p => p.grade === folderViewGrade && (p.department || "Academic") === folderViewDept.value && p.term === term && p.storagePath).length;
            return `<div class="folder-card" data-term="${escapeHtml(term)}">
                <i class="fa-solid fa-folder"></i>
                <strong>${escapeHtml(term)}</strong>
                <small>${count} file${count === 1 ? "" : "s"}</small>
            </div>`;
        }).join("");
        return;
    }

    /* Level 5: Week folders inside the selected term */
    if (!folderViewWeek) {
        grid.classList.remove("hidden");
        fileList.classList.add("hidden");
        grid.innerHTML = WEEK_FOLDERS.map(week => {
            const count = plans.filter(p => p.grade === folderViewGrade && (p.department || "Academic") === folderViewDept.value && p.term === folderViewTerm && p.week === week && p.storagePath).length;
            return `<div class="folder-card" data-week="${escapeHtml(week)}">
                <i class="fa-solid fa-folder"></i>
                <strong>${escapeHtml(week)}</strong>
                <small>${count} file${count === 1 ? "" : "s"}</small>
            </div>`;
        }).join("");
        return;
    }

    /* Level 6: files inside the selected Year/Grade/Department/Term/Week folder */
    grid.classList.add("hidden");
    fileList.classList.remove("hidden");
    const files = plans.filter(p => p.grade === folderViewGrade && (p.department || "Academic") === folderViewDept.value && p.term === folderViewTerm && p.week === folderViewWeek && p.storagePath);

    if (!files.length) {
        fileList.innerHTML = `<div class="folder-empty">
            <i class="fa-solid fa-folder-open"></i><br>
            No files uploaded yet in ${escapeHtml(folderViewYear)} / ${escapeHtml(folderViewGrade)} / ${escapeHtml(folderViewDept.label)} / ${escapeHtml(folderViewTerm)} / ${escapeHtml(folderViewWeek)}.
        </div>`;
        return;
    }

    fileList.innerHTML = files.map(plan => {
        const status = getLessonPlanStatus(plan.submittedAt, plan.dueAt, !!(plan.fileURL || plan.storagePath));
        return `<div class="folder-file-row" data-plan-id="${plan.id}">
            <div class="folder-file-main">
                <i class="fa-solid ${plan.fileIcon || "fa-file-lines"}"></i>
                <div>
                    <div class="folder-file-name">${escapeHtml(plan.fileName || "File")}</div>
                    <div class="folder-file-meta">${escapeHtml(plan.teacher || "")} • ${escapeHtml(plan.subject || "")}</div>
                </div>
            </div>
            <span class="status ${getStatusClass(status)}">${status}</span>
        </div>`;
    }).join("");
}

document.getElementById("lessonPlanViewToggle")?.addEventListener("click", function(event) {
    const btn = event.target.closest(".view-toggle-btn");
    if (btn) setLessonPlanView(btn.dataset.view);
});

document.getElementById("lessonPlanFolderGrid")?.addEventListener("click", function(event) {

    /* Delete-folder button on a School Year card — handled first and
       stops here so it doesn't also open the folder it sits on top of. */
    const deleteBtn = event.target.closest("[data-delete-year]");
    if (deleteBtn) {
        event.stopPropagation();
        const year = deleteBtn.dataset.deleteYear;
        const confirmDelete = confirm(`Delete the "${year}" school year folder? Grade 11 and Grade 12 inside it won't be deleted from the system, but this folder shortcut will be removed.`);
        if (confirmDelete) {
            schoolYearFolders = schoolYearFolders.filter(y => y !== year);
            saveSchoolYearFolders();
            if (folderViewYear === year) folderViewYear = null;
            renderLessonPlanFolders();
        }
        return;
    }

    /* "+ Add School Year" card */
    if (event.target.closest("[data-add-year]")) {
        const input = prompt("Name the new school year folder (e.g. School Year 2027-2028):");
        if (input === null) return;
        const year = input.trim();
        if (!year) { alert("Please enter a school year, e.g. School Year 2027-2028."); return; }
        if (schoolYearFolders.some(y => y.toLowerCase() === year.toLowerCase())) {
            alert(`"${year}" already exists.`);
            return;
        }
        schoolYearFolders.push(year);
        saveSchoolYearFolders();
        renderLessonPlanFolders();
        return;
    }

    const card = event.target.closest(".folder-card");
    if (!card) return;
    if (card.dataset.year) folderViewYear = card.dataset.year;
    else if (card.dataset.grade) folderViewGrade = card.dataset.grade;
    else if (card.dataset.dept) folderViewDept = DEPARTMENT_FOLDERS.find(d => d.value === card.dataset.dept) || null;
    else if (card.dataset.term) folderViewTerm = card.dataset.term;
    else if (card.dataset.week) folderViewWeek = card.dataset.week;
    renderLessonPlanFolders();
});

document.getElementById("lessonPlanFolderFiles")?.addEventListener("click", function(event) {
    const row = event.target.closest(".folder-file-row");
    if (row && row.dataset.planId) openLessonPreview(row.dataset.planId);
});

document.getElementById("lessonPlanBreadcrumb")?.addEventListener("click", function(event) {
    const btn = event.target.closest("button[data-crumb]");
    if (!btn) return;
    if (btn.dataset.crumb === "root") { folderViewYear = null; folderViewGrade = null; folderViewDept = null; folderViewTerm = null; folderViewWeek = null; }
    else if (btn.dataset.crumb === "year") { folderViewGrade = null; folderViewDept = null; folderViewTerm = null; folderViewWeek = null; }
    else if (btn.dataset.crumb === "grade") { folderViewDept = null; folderViewTerm = null; folderViewWeek = null; }
    else if (btn.dataset.crumb === "dept") { folderViewTerm = null; folderViewWeek = null; }
    else if (btn.dataset.crumb === "term") { folderViewWeek = null; }
    renderLessonPlanFolders();
});


/* Keeps the "Teacher Name" dropdown on the Add Lesson Plan form
   in sync with the live roster, instead of a hardcoded list of
   demo names. */

function populateLessonTeacherOptions() {

    if (!newLessonTeacher) return;

    const previousValue = newLessonTeacher.value;

    newLessonTeacher.innerHTML =
        '<option value="" disabled selected>Select teacher</option>' +
        teachersCache.map(function(teacher) {
            return `<option data-department="${escapeHtml(teacher.department || "")}">${escapeHtml(teacher.name)}</option>`;
        }).join("");

    if (teachersCache.some(t => t.name === previousValue)) {
        newLessonTeacher.value = previousValue;
    }

}

function statusPriority(status) {
    return { "Missing": 3, "Late": 2, "On Time": 1 }[status] || 0;
}

/* Teacher names get typed in two separate places (the Teachers
   roster and a teacher's login profile) and only ever need to be
   the "same person", not byte-identical. Collapse whitespace and
   ignore case so a stray space or capitalization mismatch doesn't
   make a real submission look Missing on the tracker. */
function namesMatch(a, b) {
    const normalize = value => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
    return normalize(a) === normalize(b);
}

function getTeacherWeekCompliance(teacherName, offsetWeeks, termFilter) {
    const start = getWeekStart(offsetWeeks);
    const end = getWeekEnd(offsetWeeks);
    const records = getLessonPlanRecords().filter(record => {
        if (!namesMatch(record.teacher, teacherName) || !record.dueAt) return false;
        if (termFilter !== "all" && record.term !== termFilter) return false;
        const due = new Date(record.dueAt);
        return due >= start && due <= end;
    });

    if (!records.length) {
        return {
            status: "Missing",
            dueAt: getConfiguredDeadline(toInputDate(start)),
            submittedAt: "",
            week: "Current Cycle"
        };
    }

    let selected = records[0];
    let selectedStatus = getLessonPlanStatus(selected.submittedAt, selected.dueAt, selected.hasFile);
    records.slice(1).forEach(record => {
        const status = getLessonPlanStatus(record.submittedAt, record.dueAt, record.hasFile);
        if (statusPriority(status) > statusPriority(selectedStatus) ||
            (statusPriority(status) === statusPriority(selectedStatus) && new Date(record.dueAt) > new Date(selected.dueAt))) {
            selected = record;
            selectedStatus = status;
        }
    });

    return {
        status: selectedStatus,
        dueAt: selected.dueAt,
        submittedAt: selected.submittedAt,
        week: selected.week || "Current Cycle"
    };
}

function toInputDate(date) {
    const pad = n => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function renderSubmissionTracker() {
    const body = document.getElementById("submissionTrackerBody");
    if (!body) return;

    const offsetWeeks = getTrackerWeekOffset();
    const termFilter = document.getElementById("trackerTermFilter")?.value || "all";
    const search = (document.getElementById("trackerSearch")?.value || "").toLowerCase().trim();
    const teachers = getTeacherRecords().filter(teacher => teacher.name.toLowerCase().includes(search));

    const label = document.getElementById("trackerWeekLabel");
    if (label) label.textContent = `${offsetWeeks === 0 ? "Current week" : offsetWeeks < 0 ? "Previous week" : "Next week"} • ${getWeekRangeLabel(offsetWeeks)}`;

    let counts = { "On Time": 0, "Late": 0, "Missing": 0 };

    if (!teachers.length) {
        body.innerHTML = `<tr><td colspan="7" class="tracker-no-results">
            <i class="fa-solid fa-user-slash"></i>
            No teachers match the current search.
        </td></tr>`;
    } else {
        body.innerHTML = teachers.map(teacher => {
        const compliance = getTeacherWeekCompliance(teacher.name, offsetWeeks, termFilter);
        counts[compliance.status]++;
        const departmentClass = teacher.department === "TechPro" ? "techpro" : "academic";
        const submitted = compliance.submittedAt ? formatDueDate(compliance.submittedAt) : "—";
        const due = compliance.dueAt ? formatDueDate(compliance.dueAt) : "—";
        const termWeek = compliance.week && compliance.week !== "Current Cycle"
            ? `${termFilter === "all" ? "" : termFilter + " • "}${compliance.week}`
            : (termFilter === "all" ? "Current Cycle" : `${termFilter} • Current Cycle`);
        const rate = compliance.status === "On Time" ? "100%" : compliance.status === "Late" ? "0%" : "0%";

        return `<tr>
            <td><strong>${teacher.name}</strong></td>
            <td><span class="status ${departmentClass}">${teacher.department}</span></td>
            <td>${termWeek}</td>
            <td>${due}</td>
            <td>${submitted}</td>
            <td><span class="status ${getStatusClass(compliance.status)}">${compliance.status}</span></td>
            <td><div class="tracker-compliance-cell"><div class="tracker-mini-bar"><span style="width:${rate}"></span></div><strong>${rate}</strong></div></td>
        </tr>`;
        }).join("");
    }

    document.getElementById("trackerTotalTeachers").textContent = teachers.length;
    document.getElementById("trackerOnTime").textContent = counts["On Time"];
    document.getElementById("trackerLate").textContent = counts["Late"];
    document.getElementById("trackerMissing").textContent = counts["Missing"];
}

/* ================================
   WEEKLY COMPLIANCE SNAPSHOT WIDGET
   (Teachers page) — same one-row-per-teacher logic as
   the full Submission Tracker, always for the current
   week / all terms, with a shortcut into the full page.
================================ */

function renderTeacherComplianceWidget() {
    const totalEl = document.getElementById("teacherWidgetTotal");
    if (!totalEl) return;

    const teachers = getTeacherRecords();
    let counts = { "On Time": 0, "Late": 0, "Missing": 0 };

    teachers.forEach(teacher => {
        const compliance = getTeacherWeekCompliance(teacher.name, 0, "all");
        counts[compliance.status]++;
    });

    totalEl.textContent = teachers.length;
    document.getElementById("teacherWidgetOnTime").textContent = counts["On Time"];
    document.getElementById("teacherWidgetLate").textContent = counts["Late"];
    document.getElementById("teacherWidgetMissing").textContent = counts["Missing"];

    const weekLabel = document.getElementById("teacherWidgetWeekLabel");
    if (weekLabel) weekLabel.textContent = `Current week • ${getWeekRangeLabel(0)}`;
}

["trackerWeekFilter", "trackerTermFilter"].forEach(id => {
    const element = document.getElementById(id);
    if (element) element.addEventListener("change", renderSubmissionTracker);
});

const trackerSearch = document.getElementById("trackerSearch");
if (trackerSearch) trackerSearch.addEventListener("input", renderSubmissionTracker);

const originalShowPage = showPage;
showPage = function(pageName) {

    /* Defense in depth: even if a teacher account somehow
       triggers navigation to an admin-only page (its nav
       link is already hidden), fall back to the dashboard
       instead of rendering it. */
    if (currentUser && currentUser.role === "teacher" && RESTRICTED_TEACHER_PAGES.includes(pageName)) {
        pageName = "dashboard";
    }
    if (currentUser && currentUser.role === "department_head" && ADMIN_ONLY_PAGES.includes(pageName)) {
        pageName = "dashboard";
    }

    originalShowPage(pageName);
    if (pageName === "submissiontracker") renderSubmissionTracker();
    if (pageName === "lessonplans") applyLessonPlanVisibility();
    if (pageName === "teachers") renderTeacherComplianceWidget();
};

/* ================================
   WEEKLY COMPLIANCE DASHBOARD
   (now computed live from the same
   Supabase-backed teacher/lesson-plan
   caches that power the Submission
   Tracker, instead of hardcoded numbers)
================================ */

function getCurrentWeekLabel() {
    const today = new Date();
    const day = today.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(today);
    monday.setDate(today.getDate() + diffToMonday);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const options = { month: "short", day: "numeric" };
    return `${monday.toLocaleDateString(undefined, options)} - ${sunday.toLocaleDateString(undefined, options)}`;
}

function computeWeekComplianceCounts(teacherList) {
    let counts = { "On Time": 0, "Late": 0, "Missing": 0 };
    teacherList.forEach(function(teacher) {
        const compliance = getTeacherWeekCompliance(teacher.name, 0, "all");
        counts[compliance.status]++;
    });
    return counts;
}

function updateComplianceDashboard() {

    const allTeachers = getTeacherRecords();
    const counts = computeWeekComplianceCounts(allTeachers);
    const total = counts["On Time"] + counts["Late"] + counts["Missing"];
    const rate = total ? Math.round((counts["On Time"] / total) * 100) : 0;

    const onTime = document.getElementById("onTimeCount");
    const late = document.getElementById("lateCount");
    const missing = document.getElementById("missingCount");
    const overall = document.getElementById("overallComplianceRate");
    const weekLabel = document.getElementById("complianceWeekLabel");
    const list = document.getElementById("departmentComplianceList");

    if (onTime) onTime.textContent = counts["On Time"];
    if (late) late.textContent = counts["Late"];
    if (missing) missing.textContent = counts["Missing"];
    if (overall) overall.textContent = `${rate}%`;
    if (weekLabel) weekLabel.textContent = `Current week • ${getCurrentWeekLabel()}`;

    if (list) {

        const departmentNames = ["Academic", "TechPro"];

        const departmentRates = departmentNames.map(function(deptName) {

            const deptTeachers = allTeachers.filter(t => t.department === deptName);
            const deptCounts = computeWeekComplianceCounts(deptTeachers);
            const deptTotal = deptTeachers.length;
            const deptRate = deptTotal ? Math.round((deptCounts["On Time"] / deptTotal) * 100) : 0;

            return { name: deptName, rate: deptRate };

        });

        departmentRates.push({ name: "All Departments", rate: rate });

        list.innerHTML = departmentRates.map(dept => `
            <div class="department-row">
                <span>${dept.name}</span>
                <div class="compliance-bar" aria-label="${dept.name} compliance ${dept.rate}%">
                    <span style="width:${dept.rate}%"></span>
                </div>
                <strong>${dept.rate}%</strong>
            </div>
        `).join("");

    }

}

/* ================================
   INITIALIZE
================================ */

normalizeLessonPlanStatuses();

function updateDashboardCounts() {

    const isTeacher =
        !!currentUser && currentUser.role === "teacher";

    const relevantPlans =
        isTeacher
            ? lessonPlansCache.filter(plan => namesMatch(plan.teacher, currentUser.name))
            : lessonPlansCache;

    const lessonCount =
        document.getElementById("lessonPlanCount");

    if (lessonCount) {

        lessonCount.textContent = relevantPlans.length;

    }


    const teacherCount =
        document.getElementById("teacherCount");

    if (teacherCount) {

        teacherCount.textContent = teachersCache.length;

    }

}


document.addEventListener(
    "DOMContentLoaded",
    function() {

        showPage("dashboard");

        updateDashboardCounts();
        renderSubmissionTracker();
        renderTeacherComplianceWidget();

    }
);