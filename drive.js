/* ANHS SMARTSCHOOL - GOOGLE DRIVE STORAGE
   Files go to the school's Google Drive; the record (name, link, Drive file id,
   grade/term/week...) stays in Supabase. Requires drive-config.js and the
   Google Identity Services script (accounts.google.com/gsi/client). */
(function () {
    var cfg = window.DRIVE_CONFIG || {};
    var DRIVE = "https://www.googleapis.com/drive/v3";
    var UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
    var FOLDER_MIME = "application/vnd.google-apps.folder";
    var tokenClient = null, accessToken = null, tokenExpiresAt = 0;

    function isConfigured() {
        return !!(cfg.clientId && cfg.rootFolderId &&
            cfg.clientId.indexOf("PASTE_") !== 0 && cfg.rootFolderId.indexOf("PASTE_") !== 0);
    }

    function waitForGis() {
        return new Promise(function (resolve, reject) {
            var tries = 0;
            (function check() {
                if (window.google && google.accounts && google.accounts.oauth2) return resolve();
                if (++tries > 50) return reject(new Error("Google sign-in library did not load. Check your internet connection."));
                setTimeout(check, 100);
            })();
        });
    }

    /* Asks the user to sign in with Google (popup) the first time, then reuses
       the token until it is about to expire (about 1 hour). */
    function ensureAuth() {
        if (accessToken && Date.now() < tokenExpiresAt - 60000) return Promise.resolve(accessToken);
        return waitForGis().then(function () {
            return new Promise(function (resolve, reject) {
                if (!tokenClient) {
                    tokenClient = google.accounts.oauth2.initTokenClient({
                        client_id: cfg.clientId,
                        scope: cfg.scope,
                        hd: cfg.hostedDomain || undefined,
                        callback: function () {}
                    });
                }
                tokenClient.callback = function (resp) {
                    if (resp.error) return reject(new Error("Google sign-in failed: " + (resp.error_description || resp.error)));
                    accessToken = resp.access_token;
                    tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
                    resolve(accessToken);
                };
                tokenClient.error_callback = function (err) {
                    reject(new Error(err && err.type === "popup_closed"
                        ? "Google sign-in was cancelled. Please try again and allow access to Google Drive."
                        : "Google sign-in popup was blocked or failed. Allow popups for this site and try again."));
                };
                tokenClient.requestAccessToken({ prompt: accessToken ? "" : "select_account" });
            });
        });
    }

    function driveFetch(url, options) {
        options = options || {};
        options.headers = Object.assign({ Authorization: "Bearer " + accessToken }, options.headers || {});
        return fetch(url, options).then(function (res) {
            if (res.ok) return res.json();
            return res.text().then(function (t) {
                var msg = t; try { msg = JSON.parse(t).error.message; } catch (e) {}
                var err = new Error("Google Drive: " + msg); err.status = res.status; throw err;
            });
        });
    }

    function q(s) { return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }

    function findFolder(name, parentId) {
        var query = "name='" + q(name) + "' and '" + parentId + "' in parents and mimeType='" + FOLDER_MIME + "' and trashed=false";
        return driveFetch(DRIVE + "/files?supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id)&pageSize=1&q=" + encodeURIComponent(query))
            .then(function (r) { return r.files && r.files[0] ? r.files[0].id : null; });
    }

    function createFolder(name, parentId) {
        return driveFetch(DRIVE + "/files?supportsAllDrives=true&fields=id", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name, mimeType: FOLDER_MIME, parents: [parentId] })
        }).then(function (r) { return r.id; });
    }

    /* Creates Grade/Department/Term/Week folders as needed. Folder ids are
       remembered in the Supabase table drive_folders so two teachers
       uploading at the same moment never create duplicate folders. */
    function ensureFolderPath(segments) {
        var parent = cfg.rootFolderId, key = "", chain = Promise.resolve();
        segments.forEach(function (seg) {
            chain = chain.then(function () {
                key += "/" + seg;
                var pathKey = key;
                return supabaseClient.from("drive_folders").select("folder_id").eq("path_key", pathKey).maybeSingle().then(function (res) {
                    if (res.data && res.data.folder_id) { parent = res.data.folder_id; return; }
                    return findFolder(seg, parent).then(function (existing) {
                        if (existing) return { id: existing, created: false };
                        return createFolder(seg, parent).then(function (id) { return { id: id, created: true }; });
                    }).then(function (folder) {
                        return supabaseClient.from("drive_folders").insert({ path_key: pathKey, folder_id: folder.id }).then(function (ins) {
                            if (!ins.error) { parent = folder.id; return; }
                            /* Someone else registered this folder first: use theirs. */
                            return supabaseClient.from("drive_folders").select("folder_id").eq("path_key", pathKey).maybeSingle().then(function (again) {
                                if (again.data && again.data.folder_id) {
                                    parent = again.data.folder_id;
                                    if (folder.created && folder.id !== parent) {
                                        driveFetch(DRIVE + "/files/" + folder.id + "?supportsAllDrives=true", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) }).catch(function () {});
                                    }
                                } else { parent = folder.id; }
                            });
                        });
                    });
                });
            });
        });
        return chain.then(function () { return parent; });
    }

    function forgetFolders() {
        /* Used if a remembered folder was deleted/moved in Drive. */
        return supabaseClient.from("drive_folders").delete().neq("path_key", "");
    }

    function resumableUpload(file, name, folderId, onProgress) {
        var mime = file.type || "application/octet-stream";
        return fetch(UPLOAD + "?uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink,size,mimeType", {
            method: "POST",
            headers: {
                Authorization: "Bearer " + accessToken,
                "Content-Type": "application/json; charset=UTF-8",
                "X-Upload-Content-Type": mime,
                "X-Upload-Content-Length": String(file.size)
            },
            body: JSON.stringify({ name: name, parents: [folderId], mimeType: mime })
        }).then(function (res) {
            if (!res.ok) {
                return res.text().then(function (t) {
                    var msg = t; try { msg = JSON.parse(t).error.message; } catch (e) {}
                    var err = new Error("Google Drive: " + msg); err.status = res.status; throw err;
                });
            }
            var sessionUrl = res.headers.get("Location");
            if (!sessionUrl) throw new Error("Google Drive did not return an upload address.");
            return new Promise(function (resolve, reject) {
                var xhr = new XMLHttpRequest();
                xhr.open("PUT", sessionUrl);
                xhr.setRequestHeader("Content-Type", mime);
                xhr.upload.onprogress = function (e) {
                    if (onProgress && e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100));
                };
                xhr.onload = function () {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(new Error("Unexpected response from Google Drive.")); }
                    } else { reject(new Error("Google Drive upload failed (" + xhr.status + ")")); }
                };
                xhr.onerror = function () { reject(new Error("Network error while uploading to Google Drive.")); };
                xhr.send(file);
            });
        });
    }

    /* folderSegments e.g. ["Grade 11","TechPro","Term 1","Week 1"] */
    function uploadFile(file, folderSegments, fileName, onProgress) {
        function attempt(retry) {
            return ensureFolderPath(folderSegments).then(function (folderId) {
                return resumableUpload(file, fileName, folderId, onProgress);
            }).catch(function (err) {
                if (retry && err && err.status === 404) {
                    return forgetFolders().then(function () { return attempt(false); });
                }
                throw err;
            });
        }
        return ensureAuth().then(function () { return attempt(true); }).then(function (f) {
            return { id: f.id, name: f.name, webViewLink: f.webViewLink, size: Number(f.size) || file.size, mimeType: f.mimeType };
        });
    }

    function previewUrl(fileId) {
        return "https://drive.google.com/file/d/" + encodeURIComponent(fileId) + "/preview";
    }
    function openUrl(fileId) {
        return "https://drive.google.com/file/d/" + encodeURIComponent(fileId) + "/view";
    }

    window.DriveStorage = { isConfigured: isConfigured, ensureAuth: ensureAuth, uploadFile: uploadFile, previewUrl: previewUrl, openUrl: openUrl };
})();
