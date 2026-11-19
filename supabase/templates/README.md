# Auth email templates

Supabase Auth email templates live in the dashboard, not in the migrations. These files are
the source: paste them into Auth → Email Templates in the members project.

- `confirm-signup.html`: template "Confirm signup". Subject: `Welcome to KTH Poker Society: your verification code`.
  Uses `{{ .Token }}` (the code the sign-up form asks for) and `{{ .ConfirmationURL }}` (one-click fallback).

Inline styles and tables only (email clients ignore most CSS); no external images or fonts.
