# Security

## Reporting a problem

Please don't open a public issue for a security problem. Report it privately through GitHub instead: on this repository, open **Security → Report a vulnerability**. Include what you found, how to reproduce it, and what someone could do with it. You'll get a reply as soon as possible, and credit in the release notes if you'd like it.

## What's covered

Resonant runs on your own computer. These matter most:

- Anything that lets a website, another program, or another person on the network use Resonant, read its history or settings, or run code through it.
- Anything that exposes an API key or token Resonant stores (the ElevenLabs key, the access key, the GPU worker token).
- Problems in the desktop app, the browser extension, or the MCP server.

## How Resonant protects you

- The server listens only on this computer unless you set `HOST`; set `RESONANT_API_KEY` before exposing it to a network.
- Web pages you visit can't drive it: requests for another host name are refused (DNS rebinding), and changes from other sites' pages are refused (cross-site requests).
- Keys stay on your computer. Settings shows only the last four characters of an ElevenLabs key, and no key is ever written to a log.
- The local Python worker gets a new random token every time it starts.
- The desktop app shows only Resonant's own pages, grants nothing but microphone access, and is built with Electron's security fuses (no `NODE_OPTIONS` or debugger injection, and a checked app archive).

See the Security section of the [README](README.md#security) for details.
