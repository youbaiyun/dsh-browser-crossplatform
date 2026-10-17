# Privacy policy

**dsh Browser Extension** — a browser extension for Chrome and Firefox.

Last updated: 2026-10-16

## Summary

This extension does not collect anything. It has no server of its own, no
analytics, and no telemetry. It talks to the dsh desktop application running on
your own computer over a loopback connection, and — only when you turn on image
recognition and ask about an image — it reaches that image's own address, or the
recognition endpoint this deployment configured. All of it is described below.

## What the extension sends, and where

**It sends page content to the desktop app you are running.** That is its
purpose. When you ask the assistant to read or operate a page, the extension
extracts text from that page and hands it to the dsh application over
`127.0.0.1`. The dsh application then sends it to whichever AI model you have
configured there. **This extension does not choose that model and cannot see the
result of that decision.** What happens to the text after the desktop app
receives it is governed by the desktop app and by your model provider's terms,
not by this extension.

**No page content is sent anywhere else.** The extension's content security policy
allows the loopback connection to the desktop app, plus `https:` and `http:`, which
cover **two** image-recognition operations — and recognition is off by default:

1. **Fetching the image you asked about.** The extension requests that image's own
   address from the page you are reading — carrying your cookies, so an image behind
   a login is readable — and hands the bytes to the desktop app over loopback.
2. **Calling a recognition endpoint directly.** If this deployment configured the
   extension with its own endpoint, model and key (they live in extension storage;
   the settings panel deliberately offers no field for them), the extension POSTs
   the image to that endpoint itself instead of relaying through the desktop. That
   address is whatever the deployment set, and the configured key is sent with the
   request. When no such endpoint is configured, this path is never taken.

Nothing is sent to any server belonging to the author of this
extension.

**It also receives, without sending.** The 「对话发到」 setting defaults to
`workspace`, which mirrors your desktop app's browser workspace into the side panel: the
desktop streams the events of the conversations in that workspace — their prompts,
answers and tool steps — to the extension over the same loopback socket, so the panel can
show what the desktop is doing. The extension does not request that content beyond asking
which conversations to follow, does not store the transcript (it is rendering state, not
persisted data), and cannot read a conversation outside the workspace the desktop names.
Choosing `fresh` or `pinned` in that setting stops the mirroring for everything except
the one conversation the panel is bound to. Note this is separate from *page* content:
the mirror is your own conversation text, and it never leaves the loopback connection.

## What is stored locally

The extension stores the following in your browser's extension storage, on your
machine only:

- The address and, where required, the token used to reach the desktop app, and —
  if this deployment configured direct image recognition — that endpoint, model and
  key.
- Your preferences: what page content may be shared and when, how tab switching
  is handled, and whether this panel should open automatically. (Whether the model
  may open pages on its own is a setting of the desktop application, not of the
  extension.)
- The description produced for each image you asked about, keyed by that image's
  address, so asking twice does not fetch or describe it twice. It holds
  descriptions, not the images themselves. This memo is kept in extension storage
  for up to 24 hours (it survives the background worker being restarted, which is
  why it is not memory-only), and it keeps at most the 200 most recently described
  images.

This data stays on your machine, with one exception that is part of its purpose: the
bridge token is sent to the desktop app on your own computer over loopback, and a
deployment configured for direct recognition sends its API key to the endpoint that
deployment chose. Removing the extension removes all of it.

## What is never sent

- **Passwords and payment-card values.** Fields the page marks as sensitive are
  replaced with a placeholder before the snapshot leaves the page. They are not
  transmitted, in readable or encoded form.
- **Screenshots.** The extension never captures one.
- **Images other than the one you asked about.** Image recognition is off by default,
  and when it is on the extension fetches only the image that was asked about.
- **Browsing history.** It reads the page you are on when you ask it to, and does
  not record where you have been.
- **Anything about you.** No name, no email, no account identifier, no
  advertising identifier, no telemetry, no crash reports.

## Page content is treated as untrusted

Text taken from a web page may contain sentences written to look like
instructions from you. The extension labels what you type in its panel with a
marker, and page text without it, so the model can tell the two apart. This is a
structural measure, not a filter: it does not depend on the page's content being
recognisable as an attack.

## Third parties

None. This extension has no third-party analytics, no advertising, and no
external services. It bundles two open-source libraries for rendering text in the
panel — Marked and DOMPurify — which run locally and send nothing.

## Children

This extension is a developer tool and is not directed at children. It collects
no personal information from anyone, including children.

## Your control

- Removing the extension deletes everything it has stored.
- Revoking the desktop app's connection (quitting dsh) stops all transfer.
- **Page sharing has two settings, and neither of them stops page content reaching
  the model.** The panel's 「AI 读取权限」 chooses between 「每次询问」 (ask before
  reading the page and before acting on it) and 「直接读取」 (ask neither time). Both
  send the page text to the model — that is what the tool is for. An earlier release
  offered a third choice, "Never", which claimed to keep page content in the browser;
  it has been **removed**, because it did not do that: while the shipped-on
  「不再询问，直接操作」 switch was on, the read policy was overridden to `auto` and
  "Never" had no effect. A control that promises a guarantee it does not deliver is
  worse than no control, so it is gone rather than left in place. Anyone who had
  selected it is moved to 「每次询问」, the stricter of the two.
- **What does still hold**, and is the real limit: the 「不再询问，直接操作」 switch
  overrides the read policy while it is on, so turn it off if you want the panel's
  choice to govern. The two settings are not independent, and the panel does not say
  so — this document is where that is written down.

## Changes

Any change to this policy will be a new revision in this file's history, with the
date above updated.

## Contact

Open an issue on the project's repository.
