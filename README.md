# Scratch Colab

A Chrome extension that lets several people build one Scratch project together, live, without
sharing it on Scratch. Changes sync through your Firebase Realtime Database.

It uses the same side panel look as Scratchity, and puts teammates' blocks into the editor the
same way Scratchity adds blocks: through Scratch's own code area, like pasting or the backpack.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension` folder.
3. Pin Scratch Colab and click its icon to open the side panel.

It points at `https://colab-e77ed-default-rtdb.firebaseio.com` out of the box. To use another
database, open settings (the gear) in the side panel. Everyone in a colab needs the same address.

## Firebase rules

In the Firebase console, open Realtime Database, then Rules, and paste `firebase-rules.json`.
Anyone who knows a colab code can read and change that colab, so treat codes like passwords.

## Using it

**Start:** open a project in the editor (See inside), open the side panel, press **Start a colab**,
and send the code to your teammates.

**Join:** on Scratch click **Create** first (joining replaces the project in that tab, so don't do
it on one of your own projects), paste the code, and press **Join**.

What syncs live, in a second or two:
- Scripts: adding, changing, moving, deleting.
- Variables, lists and broadcast messages.
- Sprites: new sprites, deleted sprites, and costume or sound changes (the whole sprite is resent).

What doesn't sync live: backdrops, comments, and sprite renames show up as a new sprite.
Press **Send my version to everyone** to push your whole project to everyone. Use it any time
something looks different on someone's screen.

If two people edit the same script at the same moment, the last change wins.

The project is never shared on Scratch. When you're done, anyone can use File → Save to your
computer, or save it to their own account.

## Scratchity [BOT]

Scratchity can join a colab as a bot. With both extensions installed, open the colab and press
**Invite** on the Scratchity card, then ask Scratchity for something in its own side panel. The
blocks it adds go into your project and show up for everyone as **Scratchity [BOT]**, with your
name next to it. Scratchity also appears in the people list while it's invited, and for 10
minutes after it adds anything, even if nobody invited it.

While a colab is live, Scratch Colab marks the page with `<html data-scratch-colab="live">`.
Scratchity uses that to know you're in a colab: there it needs to be unlocked with BananaCoins.

Scratch Colab spots Scratchity's changes by its `scratchityInsert` function, so Scratchity needs
no changes. A future Scratchity can also say so directly by posting
`{ source: "scratchity", type: "bot-start" }` and `{ source: "scratchity", type: "bot-end" }`
with `window.postMessage` around adding blocks.

## How it works

- `page.js` runs inside the Scratch page. It finds the editor, watches for changes script by
  script, and puts teammates' changes in.
- `content.js` keeps the room in Firebase over its REST and streaming API.
- `sidepanel.html` / `panel.js` / `panel.css` are the side panel.

Firebase layout, under `rooms/<code>`:
- `files/<rev>/<n>`: the whole project (.sb3, base64, in chunks)
- `live/meta`, `live/people`, `live/scripts`, `live/vars`, `live/sprites`: live changes
- `spritefiles/<sprite>`: sprite files for costume and sound changes

## Things to watch when testing

- Not tested against live scratch.mit.edu or real Firebase yet. If something fails, the side panel
  shows the error; send it over along with anything in the Scratch tab's console.
- Sprites over about 7 MB are too big to send live; use Send my version to everyone.
