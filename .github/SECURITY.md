# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for a security vulnerability.

Use GitHub's private reporting for this repository — **Security → Report a
vulnerability** (or go directly to the
[Advisories tab](https://github.com/Piekario/teamspeak3-music/security/advisories/new)). This
opens a private channel with the maintainers and lets us coordinate a fix and a disclosure
timeline before anything is public.

You should get an initial response within a few days. We'll keep you updated as the issue is
triaged and fixed, and credit you in the advisory unless you'd rather stay anonymous.

## Scope

Things that are in scope and worth a private report:

- Authentication/authorization bypass in the panel or API (the `ADMIN_TOKEN` / role model
  described in the README's **Panel access** section)
- Ways to reach another instance's bots, playlists, or history from a token scoped to one bot
- Injection issues around chat command parsing, the yt-dlp/ffmpeg invocation, or the gateway's
  WebSocket/TCP protocol
- Anything that leaks a token, session cookie, or `ADMIN_TOKEN`

Things that are generally **not** security issues here, and can go in a normal issue instead:
YouTube/yt-dlp extraction breakage, TeamSpeak connectivity problems, or Docker/Compose setup
questions.

## Supported versions

This project doesn't yet maintain multiple release branches — security fixes land on `main`
and are picked up by the `latest` image on the next publish. If you depend on a pinned image
tag or commit, re-pin after a fix ships.
