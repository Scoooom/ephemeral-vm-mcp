const { startRegistration, startAuthentication, browserSupportsWebAuthn } = window.SimpleWebAuthnBrowser;
const content = document.getElementById("content");
const errBox = document.getElementById("err");

const ERR_TEXT = {
  bad_enroll_token: "Enrollment token is incorrect.",
  enrollment_closed: "Enrollment is closed — a passkey is already registered.",
  challenge_expired: "That took too long — try again.",
  verification_failed: "The passkey could not be verified.",
  unknown_credential: "This passkey is not registered here.",
};
function showErr(msg) {
  errBox.textContent = msg ? (ERR_TEXT[msg] || msg) : "";
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function doRegister(enrollToken) {
  showErr("");
  try {
    const optionsJSON = await postJSON("/api/auth/register/options", {
      enrollToken: (enrollToken || "").trim() || undefined,
    });
    const attResp = await startRegistration({ optionsJSON });
    const label = `${navigator.platform || "passkey"} — ${new Date().toISOString().slice(0, 10)}`;
    await postJSON("/api/auth/register/verify", { attResp, label });
    location.href = "/";
  } catch (e) {
    showErr(e.message || String(e));
  }
}

async function doLogin() {
  showErr("");
  try {
    const optionsJSON = await postJSON("/api/auth/login/options", {});
    const authResp = await startAuthentication({ optionsJSON });
    await postJSON("/api/auth/login/verify", { authResp });
    location.href = "/";
  } catch (e) {
    showErr(e.message || String(e));
  }
}

function renderRegister(state) {
  content.innerHTML = `
    <p>No passkey is registered yet. Create one now — your browser or password
       manager will offer to save it. This becomes the key to the dashboard.</p>
    ${state.enrollTokenRequired
      ? `<input id="enroll" type="text" inputmode="latin" placeholder="Enrollment token"
           autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
           data-1p-ignore data-lpignore="true" data-bwignore />`
      : ""}
    <button class="btn primary" id="go">Register a passkey</button>`;
  const go = () => doRegister(document.getElementById("enroll")?.value);
  document.getElementById("go").onclick = go;
  document.getElementById("enroll")?.addEventListener("keydown", (e) => e.key === "Enter" && go());
}

function renderLogin() {
  content.innerHTML = `
    <p>Sign in with your passkey.</p>
    <button class="btn primary" id="go">Sign in</button>`;
  document.getElementById("go").onclick = doLogin;
}

(async function init() {
  if (!browserSupportsWebAuthn()) {
    content.innerHTML = "<p>This browser does not support WebAuthn / passkeys.</p>";
    return;
  }
  try {
    const state = await (await fetch("/api/auth/state")).json();
    if (state.authed) {
      location.href = "/";
      return;
    }
    if (state.enrolled) renderLogin();
    else renderRegister(state);
  } catch (e) {
    showErr(e.message || String(e));
  }
})();
