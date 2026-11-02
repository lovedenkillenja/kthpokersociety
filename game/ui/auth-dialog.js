// Auth dialog controller (Log in, Create account, Reset password, Password recovery).

import { getSupabaseClient } from "../lib/supabase.js";
import { friendlyAuthError } from "../lib/format.js";
import { showToast, wireDialog } from "./components.js";

export function createAuthDialogController({ onSignedIn }) {
  const dialog = document.getElementById("auth-dialog");
  const titleEl = document.getElementById("auth-dialog-title");
  const tabsWrap = document.getElementById("auth-tabs-wrap");
  const tabLogin = document.getElementById("tab-login");
  const tabSignup = document.getElementById("tab-signup");
  const loginForm = document.getElementById("login-form");
  const signupForm = document.getElementById("signup-form");
  const resetForm = document.getElementById("reset-form");
  const recoveryForm = document.getElementById("recovery-form");
  const messageView = document.getElementById("auth-message-view");
  const messageText = document.getElementById("auth-message-text");

  const loginError = document.getElementById("login-error");
  const signupError = document.getElementById("signup-error");
  const resetError = document.getElementById("reset-error");
  const recoveryError = document.getElementById("recovery-error");

  function clearErrors() {
    [loginError, signupError, resetError, recoveryError].forEach((el) => {
      if (el) el.textContent = "";
    });
    dialog.querySelectorAll("[aria-invalid]").forEach((input) => {
      input.removeAttribute("aria-invalid");
    });
  }

  function showMode(mode) {
    clearErrors();
    const isLogin = mode === "login";
    const isSignup = mode === "signup";
    const isTabMode = isLogin || isSignup;

    tabsWrap.hidden = !isTabMode;
    resetForm.hidden = mode !== "reset";
    recoveryForm.hidden = mode !== "recovery";
    messageView.hidden = mode !== "message";

    if (isTabMode) {
      tabLogin.setAttribute("aria-selected", String(isLogin));
      tabSignup.setAttribute("aria-selected", String(isSignup));
      tabLogin.tabIndex = isLogin ? 0 : -1;
      tabSignup.tabIndex = isSignup ? 0 : -1;
      loginForm.hidden = !isLogin;
      signupForm.hidden = !isSignup;
      titleEl.textContent = isLogin ? "Log in" : "Create member account";
    } else if (mode === "reset") {
      titleEl.textContent = "Reset password";
    } else if (mode === "recovery") {
      titleEl.textContent = "Choose new password";
    }
  }

  function open(mode = "login") {
    showMode(mode);
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    }
  }

  function close() {
    if (dialog.open) {
      dialog.close();
    }
  }

  wireDialog(dialog, clearErrors);

  tabLogin.addEventListener("click", () => showMode("login"));
  tabSignup.addEventListener("click", () => showMode("signup"));

  [tabLogin, tabSignup].forEach((tab) => {
    tab.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const nextMode = tab === tabLogin ? "signup" : "login";
        showMode(nextMode);
        (nextMode === "login" ? tabLogin : tabSignup).focus();
      }
    });
  });

  document.getElementById("forgot-password-btn").addEventListener("click", () => {
    document.getElementById("rs-email").value = document.getElementById("li-email").value.trim();
    showMode("reset");
  });

  document.getElementById("back-to-login-btn").addEventListener("click", () => showMode("login"));
  document.getElementById("message-back-login-btn").addEventListener("click", () => showMode("login"));

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors();
    const emailInput = document.getElementById("li-email");
    const pwInput = document.getElementById("li-password");
    const email = emailInput.value.trim().toLowerCase();
    const password = pwInput.value;

    if (!email) {
      loginError.textContent = "Enter your email address.";
      emailInput.setAttribute("aria-invalid", "true");
      emailInput.focus();
      return;
    }
    if (!password) {
      loginError.textContent = "Enter your password.";
      pwInput.setAttribute("aria-invalid", "true");
      pwInput.focus();
      return;
    }

    const sb = getSupabaseClient();
    if (!sb) {
      loginError.textContent = "Connection lost. Check your internet connection and try again.";
      return;
    }

    const submitBtn = document.getElementById("login-submit-btn");
    submitBtn.setAttribute("aria-busy", "true");
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    submitBtn.removeAttribute("aria-busy");

    if (error) {
      loginError.textContent = friendlyAuthError(error);
      pwInput.setAttribute("aria-invalid", "true");
      return;
    }

    loginForm.reset();
    close();
    if (data?.user && typeof onSignedIn === "function") {
      await onSignedIn(data.user);
      showToast("Signed in to KTH Poker.");
    }
  });

  signupForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors();
    const nameInput = document.getElementById("su-name");
    const emailInput = document.getElementById("su-email");
    const progInput = document.getElementById("su-program");
    const pwInput = document.getElementById("su-password");
    const consentInput = document.getElementById("su-consent");

    const name = nameInput.value.trim();
    const email = emailInput.value.trim().toLowerCase();
    const program = progInput.value.trim();
    const password = pwInput.value;

    if (!name) {
      signupError.textContent = "Enter your full name.";
      nameInput.setAttribute("aria-invalid", "true");
      nameInput.focus();
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      signupError.textContent = "Enter a valid email address, such as name@kth.se.";
      emailInput.setAttribute("aria-invalid", "true");
      emailInput.focus();
      return;
    }
    if (password.length < 8) {
      signupError.textContent = "Use a password with at least 8 characters.";
      pwInput.setAttribute("aria-invalid", "true");
      pwInput.focus();
      return;
    }
    if (!consentInput.checked) {
      signupError.textContent = "Check the box to agree to the membership terms.";
      consentInput.focus();
      return;
    }

    const sb = getSupabaseClient();
    if (!sb) {
      signupError.textContent = "Connection lost. Check your internet connection and try again.";
      return;
    }

    const submitBtn = document.getElementById("signup-submit-btn");
    submitBtn.setAttribute("aria-busy", "true");
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/game/`,
        data: { full_name: name, program }
      }
    });
    submitBtn.removeAttribute("aria-busy");

    if (error) {
      signupError.textContent = friendlyAuthError(error);
      return;
    }
    if (data?.user?.identities && data.user.identities.length === 0) {
      signupError.textContent = "An account with this email already exists. Switch to Log in.";
      return;
    }

    signupForm.reset();
    if (data?.session?.user && typeof onSignedIn === "function") {
      close();
      await onSignedIn(data.session.user);
      showToast("Welcome to KTH Poker Society! +1,000 chips added.");
    } else {
      titleEl.textContent = "Check your inbox";
      messageText.textContent = `We sent a confirmation link to ${email}. Open it to activate your account and receive your 1,000 welcome chips.`;
      showMode("message");
    }
  });

  resetForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors();
    const emailInput = document.getElementById("rs-email");
    const email = emailInput.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      resetError.textContent = "Enter a valid email address.";
      emailInput.setAttribute("aria-invalid", "true");
      return;
    }
    const sb = getSupabaseClient();
    if (!sb) {
      resetError.textContent = "Connection lost. Check your internet connection and try again.";
      return;
    }
    const btn = document.getElementById("reset-submit-btn");
    btn.setAttribute("aria-busy", "true");
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/game/`
    });
    btn.removeAttribute("aria-busy");
    if (error) {
      resetError.textContent = friendlyAuthError(error);
      return;
    }
    titleEl.textContent = "Check your inbox";
    messageText.textContent = `If an account exists for ${email}, we sent a link to choose a new password.`;
    showMode("message");
  });

  recoveryForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors();
    const pwInput = document.getElementById("rc-password");
    const password = pwInput.value;
    if (password.length < 8) {
      recoveryError.textContent = "Use a password with at least 8 characters.";
      pwInput.setAttribute("aria-invalid", "true");
      return;
    }
    const sb = getSupabaseClient();
    if (!sb) return;
    const btn = document.getElementById("recovery-submit-btn");
    btn.setAttribute("aria-busy", "true");
    const { data, error } = await sb.auth.updateUser({ password });
    btn.removeAttribute("aria-busy");
    if (error) {
      recoveryError.textContent = friendlyAuthError(error);
      return;
    }
    recoveryForm.reset();
    close();
    if (data?.user && typeof onSignedIn === "function") {
      await onSignedIn(data.user);
      showToast("Password updated.");
    }
  });

  return { open, close };
}
