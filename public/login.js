const { startRegistration, startAuthentication, browserSupportsWebAuthn } = window.SimpleWebAuthnBrowser;
const content = document.getElementById("content");
const errBox = document.getElementById("err");

function showErr(msg) {
  errBox.textContent = msg || "";
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
    const optionsJSON = await postJSON("/api/auth/register/options", { enrollToken });
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
    ${state.enrollTokenRequired ? `<input id="enroll" type="password" placeholder="Enrollment token" autocomplete="off" />` : ""}
    <button class="btn primary" id="go">Register a passkey</button>`;
  document.getElementById("go").onclick = () =>
    doRegister(document.getElementById("enroll")?.value || undefined);
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
